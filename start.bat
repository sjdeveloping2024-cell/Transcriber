@echo off
setlocal
cd /d "%~dp0"

python -c "import flask, vosk" >nul 2>&1
if errorlevel 1 (
    echo Installing the Python requirements...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo Could not install the requirements. Check that Python and pip are available.
        pause
        exit /b 1
    )
)

if not exist "backend\models\vosk-model-small-en-us-0.15" (
    echo.
    echo Warning: the on-device speech model is missing.
    echo Brave and Firefox will not be able to transcribe.
    echo.
)

python backend\Transcriber.py
if errorlevel 1 pause
endlocal
