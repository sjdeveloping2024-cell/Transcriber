@echo off
setlocal
cd /d "%~dp0"

python -c "import faster_whisper, sounddevice" >nul 2>&1
if errorlevel 1 (
    echo Installing Faster-Whisper dependencies...
    python -m pip install -r requirements-whisper.txt
    if errorlevel 1 (
        echo.
        echo Could not install the Faster-Whisper dependencies.
        pause
        exit /b 1
    )
)

echo.
echo Starting the terminal transcriber.
echo The first run downloads the base.en model.
echo Press Ctrl+C to stop.
echo.

python backend\whisper_transcriber.py
if errorlevel 1 pause
endlocal
