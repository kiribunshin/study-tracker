@echo off
setlocal
cd /d "%~dp0"
title Cultivar

echo.
echo ===========================================================
echo    Cultivar v2.3.3
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

:: pywebview powers the actual desktop window, so a failed/silent
:: install here (the old "-q" swallowed all output) meant the app would
:: only fail much later with a confusing error, or not fail visibly at
:: all -- leaving it looking "missing" even though this block ran.
python -c "import webview" >nul 2>&1
if errorlevel 1 (
    echo [..] Installing pywebview - this powers the desktop window...
    python -m pip install pywebview
    python -c "import webview" >nul 2>&1
    if errorlevel 1 (
        echo.
        echo [X] Could not install pywebview automatically.
        echo Please run manually:  python -m pip install pywebview
        echo.
        echo Cultivar also needs the Microsoft Edge WebView2 Runtime,
        echo which ships with Windows 10/11 by default. If this PC is
        echo missing it, get it from:
        echo https://developer.microsoft.com/microsoft-edge/webview2/
        pause
        exit /b 1
    )
)

:: NOTE: the pip package is "pillow" but the importable module is "PIL" --
:: checking "import pillow" (the old check) always fails regardless of
:: whether Pillow is installed, silently re-running this install every
:: single launch.
python -c "import PIL" >nul 2>&1
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
