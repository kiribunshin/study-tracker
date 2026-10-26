#!/usr/bin/env bash
# Cultivar - Linux launcher (mirrors start.bat's checks/behavior).
#
# Short answer to "will this even work on Linux": yes - server.py and
# desktop.py are already fully cross-platform (every Windows-only bit,
# taskbar icon handling, console hiding, .ico generation, is already
# guarded by `sys.platform.startswith("win")` checks and simply no-ops
# elsewhere). The one thing Windows gets for free that Linux doesn't is
# a built-in browser engine: Windows uses the system's WebView2 (Edge)
# runtime automatically, but pywebview on Linux needs an actual GUI
# toolkit installed for it to render into - either Qt (QtWebEngine) or
# GTK (WebKit2GTK). This script installs Qt automatically via pip since
# that works the same on every distro; GTK is lighter if you'd rather
# have it, but it isn't reliably pip-installable, so that path is left
# as a suggested manual command instead (see below).
set -u
cd "$(dirname "$0")"

echo ""
echo "==========================================================="
echo "   Cultivar v3.0.0"
echo "   Live to love. Love to learn. Learn to live."
echo "   The Desktop Update: No need for a browser anymore!"
echo "==========================================================="
echo ""

# -- Check Python --
PY=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
    echo "[X] Python not found!"
    echo "Install Python 3.10+ via your distro's package manager, e.g.:"
    echo "  Debian/Ubuntu: sudo apt install python3 python3-pip"
    echo "  Fedora:        sudo dnf install python3 python3-pip"
    echo "  Arch:          sudo pacman -S python python-pip"
    read -r -p "Press Enter to exit..." _
    exit 1
fi

# pip on newer distros (Debian/Ubuntu 23.04+, Fedora 39+...) refuses a
# plain `pip install` outside a venv ("externally-managed-environment").
# Try the normal --user install first; only fall back to
# --break-system-packages (still user-scoped, never touches system
# Python itself) if that specific error is what's actually blocking it.
pip_install() {
    local err
    err="$("$PY" -m pip install --user -q "$@" 2>&1)"
    if [ $? -ne 0 ]; then
        if echo "$err" | grep -qi "externally-managed-environment"; then
            "$PY" -m pip install --user --break-system-packages -q "$@"
            return $?
        fi
        echo "$err" >&2
        return 1
    fi
    return 0
}

echo "[..] Checking dependencies..."
"$PY" -c "import flask" >/dev/null 2>&1 || pip_install flask
"$PY" -c "import sklearn" >/dev/null 2>&1 || pip_install scikit-learn numpy
"$PY" -c "import seaborn" >/dev/null 2>&1 || pip_install matplotlib seaborn
"$PY" -c "import PIL" >/dev/null 2>&1 || pip_install pillow
"$PY" -c "import yaml" >/dev/null 2>&1 || pip_install pyyaml

# pywebview itself (the Python package) - separate from the GUI
# backend it needs underneath, checked next.
"$PY" -c "import webview" >/dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[..] Installing pywebview - this powers the desktop window..."
    pip_install pywebview
    "$PY" -c "import webview" >/dev/null 2>&1
    if [ $? -ne 0 ]; then
        echo ""
        echo "[X] Could not install pywebview automatically."
        echo "Please run manually:  $PY -m pip install --user pywebview"
        read -r -p "Press Enter to exit..." _
        exit 1
    fi
fi

# GUI backend check - pywebview can be installed and still have nothing
# to actually render a window with. Qt is auto-installed here since it
# works via pip on any distro; GTK/WebKit2 is lighter but needs your
# distro's own package manager, so it's offered as a manual alternative
# instead of attempted automatically.
HAS_QT="$("$PY" -c "
import importlib.util
print(1 if (importlib.util.find_spec('PyQt5') or importlib.util.find_spec('PySide6') or importlib.util.find_spec('PySide2')) else 0)
" 2>/dev/null)"
HAS_GTK="$("$PY" -c "
import gi
ok = False
for v in ('4.1', '4.0'):
    try:
        gi.require_version('WebKit2', v)
        from gi.repository import WebKit2
        ok = True
        break
    except Exception:
        pass
print(1 if ok else 0)
" 2>/dev/null)"

if [ "$HAS_QT" != "1" ] && [ "$HAS_GTK" != "1" ]; then
    echo "[..] No webview GUI backend detected yet - installing Qt (PyQtWebEngine)..."
    pip_install PyQt5 PyQtWebEngine
    HAS_QT="$("$PY" -c "
import importlib.util
print(1 if importlib.util.find_spec('PyQt5') else 0)
" 2>/dev/null)"
    if [ "$HAS_QT" != "1" ]; then
        echo ""
        echo "[X] Could not set up a webview backend automatically."
        echo "    Pick ONE of the following, then re-run this script:"
        echo ""
        echo "    Qt (works via pip, no root needed):"
        echo "      $PY -m pip install --user PyQt5 PyQtWebEngine"
        echo ""
        echo "    GTK/WebKit (lighter, needs your package manager):"
        echo "      Debian/Ubuntu: sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1"
        echo "      Fedora:        sudo dnf install python3-gobject gtk3 webkit2gtk4.1"
        echo "      Arch:          sudo pacman -S python-gobject gtk3 webkit2gtk"
        echo ""
        read -r -p "Press Enter to exit..." _
        exit 1
    fi
fi

echo "[..] Opening Cultivar..."
LOG_FILE="$(dirname "$0")/cultivar.log"
nohup "$PY" "$(dirname "$0")/desktop.py" >"$LOG_FILE" 2>&1 &
disown 2>/dev/null

echo "Done! (Logs, if anything goes wrong, land in cultivar.log next to this script.)"
sleep 2
exit 0
