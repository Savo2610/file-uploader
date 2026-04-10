# Text Input Feature

## Idee
Zusätzlich zum Datei-Upload soll ein Textfeld hinzugefügt werden, in das Nutzer Text oder Links einfügen können. Dieser Inhalt wird dann wie eine Datei behandelt und ebenfalls hochgeladen.

## Beispiel (Python)
```python
import io

def text_to_file(text: str, filename: str = "input.txt"):
    return io.BytesIO(text.encode("utf-8")), filename
```

## Nutzung
- Textfeld im Frontend hinzufügen (textarea)
- Inhalt an Backend senden
- Backend wandelt Text in Datei um
- Bestehene Upload-Logik wiederverwenden

## HTML Beispiel
```html
<textarea id="textInput" placeholder="Text oder Links hier einfügen..."></textarea>
<button onclick="uploadText()">Upload Text</button>
```

## JS Beispiel
```javascript
function uploadText() {
  const text = document.getElementById('textInput').value;
  fetch('/upload-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}
```

## Fazit
Minimaler Eingriff: Du nutzt deine bestehende Upload-Logik weiter und ergänzt nur eine Konvertierung von Text → Datei.
