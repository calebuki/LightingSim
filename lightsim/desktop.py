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


def focus_running(port: int) -> bool:
    """Ask the copy that's already open to come to the front. False if it has no window to show."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/focus", method="POST")
        with urllib.request.urlopen(req, timeout=3) as r:
            return bool(json.loads(r.read()).get("ok"))
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

    def __init__(self, show, url=""):
        self._show = show
        self._window = None
        self._url = url
        self._tvs = []

    def open_tv(self, pictures=None):
        """Open a window for each picture. Press again to close them.

        A group of TVs on one computer gets one window stretched across that many spare
        displays, so it's a single picture. With too few displays it opens as a normal window.
        """
        import webview
        if self._tvs:
            self.close_tv()
            return False
        pictures = pictures or [{"query": "", "tvs": 1, "aspect": 16 / 9}]
        spare = sorted(list(webview.screens)[1:], key=lambda s: (s.x, s.y))
        for pic in pictures:
            n = max(1, int(pic.get("tvs", 1)))
            url = f"{self._url}/tv" + (f"?{pic['query']}" if pic.get("query") else "")
            place = {"width": 1280, "height": max(240, round(1280 / float(pic.get("aspect") or 16 / 9)))}
            if len(spare) >= n:
                use, spare = spare[:n], spare[n:]
                if n == 1:
                    place = {"screen": use[0], "fullscreen": True}
                else:
                    x, y = min(s.x for s in use), min(s.y for s in use)
                    place = {"x": x, "y": y, "frameless": True, "on_top": True,
                             "width": max(s.x + s.width for s in use) - x,
                             "height": max(s.y + s.height for s in use) - y}
            win = webview.create_window("LightingSim TV", url, background_color="#000000", js_api=self, **place)
            if place.get("frameless"):
                # removing the title bar shrinks the window, so set its real size once it exists
                win.events.loaded += lambda w=win, p=place: (w.move(p["x"], p["y"]), w.resize(p["width"], p["height"]))
            win.events.closed += lambda w=win: self._tv_closed(w)
            self._tvs.append(win)
        return True

    def _tv_closed(self, win):
        if win in self._tvs:
            self._tvs.remove(win)

    def close_tv(self):
        for win in list(self._tvs):
            try:
                win.destroy()
            except Exception:
                pass
        self._tvs = []

    def toggle_fullscreen(self):
        import webview
        win = webview.active_window()
        if win is not None and win in self._tvs:
            win.toggle_fullscreen()

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
        # already open (e.g. double-clicked twice): show that window. A second copy
        # would hold the app's files open and stop updates from installing.
        if focus_running(port):
            return True
        # running without a window of its own (browser or server mode): open one onto it
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

    api = Api(show, url)
    window = webview.create_window(
        f"LightingSim {__version__}", url, js_api=api,
        width=1440, height=900, min_size=(960, 620), background_color="#0d0d0c",
    )
    api._window = window
    window.events.closed += api.close_tv  # the app quits with its main window
    if server:
        server.app["core"].on_quit = window.destroy  # the in-app Quit button closes the window
        minimized = threading.Event()
        window.events.minimized += minimized.set
        window.events.restored += minimized.clear
        window.events.maximized += minimized.clear

        def bring_to_front():
            if minimized.is_set():
                window.restore()
            window.on_top = True
            window.on_top = False

        server.app["core"].on_focus = bring_to_front

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
