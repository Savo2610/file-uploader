# OpenYards Monitor

Lokales Dashboard, das die lesenden API-Endpunkte von openyards.org regelmäßig abfragt und übersichtlich anzeigt.

```bash
python3 server.py            # dann http://127.0.0.1:8765 öffnen
python3 server.py --fast 5 --slow 60 --port 8765
```

- Anmeldung im Dashboard (oder per `OY_USER` / `OY_PASS`); Zugangsdaten bleiben nur im Speicher, Token-Refresh läuft automatisch.
- Spiel und Profil wählen, "Überwachen" startet das Polling.
- Schnell (Standard 5 s): Kartenpositionen, Events, letzte Position. Langsam (60 s): Rest. Minimum 5 s.
- Pro Endpunkt: Status, Latenz, Alter, letzte Änderung (Karte blinkt bei neuen Daten), Tabelle + Roh-JSON. Unten ein Request-Log.
- Es werden nur GET-Endpunkte abgefragt, nie schreibende Aktionen (`set_option`, `hand_over_catchcode`, `set_messages` …).
- Server bindet nur an 127.0.0.1.
