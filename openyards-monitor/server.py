#!/usr/bin/env python3
"""Lokales Monitoring-Dashboard fuer die openyards.org-API.

Nur Python-Standardbibliothek. Pollt ausschliesslich lesende GET-Endpunkte
(nie set_option, hand_over_catchcode, set_messages ...) im selben Takt wie die
Web-App und zeigt die Ergebnisse unter http://127.0.0.1:8765 an.

Zugangsdaten: Formular im Dashboard oder Umgebungsvariablen OY_USER / OY_PASS.
Sie werden nur im Arbeitsspeicher gehalten.
"""
import argparse
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

API = "https://oybackend-prod-1079304395897.europe-west3.run.app/api/"
HERE = Path(__file__).parent

# name -> (Pfad-Template, Gruppe). {id} = Profil-ID. Gruppe bestimmt das Intervall.
ENDPOINTS = {
    "map_positions":      ("gamecore/{id}/map_positions/", "fast"),
    "game_events":        ("gamecore/{id}/get_game_events/", "fast"),
    "last_position":      ("movement/{id}/get_last_positionlog/", "fast"),
    "game_info":          ("gamecore/{id}/get_game_info_for_gl/", "slow"),
    "messages":           ("messaging/{id}/get_messages/", "slow"),
    "move_options":       ("movement/{id}/get_options/", "slow"),
    "mrx_views":          ("catching/{id}/get_mrx_views/", "slow"),
    "mrx_live_views":     ("catching/{id}/get_mrx_live_views/", "slow"),
    "mrx_next_update":    ("catching/{id}/get_mrx_next_views_update_date/", "slow"),
    "catchable_mrx":      ("catching/{id}/get_catchable_mrx/", "slow"),
    "group_evaluations":  ("evaluation/{id}/get_player_group_evaluations/", "slow"),
    "logs":               ("evaluation/{id}/get_logs/", "slow"),
}

lock = threading.RLock()


class State:
    def __init__(self):
        self.access = None
        self.refresh = None
        self.username = None
        self.selection = None          # {"gameId":..,"profileId":..}
        self.endpoints = {}            # name -> dict
        self.log = []                  # letzte Requests
        self.generation = 0            # Poller-Generation (Abbruch bei Wechsel)
        self.intervals = {"fast": 5, "slow": 60}


S = State()


def http(method, path, body=None, params=None, auth=True):
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    if auth and S.access:
        req.add_header("Authorization", "Bearer " + S.access)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    except Exception as e:  # Netzwerkfehler
        return 0, {"error": str(e)}, int((time.time() - t0) * 1000)
    ms = int((time.time() - t0) * 1000)
    try:
        payload = json.loads(raw) if raw else None
    except ValueError:
        payload = {"raw": raw[:500].decode("utf-8", "replace")}
    return status, payload, ms


def call(path, params=None):
    """GET mit automatischem Token-Refresh bei 401."""
    status, payload, ms = http("GET", path, params=params)
    if status == 401 and S.refresh:
        with lock:
            st, tok, _ = http("POST", "token/refresh/", {"refresh": S.refresh}, auth=False)
            if st == 200 and isinstance(tok, dict) and tok.get("access"):
                S.access = tok["access"]
                S.refresh = tok.get("refresh", S.refresh)
        status, payload, ms = http("GET", path, params=params)
    return status, payload, ms


def login(username, password):
    st, tok, _ = http("POST", "token/", {"username": username, "password": password}, auth=False)
    if st != 200 or not isinstance(tok, dict) or "access" not in tok:
        return False, tok
    S.access, S.refresh, S.username = tok["access"], tok.get("refresh"), username
    return True, None


def record(name, path, status, payload, ms):
    now = time.time()
    with lock:
        ep = S.endpoints.setdefault(name, {"changed": now})
        if status == 200 and payload != ep.get("data"):
            ep["changed"] = now
            ep["data"] = payload
        ep.update(status=status, ms=ms, ts=now, path=path,
                  error=None if status == 200 else payload)
        ep["calls"] = ep.get("calls", 0) + 1
        S.log.insert(0, {"ts": now, "name": name, "path": path, "status": status, "ms": ms})
        del S.log[200:]


def poll_loop(name, template, group, generation, profile_id):
    path = template.format(id=profile_id)
    events, since = {}, None
    while True:
        with lock:
            if generation != S.generation:
                return
            interval = S.intervals[group]
        params = None
        if name == "game_events" and since:
            params = {"since": since}
        status, payload, ms = call(path, params)
        if name == "game_events" and status == 200 and isinstance(payload, list):
            for e in payload:                       # wie die Web-App: per ID mergen
                if isinstance(e, dict) and "id" in e:
                    events[e["id"]] = e
            merged = sorted(events.values(), key=lambda e: str(e.get("time", "")), reverse=True)
            since = merged[0].get("time") if merged else since
            payload = merged
        record(name, path + (("?" + urllib.parse.urlencode(params)) if params else ""),
               status, payload, ms)
        time.sleep(interval)


def start_polling(game_id, profile_id):
    with lock:
        S.generation += 1
        gen = S.generation
        S.selection = {"gameId": game_id, "profileId": profile_id}
        S.endpoints.clear()
        S.log.clear()
    for name, (template, group) in ENDPOINTS.items():
        threading.Thread(target=poll_loop, args=(name, template, group, gen, profile_id),
                         daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == "/":
            body = (HERE / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/api/state":
            with lock:
                self.send_json({"user": S.username, "selection": S.selection,
                                "intervals": S.intervals, "now": time.time(),
                                "endpoints": S.endpoints, "log": S.log[:80]})
        elif u.path == "/api/games":
            st, p, _ = call("games/")
            self.send_json(p, 200 if st == 200 else 502)
        elif u.path == "/api/profiles":
            st, p, _ = call("profiles/", {"gameId": q.get("gameId", "")})
            self.send_json(p, 200 if st == 200 else 502)
        else:
            self.send_error(404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        d = self.read_json()
        if u.path == "/api/login":
            ok, err = login(d.get("username", ""), d.get("password", ""))
            self.send_json({"ok": ok, "error": err}, 200 if ok else 401)
        elif u.path == "/api/select":
            start_polling(d["gameId"], d["profileId"])
            self.send_json({"ok": True})
        elif u.path == "/api/intervals":
            with lock:
                for k in ("fast", "slow"):
                    if k in d:
                        S.intervals[k] = max(5, int(d[k]))   # nie schneller als 5 s
            self.send_json({"ok": True, "intervals": S.intervals})
        elif u.path == "/api/stop":
            with lock:
                S.generation += 1
                S.selection = None
            self.send_json({"ok": True})
        else:
            self.send_error(404)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--fast", type=int, default=5, help="Sekunden (min. 5) fuer Karte/Events")
    ap.add_argument("--slow", type=int, default=60, help="Sekunden (min. 5) fuer den Rest")
    a = ap.parse_args()
    S.intervals = {"fast": max(5, a.fast), "slow": max(5, a.slow)}
    if os.environ.get("OY_USER") and os.environ.get("OY_PASS"):
        ok, _ = login(os.environ["OY_USER"], os.environ["OY_PASS"])
        print("Login mit OY_USER:", "ok" if ok else "FEHLGESCHLAGEN")
    print(f"Dashboard: http://127.0.0.1:{a.port}")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
