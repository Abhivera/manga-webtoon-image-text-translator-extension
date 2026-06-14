@echo off
setlocal
set MIT_ROOT=%~dp0..\..\manga-image-translator-main
if not exist "%MIT_ROOT%\server\main.py" (
  echo manga-image-translator not found at: %MIT_ROOT%
  echo Clone or place manga-image-translator-main next to this extension folder.
  pause
  exit /b 1
)
cd /d "%MIT_ROOT%\server"
echo Starting Manga Image Translator API at http://localhost:5003
python main.py --verbose --start-instance --host=0.0.0.0 --port=5003 --use-gpu
pause
