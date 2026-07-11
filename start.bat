@echo off
setlocal
cd /d "%~dp0"

title StudyTracker v2.0

echo.
echo ================================================
echo    StudyTracker v2.0
echo    Study Tracking Dashboard
echo    Live to love. Love to learn. Learn to live.
echo ================================================
echo.

:: -- Check Python --
python --version >nul 2>&1
if errorlevel 1 (
    echo [X] Python not found!
    echo.
    echo Please install Python 3.10+ from:
    echo https://www.python.org/downloads/
    echo IMPORTANT: Check "Add Python to PATH" during install.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo [OK] %PYVER% detected

:: -- Check pip --
python -m pip --version >nul 2>&1
if errorlevel 1 (
    echo [X] pip not found! Reinstall Python with pip enabled.
    pause
    exit /b 1
)

:: -- Install dependencies --
echo.
echo [..] Checking dependencies...

python -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo [-^>] Installing Flask...
    python -m pip install flask flask-cors
    if errorlevel 1 (
        echo [X] Failed to install Flask.
        pause
        exit /b 1
    )
)

python -c "import sklearn" >nul 2>&1
if errorlevel 1 (
    echo [-^>] Installing scikit-learn ^(for ML recommendations^)...
    python -m pip install scikit-learn numpy
    if errorlevel 1 (
        echo [X] Failed to install scikit-learn.
        pause
        exit /b 1
    )
)

python -c "import seaborn" >nul 2>&1
if errorlevel 1 (
    echo [-^>] Installing matplotlib and seaborn ^(for charts and PDF reports^)...
    python -m pip install matplotlib seaborn
    if errorlevel 1 (
        echo [X] Failed to install matplotlib/seaborn.
        pause
        exit /b 1
    )
)

echo [OK] All dependencies ready.
echo.

:: -- Launch server --
echo [OK] Starting StudyTracker server...
echo [OK] URL:     http://localhost:8080
echo.
echo ----------------------------------------
echo Press Ctrl+C in this window to stop.
echo ----------------------------------------
echo.

:: Launch browser only after the server is actually responding
start /B "" powershell -NoProfile -Command "$deadline = (Get-Date).AddSeconds(15); while ((Get-Date) -lt $deadline) { try { $response = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/ -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process http://localhost:8080; exit 0 } } catch { Start-Sleep -Milliseconds 500 } }"

:: Run server (this blocks until Ctrl+C)
python server.py

echo.
echo Server stopped.
echo Press any key to close this window...
pause >nul