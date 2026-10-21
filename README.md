# Lilt — voice to text

A small local transcription desk. Press record, speak into your microphone, and watch an editable transcript appear in real time.

No build step, no accounts, and no audio is saved by the app.

## Run it

Lilt has two separate ways to transcribe. They can both be used, but not at the same time on the same microphone.

### Web app (Lilt UI)

From `C:\Transcriber`:

```powershell
python -m pip install Flask vosk
python backend\Transcriber.py
```

The app opens automatically at [http://127.0.0.1:5000](http://127.0.0.1:5000). Allow microphone access when your browser asks.

### Terminal transcriber (Faster-Whisper)

```powershell
python -m pip install -r requirements-whisper.txt
python backend\whisper_transcriber.py
```

Or double-click `start-whisper.bat`. This version listens from the terminal and prints each finished sentence; it does not use the web page. The first run downloads the `base.en` model (about 150 MB).

To use a different port:

```powershell
python backend\Transcriber.py --port 5001
```

To start the server without opening a browser:

```powershell
python backend\Transcriber.py --no-browser
```

## Using it

- Press the round record button to start.
- Press it again to stop and finish the transcript.
- Record again to add another section to the same note.
- Edit the transcript directly once recording has stopped.
- Copy, download the transcript as a `.txt` file, or clear it.
- Choose the spoken language from the menu in the top-right corner. The on-device engine currently supports English; Chrome and Edge support the full list.

## Browser support

Lilt picks a transcription engine automatically:

- **Chrome and Edge** use the browser's Web Speech API for live transcription. This may need an internet connection and supports every language in the menu.
- **Brave, Firefox, and other browsers** use the included on-device model. This works offline, streams live partial words, and currently supports English only.

If Chrome's speech service is blocked by the network or by privacy settings, Lilt switches the current take to the on-device engine automatically, as long as an English language is selected.

The page must be opened through localhost (not a plain `file://` page) for reliable microphone access.

Your transcript is stored in this browser's local storage. The app never saves audio to disk. In on-device mode, short audio chunks are sent only to the local Lilt server for transcription and are discarded immediately.

## On-device model

The English model is included in `backend/models/vosk-model-small-en-us-0.15` (about 65 MB) so the local engine works without a download. The first take loads it once and can take a second longer; later takes start immediately. On-device transcription uses [Vosk](https://alphacephei.com/vosk/) and its small English model (Apache 2.0).

If the recorder says **On-device engine unavailable**, make sure that model folder exists and that `vosk` is installed (see **Web app** above), then restart the server and reload the page.

## Project structure

```text
transcriber/
├── backend/
│   ├── models/
│   │   └── vosk-model-small-en-us-0.15/
│   ├── Transcriber.py          # Flask web server and Vosk engine
│   └── whisper_transcriber.py  # Standalone Faster-Whisper terminal tool
├── frontend/
│   ├── app.js                  # Recording, speech recognition, UI state
│   ├── fonts/
│   ├── index.html
│   └── styles.css
├── requirements-whisper.txt
└── start-whisper.bat
```
