@echo off
title GLM-OCR Local Server
echo ============================================
echo   GLM-OCR Local Server for Image Translator
echo ============================================
echo.

REM Check if Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    echo Install Python 3.10+ from https://python.org
    pause
    exit /b 1
)

REM Install dependencies if needed
echo [1/2] Checking dependencies...
pip install -r "%~dp0requirements.txt" -q
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo [2/2] Starting GLM-OCR server on http://localhost:8080 ...
echo         First run will download the model (~2GB). Please wait.
echo         Press Ctrl+C to stop.
echo.

python "%~dp0app.py"
pause
