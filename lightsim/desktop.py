"""Native desktop window: the UI in its own app window, no browser or terminal.

The engine + local server run on a background thread; the window (Edge
WebView2 on Windows, WebKit on macOS) talks to it exactly like the browser
did, so phones can still connect as remotes. Closing the window quits.
"""
from __future__ import annotations

import asyncio
import json
import logging
import socket
import threading
import urllib.request
from pathlib import Path

from aiohttp import web

from . import __version__

log = logging.getLogger("lightsim.desktop")


class ServerThread(threading.Thread):
    """Runs the aiohttp app on its own event loop (run_app needs the main thread)."""

    def __init__(self, app: web.Application, host: str, port: int):
        super().__init__(daemon=True, name="lightsim-server")
        self.app, self.host, self.port = app, host, port
        self.ready = threading.Event()
        self.error: Exception | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

    def run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        runner = web.AppRunner(self.app)
        try:
            self.loop.run_until_complete(runner.setup())
            self.loop.run_until_complete(web.TCPSite(runner, self.host, self.port).start())
        except Exception as e:
            self.error = e
            self.ready.set()
            return
        self.ready.set()
        try:
            self.loop.run_forever()
        finally:
            # saves the show, blacks out real lights, closes MIDI/DMX
            self.loop.run_until_complete(runner.cleanup())
            self.loop.close()

    def stop(self):
        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)
        self.join(timeout=5)


def running_instance(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=0.6) as r:
            return json.loads(r.read()).get("app") == "lightsim"
    except Exception:
        return False


def port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


class Api:
    """Functions the page can call as window.pywebview.api.* (native dialogs)."""

    def __init__(self, show):
        self._show = show
        self._window = None

    def export_show(self):
        import webview
        name = self._show.data.get("name", "show").replace(" ", "_") + ".lightshow.json"
        path = self._window.create_file_dialog(webview.FileDialog.SAVE, save_filename=name,
                                               file_types=("Show files (*.json)",))
        if not path:
            return None
        path = path if isinstance(path, str) else path[0]
        Path(path).write_text(json.dumps(self._show.export(), indent=1), "utf-8")
        return Path(path).name


def unblock_bundle():
    """Remove Windows' "downloaded from the internet" mark from our own files.

    Unzipping a downloaded release tags every file with a Zone.Identifier
    stream, and .NET refuses to load marked DLLs - which is what powers the
    app window (pythonnet -> WinForms/WebView2). Clearing the mark on our own
    bundled binaries is what Windows' "Unblock" checkbox does.
    """
    import os
    import sys
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return
    base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    cleared = 0
    for dirpath, _dirs, files in os.walk(base):
        for name in files:
            if name.lower().endswith((".dll", ".pyd", ".exe")):
                try:
                    os.remove(os.path.join(dirpath, name) + ":Zone.Identifier")
                    cleared += 1
                except OSError:
                    pass
    if cleared:
        log.info("Cleared the download mark from %d bundled files", cleared)


def show_error(title: str, text: str):
    """Native message box so problems are never silent."""
    import sys
    try:
        if sys.platform == "win32":
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)
        elif sys.platform == "darwin":
            import subprocess
            subprocess.run(["osascript", "-e", f'display alert "{title}" message "{text}"'], check=False)
    except Exception:
        pass


def run_desktop(show, port: int, lan: bool, data_dir: Path) -> bool:
    """Open the app window. Returns False if no native webview is available."""
    unblock_bundle()
    try:
        import webview
    except Exception as e:
        log.warning("Native window unavailable (%s); falling back to the browser", e)
        return False

    from .app import build_app

    url = None
    server = None
    if running_instance(port):
        # already running (e.g. double-clicked twice): open another window onto it
        url = f"http://127.0.0.1:{port}"
    else:
        host = "0.0.0.0" if lan else "127.0.0.1"
        while not port_free(host, port) and port < 8800:
            port += 1
        app = build_app(show, port, lan)
        server = ServerThread(app, host, port)
        server.start()
        server.ready.wait(10)
        if server.error:
            log.error("Server failed to start: %s", server.error)
            return False
        url = f"http://127.0.0.1:{port}"

    api = Api(show)
    window = webview.create_window(
        f"LightingSim {__version__}", url, js_api=api,
        width=1440, height=900, min_size=(960, 620), background_color="#0b0d14",
    )
    api._window = window
    if server:
        server.app["core"].on_quit = window.destroy  # the in-app Quit button closes the window

    webview.settings["ALLOW_DOWNLOADS"] = True
    import sys
    # Windows needs .ico (a PNG crashes WinForms); macOS takes its icon from the .app bundle
    icon = Path(__file__).resolve().parent.parent / "packaging" / ("icon.ico" if sys.platform == "win32" else "icon.png")
    try:
        webview.start(private_mode=False, storage_path=str(data_dir / "webview"),
                      icon=str(icon) if icon.exists() else None)
    except Exception as e:
        log.exception("Window failed: %s", e)
        if server:
            server.stop()
        return False
    if server:
        server.stop()
    return True
