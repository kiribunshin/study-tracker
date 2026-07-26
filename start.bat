@echo off
setlocal
cd /d "%~dp0"
title Cultivar

echo.
echo ===========================================================
echo    Cultivar v2.3.0
echo    Live to love. Love to learn. Learn to live.
echo    The Desktop Update: No need for a browser anymore!
echo ===========================================================
echo.

:: -- Check Python --
python --version >nul 2>&1
if errorlevel 1 (
    echo [X] Python not found!
    echo Please install Python 3.10+ from https://www.python.org/downloads/
    echo IMPORTANT: Check "Add Python to PATH" during install.
    pause
    exit /b 1
)

:: -- Install dependencies --
echo [..] Checking dependencies...
python -c "import flask" >nul 2>&1
if errorlevel 1 python -m pip install flask -q
python -c "import sklearn" >nul 2>&1
if errorlevel 1 python -m pip install scikit-learn numpy -q
python -c "import seaborn" >nul 2>&1
if errorlevel 1 python -m pip install matplotlib seaborn -q
python -c "import webview" >nul 2>&1
if errorlevel 1 python -m pip install pywebview -q
python -c "import pillow" >nul 2>&1
if errorlevel 1 python -m pip install pillow -q

:: -- Laucnh via pythonw so no cmd lingers --
where pythonw >nul 2>&1
if errorlevel 1 (
    set "PYW=python"
) else (
    set "PYW=pythonw"
)

echo [..] Opening Cultivar...
start "" "%PYW%" "%~dp0desktop.py"

echo Done! This window will close automatically...
timeout /t 2 >nul
exit /b 0
