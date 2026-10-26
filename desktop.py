#!/usr/bin/env python3
"""
Cultivar Desktop - runs the same Flask server as server.py, but
inside a native window (via pywebview) instead of a browser tab, and
purely LOCAL: the server only ever listens on 127.0.0.1, never on the
network. There's no phone access, no LAN sharing, no auth.
This app is meant to be used on one PC, by one person, full stop.

How it works:
  - The Flask app (server.py) starts on a background daemon thread,
    bound to 127.0.0.1 only.
  - pywebview opens a native OS window pointed at that local server,
    on Windows this uses the system's WebView2 (Edge) runtime, which
    ships with Windows 10/11 by default, so no bundled Chromium needed.
    On Linux, pywebview instead needs an actual GUI toolkit installed
    underneath it (Qt/QtWebEngine or GTK/WebKit2GTK) - see start.sh,
    which checks for one and installs Qt automatically if neither is
    present. Everything else in this file is already cross-platform;
    every Windows-only step below (taskbar icon, console hiding) is
    a no-op on Linux.
  - If Cultivar is already open (you double-clicked start.bat/start.sh
    twice, say), this just focuses/reopens a window against the
    EXISTING server instead of starting a second one.
  - Closing the window shuts everything down cleanly (the Flask thread
    is a daemon thread, so it dies the instant the process exits).

Running it directly (for testing):
    pip install pywebview
    python desktop.py
"""
import sys
import os
import threading
import time
import socket
from pathlib import Path

# When PyInstaller bundles this into a onefile .exe, bundled data files
# (index.html, app.js, sprites/, ...) are extracted at runtime into a
# temp folder pointed to by sys._MEIPASS - server.py's Path(__file__)-
# based lookups need to resolve against THAT folder, not the .exe's own
# location, or every static file / sprite would 404 once packaged.
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    BASE_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).parent

sys.path.insert(0, str(BASE_DIR))


def _set_app_user_model_id():
    """Tells Windows this process is its own distinct application rather
    than lumping it in with python.exe/pythonw.exe's default identity.
    This is the actual, well-known root cause of a Python GUI app
    showing the generic "python with a page" icon in the taskbar/
    Alt-Tab switcher even after the window's own icon (see
    _force_taskbar_icon below) has been explicitly set - Explorer keys
    the taskbar button's identity off the App User Model ID, and without
    one, every pythonw.exe-launched script defaults to sharing pythonw's
    own. Must run before any window is created. Never fatal; no-op on
    non-Windows."""
    if not sys.platform.startswith("win"):
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Cultivar.DesktopApp")
    except Exception:
        pass


def _hide_console_window():
    """If this process happens to have a visible console attached (e.g.
    someone ran `python desktop.py` directly instead of via pythonw, or
    double-clicked a .py file with python.exe as the default handler),
    hide that console window. Running via pythonw.exe (which start.bat
    uses) never attaches one in the first place, so this is purely a
    safety net for other ways of launching this script - never fatal,
    never affects non-Windows platforms."""
    if not sys.platform.startswith("win"):
        return
    try:
        import ctypes
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE
    except Exception:
        pass


def _port_is_free(port, host="127.0.0.1"):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _pick_port():
    """Prefers 8080 so it's predictable across runs, falls back to a
    free OS-assigned port if something else already has 8080."""
    if _port_is_free(8080):
        return 8080
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_until_up(port, timeout=15):
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=1)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def _detect_existing_server(port=8080):
    """Quick, one-shot check (not the patient retry loop _wait_until_up
    uses while a server is booting) for whether SOMETHING is already
    answering on this port - e.g. Cultivar is already open in
    another window. Returns True if found."""
    import urllib.request
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=1)
        return True
    except Exception:
        return False


def _force_taskbar_icon(icon_path, title="Cultivar", tries=60, delay=0.25):
    """pywebview's `icon=` kwarg (passed to webview.start()) sets the
    window's SMALL icon under Windows' WebView2/edgechromium backend - that's why the title bar already shows the correct icon. The
    TASKBAR reads the window's BIG icon instead, which pywebview doesn't
    reliably set, so Windows falls back to whatever icon is embedded in
    pythonw.exe itself (the "python with a page" icon). This explicitly
    pushes both icon sizes onto the native window via WM_SETICON, plus
    the window class icon (which is what the taskbar/Alt-Tab actually
    look at), fixing the taskbar without needing to touch pywebview.

    Runs in a background thread since webview.create_window() returns
    before the real native window exists yet - it just polls briefly for
    the window to show up by title, then applies the icon once and exits.
    Entirely non-fatal: any failure here just leaves the default icon in
    place, never crashes the app."""
    if not sys.platform.startswith("win") or not icon_path:
        return
    try:
        import ctypes
    except Exception:
        return

    def _worker():
        user32 = ctypes.windll.user32
        IMAGE_ICON = 1
        LR_LOADFROMFILE = 0x00000010
        LR_DEFAULTSIZE = 0x00000040
        WM_SETICON = 0x0080
        ICON_SMALL = 0
        ICON_BIG = 1
        GCL_HICON = -14

        hwnd = None
        for _ in range(tries):
            hwnd = user32.FindWindowW(None, title)
            if hwnd:
                break
            time.sleep(delay)
        if not hwnd:
            return
        try:
            hicon_big = user32.LoadImageW(None, str(icon_path), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE)
            hicon_small = user32.LoadImageW(None, str(icon_path), IMAGE_ICON, 16, 16, LR_LOADFROMFILE)
            if hicon_big:
                user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon_big)
                # The window CLASS icon is what the taskbar button and
                # Alt-Tab switcher actually read on most Windows
                # versions - WM_SETICON alone doesn't always take.
                set_class_long = getattr(user32, "SetClassLongPtrW", None) or getattr(user32, "SetClassLongW", None)
                if set_class_long:
                    try:
                        set_class_long(hwnd, GCL_HICON, hicon_big)
                    except Exception:
                        pass
            if hicon_small:
                user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hicon_small)
        except Exception:
            pass

    threading.Thread(target=_worker, daemon=True).start()


def _launch_window(port):
    """Opens the native pywebview window pointed at the local server. The
    page reports back (/api/boot_ok with a one-time token) once it has really
    rendered; if that never happens (blank/white window - missing WebView2 on
    Windows, broken GPU/Qt/GTK surface on Linux) the app opens in the default
    browser instead, so it is always usable."""
    try:
        import webview
    except ImportError:
        print("pywebview isn't installed. Run: pip install pywebview")
        while True:
            time.sleep(1)

    import json, uuid, webbrowser, urllib.request

    boot_token = uuid.uuid4().hex
    url = f"http://127.0.0.1:{port}/?boot={boot_token}"
    fallback = {"used": False}

    def _open_browser(reason):
        if fallback["used"]:
            return
        fallback["used"] = True
        print(f"Native window unavailable ({reason}) - opening in your browser: {url}")
        try:
            webbrowser.open(url)
        except Exception:
            pass

    def _keep_alive():
        while True:  # keep the server alive for the browser tab
            time.sleep(1)

    if os.environ.get("CULTIVAR_FORCE_BROWSER") == "1":
        _open_browser("forced by CULTIVAR_FORCE_BROWSER")
        _keep_alive()

    if sys.platform.startswith("linux"):
        # Blank/black webview surfaces on Linux are almost always GPU
        # compositing problems in QtWebEngine/WebKitGTK.
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --no-sandbox --disable-gpu-compositing")
        os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
        os.environ.setdefault("QT_QUICK_BACKEND", "software")
        os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
        os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

    window = webview.create_window(
        "Cultivar", url,
        width=1280, height=860, min_size=(900, 600),
        confirm_close=False, on_top=False, focus=True,
    )

    # Custom app icon (never fatal if anything here is missing).
    icon_path = None
    png_path = BASE_DIR / "sprites" / "gui" / "appicon.png"
    ico_path = BASE_DIR / "sprites" / "gui" / "appicon.ico"
    try:
        if sys.platform.startswith("win") and png_path.exists() and not ico_path.exists():
            try:
                from PIL import Image
                img = Image.open(png_path)
                img.save(ico_path, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
            except Exception:
                pass
        if sys.platform.startswith("win") and ico_path.exists():
            icon_path = str(ico_path)
        elif png_path.exists():
            icon_path = str(png_path)
    except Exception:
        icon_path = None
    if icon_path:
        _force_taskbar_icon(icon_path)

    def _boot_confirmed():
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/boot_status?token={boot_token}", timeout=2) as r:
                return bool(json.loads(r.read().decode("utf-8")).get("ok"))
        except Exception:
            return False

    def _watchdog():
        deadline = time.time() + 25
        while time.time() < deadline:
            if _boot_confirmed():
                return
            time.sleep(1)
        _open_browser("the window never finished loading")

    threading.Thread(target=_watchdog, daemon=True).start()

    start_kwargs = {"private_mode": False}
    if icon_path:
        start_kwargs["icon"] = icon_path
    if sys.platform.startswith("win"):
        # Fail loudly if WebView2 is missing instead of silently falling back
        # to the ancient IE engine, which shows a blank white window.
        start_kwargs["gui"] = "edgechromium"
    try:
        try:
            webview.start(**start_kwargs)
        except TypeError:
            start_kwargs.pop("gui", None)
            try:
                webview.start(**start_kwargs)
            except TypeError:
                webview.start()
    except Exception as e:
        _open_browser(str(e))
    if fallback["used"]:
        _keep_alive()


def main():
    _set_app_user_model_id()
    _hide_console_window()

    # If Cultivar is already open in another window on this PC,
    # don't start a second server (which would either fail to bind the
    # port or, worse, silently run as an orphaned duplicate process).
    # Just open another native window pointed at the one that's already
    # up.
    if _detect_existing_server(8080):
        print("Cultivar is already running - opening another window onto it.")
        _launch_window(8080)
        return

    import server as st_server  # the existing Flask app, untouched

    port = _pick_port()
    st_server.PORT = port

    def run_flask():
        # 127.0.0.1 ONLY - this app never listens on the network.
        st_server.app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False, threaded=True)

    t = threading.Thread(target=run_flask, daemon=True)
    t.start()

    if not _wait_until_up(port):
        print("Cultivar server did not start in time.")
        sys.exit(1)

    print(f"Cultivar v{st_server.APP_VERSION} running locally at http://127.0.0.1:{port}")

    _launch_window(port)


if __name__ == "__main__":
    main()
