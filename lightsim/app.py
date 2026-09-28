"""Local web server: serves the UI, streams frames, applies edits."""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import socket
import struct
import sys
import time
import webbrowser
from pathlib import Path

from aiohttp import WSMsgType, web

from . import __version__
from .clock import BeatClock
from .discovery import check_wled, scan_govee, scan_wiz
from .engine import DIVS, QUANT, TRANSITIONS, Engine, EngineThread
from .fixtures import PROFILES, make_fixture, new_id, normalize_fixture
from .midi import MidiManager
from .outputs import OutputManager, list_serial_ports
from .presets import PALETTES
from .show import Show
from .updater import Updater

log = logging.getLogger("lightsim")

LAYOUT_KEYS = {"x", "y", "x2", "y2", "sag", "pixels", "group", "color", "tint", "caps", "patch", "kind", "shape"}


def web_root() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "web"


def lan_ips() -> list[str]:
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith("127."))


class App:
    def __init__(self, show: Show, port: int, lan: bool):
        self.show = show
        self.port = port
        self.lan = lan
        self.clients: dict[web.WebSocketResponse, dict] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.learn_target: str | None = None
        self.last_learn: dict | None = None
        self.held_controls: dict[str, float] = {}
        self.on_quit = None  # set by the desktop window
        self.updater = Updater()

    # ------------------------------------------------------------------ lifecycle
    async def start(self, app: web.Application):
        self.loop = asyncio.get_running_loop()
        st = self.show.data["settings"]
        self.clock = BeatClock(self.loop, float(st.get("bpm", 124)))
        self.clock.use(st.get("clock_source", "internal"))
        self.outputs = OutputManager()
        self.engine = Engine(self.show, self.clock, self.outputs)
        bank = [i for i in self.show.data["bank"] if self.show.scene(i)]
        if bank:
            self.engine.current = bank[0]
        self.midi = MidiManager(self.loop, self.clock.midi, self.on_midi_control)
        self.midi.set_inputs(st.get("midi_inputs", []))
        self.thread = EngineThread(self.engine, self._on_frame_threadsafe)
        self.thread.start()
        self._status_task = asyncio.create_task(self._status_loop())
        if st.get("auto_update_check", True):
            asyncio.create_task(self._check_updates_later())

    async def stop(self, app: web.Application):
        self.thread.running = False
        self.thread.join(timeout=2)
        self._status_task.cancel()
        self.midi.close()
        self.clock.close()
        self.outputs.close()
        self.show.save()
        for ws in list(self.clients):
            await ws.close()

    # ------------------------------------------------------------------ streaming
    def _on_frame_threadsafe(self, frame: bytes, layout_version: int):
        if self.loop and self.clients:
            hdr = struct.pack("<Idf", layout_version, self.clock.beat(), self.clock.bpm)
            self.loop.call_soon_threadsafe(self._broadcast_frame, hdr + frame)

    def _broadcast_frame(self, data: bytes):
        for ws, info in self.clients.items():
            if info["busy"] or ws.closed:
                continue  # slow client: drop frames rather than lag
            info["busy"] = True
            asyncio.ensure_future(self._send_bytes(ws, info, data))

    async def _send_bytes(self, ws, info, data):
        try:
            await ws.send_bytes(data)
        except Exception:
            pass
        finally:
            info["busy"] = False

    async def _status_loop(self):
        while True:
            await asyncio.sleep(0.1)
            try:
                if self.clients:
                    msg = {"type": "status", "engine": self.engine.status(), "clock": self.clock.status(),
                           "outputs": self.outputs.status(), "learn": self.learn_target, "learned": self.last_learn,
                           "autopilot": self.show.data["settings"]["autopilot"].get("enabled", False),
                           "update": self.updater.state}
                    await self.broadcast(msg)
                self.show.save_if_dirty()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("status loop")

    async def broadcast(self, msg: dict, exclude=None):
        s = json.dumps(msg)
        for ws in list(self.clients):
            if ws is exclude or ws.closed:
                continue
            try:
                await ws.send_str(s)
            except Exception:
                pass

    def init_msg(self) -> dict:
        return {
            "type": "init",
            "version": __version__,
            "show": self.show.data,
            "profiles": PROFILES,
            "palettes": PALETTES,
            "divs": DIVS,
            "transitions": TRANSITIONS,
            "quantize": list(QUANT),
            "layout_version": self.engine.layout_version,
            "midi_inputs": self.midi.list_inputs(),
            "midi_error": self.midi.error,
            "serial_ports": list_serial_ports(),
            "lan_urls": [f"http://{ip}:{self.port}" for ip in lan_ips()] if self.lan else [],
            "lan": self.lan,
            "platform": sys.platform,
        }

    # ------------------------------------------------------------------ http
    async def index(self, request):
        return web.FileResponse(web_root() / "index.html", headers={"Cache-Control": "no-cache"})

    async def export_show(self, request):
        body = json.dumps(self.show.export(), indent=1)
        name = self.show.data.get("name", "show").replace(" ", "_")
        return web.Response(text=body, content_type="application/json",
                            headers={"Content-Disposition": f'attachment; filename="{name}.lightshow.json"'})

    def request_quit(self, delay: float = 0.3):
        if self.on_quit:  # desktop window: closing it shuts everything down cleanly
            asyncio.get_running_loop().call_later(delay, self.on_quit)
        else:
            asyncio.get_running_loop().call_later(delay, _graceful_exit)

    async def quit(self, request):
        self.request_quit()
        return web.json_response({"ok": True})

    async def _check_updates_later(self):
        await asyncio.sleep(4)
        await self.updater.check()
        if self.updater.state["available"]:
            log.info("Update available: %s", self.updater.state["latest"])

    async def _install_update(self):
        if await self.updater.install():
            # the helper swaps files once we've exited, then relaunches us
            self.request_quit(0.5)

    async def ping(self, request):
        return web.json_response({"app": "lightsim", "version": __version__})

    async def ws_handler(self, request):
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=32 * 1024 * 1024)
        await ws.prepare(request)
        self.clients[ws] = {"busy": False}
        await ws.send_str(json.dumps(self.init_msg()))
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        await self.handle(ws, json.loads(msg.data))
                    except Exception as e:
                        log.exception("op failed")
                        await ws.send_str(json.dumps({"type": "error", "message": str(e)}))
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            self.clients.pop(ws, None)
        return ws

    # ------------------------------------------------------------------ ops
    async def handle(self, ws, m: dict):
        op = m.get("op")
        eng, clk, show = self.engine, self.clock, self.show
        d = show.data

        # --- performance
        if op == "launch":
            eng.launch(m["scene"], m.get("quantize"), m.get("transition"))
        elif op == "tap":
            clk.tap()
        elif op == "bpm":
            clk.set_bpm(float(m["value"]))
            d["settings"]["bpm"] = clk.bpm
            show.mark_dirty()
        elif op == "nudge":
            clk.nudge(float(m["beats"]))
        elif op == "align":
            clk.align(int(m.get("period", 4)))
        elif op == "speed":
            clk.set_speed(float(m["value"]))
        elif op == "master":
            eng.master = max(0.0, min(1.0, float(m["value"])))
        elif op == "blackout":
            eng.blackout = bool(m["on"])
        elif op == "flash":
            eng.flash = max(0.0, min(1.0, float(m["value"])))
        elif op == "strobe":
            eng.strobe = bool(m["on"])
        elif op == "group_level":
            eng.group_levels[m["group"]] = max(0.0, min(1.0, float(m["value"])))
        elif op == "preview":
            eng.preview_scene = m.get("scene")
        elif op == "identify":
            with eng.lock:
                i = eng.layout.index.get(m["id"])
                if i is not None:
                    eng.identify[i] = time.perf_counter() + 2.0

        # --- fixtures
        elif op == "fixture_add":
            fx = make_fixture(m["kind"], float(m.get("x", 0.5)), float(m.get("y", 0.5)))
            if m.get("patch"):
                fx["patch"].update(m["patch"])
            if m.get("name"):
                fx["name"] = m["name"]
            d["fixtures"].append(fx)
            self._layout_changed()
            await self.broadcast({"type": "fixtures", "fixtures": d["fixtures"], "layout_version": eng.layout_version,
                                  "select": fx["id"]})
        elif op == "fixture_update":
            new = normalize_fixture(m["fixture"])
            for i, f in enumerate(d["fixtures"]):
                if f["id"] == new["id"]:
                    d["fixtures"][i] = new
            self._layout_changed()
            await self.broadcast({"type": "fixtures", "fixtures": d["fixtures"], "layout_version": eng.layout_version},
                                 exclude=ws if m.get("quiet") else None)
            if m.get("quiet"):
                await ws.send_str(json.dumps({"type": "layout_version", "layout_version": eng.layout_version}))
        elif op == "fixture_delete":
            d["fixtures"] = [f for f in d["fixtures"] if f["id"] not in set(m["ids"])]
            self._layout_changed()
            await self.broadcast({"type": "fixtures", "fixtures": d["fixtures"], "layout_version": eng.layout_version})
        elif op == "fixture_duplicate":
            src = show.fixture(m["id"])
            if src:
                fx = copy.deepcopy(src)
                fx["id"] = new_id()
                fx["name"] = src["name"] + " copy"
                for k in ("x", "x2"):
                    fx[k] = min(0.98, fx[k] + 0.04)
                for k in ("y", "y2"):
                    fx[k] = min(0.98, fx[k] + 0.04)
                d["fixtures"].append(fx)
                self._layout_changed()
                await self.broadcast({"type": "fixtures", "fixtures": d["fixtures"],
                                      "layout_version": eng.layout_version, "select": fx["id"]})

        # --- scenes
        elif op in ("scene_update", "scene_add"):
            sc = m["scene"]
            if op == "scene_add":
                sc = copy.deepcopy(sc)
                sc["id"] = new_id("sc")
                sc["builtin"] = False
                for t in sc.get("tracks", []):
                    t["id"] = new_id("tr")
                d["scenes"].append(sc)
                d["bank"].append(sc["id"])
            else:
                for i, s in enumerate(d["scenes"]):
                    if s["id"] == sc["id"]:
                        d["scenes"][i] = sc
            eng.touch()
            show.mark_dirty()
            await self.broadcast({"type": "scene", "scene": sc, "bank": d["bank"], "select": op == "scene_add"},
                                 exclude=ws if op == "scene_update" else None)
        elif op == "scene_delete":
            d["scenes"] = [s for s in d["scenes"] if s["id"] != m["id"]]
            d["bank"] = [i for i in d["bank"] if i != m["id"]]
            if eng.current == m["id"]:
                eng.current = d["bank"][0] if d["bank"] else None
            eng.touch()
            show.mark_dirty()
            await self.broadcast({"type": "scene_deleted", "id": m["id"], "bank": d["bank"]})
        elif op == "bank_order":
            ids = {s["id"] for s in d["scenes"]}
            d["bank"] = [i for i in m["ids"] if i in ids]
            show.mark_dirty()
            await self.broadcast({"type": "bank", "bank": d["bank"]})

        # --- look & settings
        elif op == "palette":
            d["palette"] = {"name": m["palette"].get("name", "Custom"), "colors": list(m["palette"]["colors"])[:8]}
            show.mark_dirty()
            await self.broadcast({"type": "palette", "palette": d["palette"]})
        elif op == "settings":
            await self.apply_settings(m["patch"])
        elif op == "rename_show":
            d["name"] = str(m["name"])[:80]
            show.mark_dirty()
        elif op == "import_show":
            show.replace(m["show"])
            eng.current = d["bank"][0] if d["bank"] else None
            self._layout_changed()
            eng.touch()
            await self.apply_settings({})
            for w in list(self.clients):
                await w.send_str(json.dumps(self.init_msg()))
        elif op == "reset_demo":
            from .presets import default_show
            keep = d["settings"]
            show.replace({**default_show(), "settings": keep})
            eng.current = show.data["bank"][0]
            self._layout_changed()
            eng.touch()
            for w in list(self.clients):
                await w.send_str(json.dumps(self.init_msg()))
        elif op == "restore_presets":
            from .presets import default_scenes
            have = {s["name"] for s in d["scenes"]}
            for sc in default_scenes():
                if sc["name"] not in have:
                    d["scenes"].append(sc)
                    d["bank"].append(sc["id"])
            eng.touch()
            show.mark_dirty()
            for w in list(self.clients):
                await w.send_str(json.dumps(self.init_msg()))

        # --- midi learn / discovery
        elif op == "midi_learn":
            self.learn_target = m.get("target")
            self.last_learn = None
        elif op == "midi_unmap":
            d["settings"]["midi_map"].pop(m["key"], None)
            show.mark_dirty()
            await self.broadcast({"type": "settings", "settings": d["settings"]})
        elif op == "update_check":
            await self.updater.check()
        elif op == "update_install":
            if self.updater.state["status"] not in ("downloading", "installing"):
                asyncio.create_task(self._install_update())
        elif op == "scan":
            kind = m.get("kind")
            if kind == "govee":
                res = await scan_govee()
            elif kind == "wiz":
                res = await scan_wiz()
            elif kind == "wled":
                res = [await check_wled(m.get("host", ""))]
            elif kind == "serial":
                res = list_serial_ports()
            elif kind == "midi":
                res = self.midi.list_inputs()
            else:
                res = []
            await ws.send_str(json.dumps({"type": "scan_result", "kind": kind, "results": res, "req": m.get("req")}))

    def _layout_changed(self):
        self.engine.rebuild_layout()
        self.show.mark_dirty()

    async def apply_settings(self, patch: dict):
        st = self.show.data["settings"]
        was_live = st.get("output_enabled")
        for k, v in patch.items():
            if isinstance(v, dict) and isinstance(st.get(k), dict):
                st[k] = {**st[k], **v}
            else:
                st[k] = v
        self.clock.use(st.get("clock_source", "internal"))
        if "midi_inputs" in patch:
            self.midi.set_inputs(st.get("midi_inputs", []))
        if "dmx_interfaces" in patch:
            self.outputs.configure(self.engine.layout, self.show.data)
        if was_live and not st.get("output_enabled"):
            self.outputs.blackout_all(self.engine.layout)
        self.show.mark_dirty()
        await self.broadcast({"type": "settings", "settings": st})

    # ------------------------------------------------------------------ MIDI control
    def on_midi_control(self, key: str, value: float):
        st = self.show.data["settings"]
        if self.learn_target and value > 0:
            st["midi_map"] = {k: v for k, v in st["midi_map"].items() if v != self.learn_target}
            st["midi_map"][key] = self.learn_target
            self.last_learn = {"key": key, "target": self.learn_target}
            self.learn_target = None
            self.show.mark_dirty()
            asyncio.ensure_future(self.broadcast({"type": "settings", "settings": st}))
            return
        target = st["midi_map"].get(key)
        if not target:
            return
        eng = self.engine
        pressed = value > 0
        if target.startswith("scene:"):
            if pressed:
                eng.launch(target[6:])
        elif target == "master":
            eng.master = value
        elif target.startswith("group:"):
            eng.group_levels[target[6:]] = value
        elif target == "flash":
            eng.flash = value
        elif target == "strobe":
            eng.strobe = pressed
        elif target == "blackout" and pressed:
            eng.blackout = not eng.blackout
        elif target == "tap" and pressed:
            self.clock.tap()
        elif target == "align_bar" and pressed:
            self.clock.align(4)
        elif target == "align_phrase" and pressed:
            self.clock.align(32)
        elif target in ("next", "prev") and pressed:
            bank = self.show.data["bank"]
            if bank:
                i = bank.index(eng.current) if eng.current in bank else -1
                eng.launch(bank[(i + (1 if target == "next" else -1)) % len(bank)])
        elif target == "autopilot" and pressed:
            ap = st["autopilot"]
            ap["enabled"] = not ap.get("enabled")
            asyncio.ensure_future(self.broadcast({"type": "settings", "settings": st}))


def _graceful_exit():
    raise web.GracefulExit()  # SystemExit subclass: stops run_app cleanly


@web.middleware
async def no_cache(request, handler):
    resp = await handler(request)
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"  # revalidate so app updates always load
    return resp


def build_app(show: Show, port: int, lan: bool) -> web.Application:
    core = App(show, port, lan)
    app = web.Application(client_max_size=32 * 1024 * 1024, middlewares=[no_cache])
    app.on_startup.append(core.start)
    app.on_shutdown.append(core.stop)
    app.router.add_get("/", core.index)
    app.router.add_get("/ws", core.ws_handler)
    app.router.add_get("/api/export", core.export_show)
    app.router.add_post("/api/quit", core.quit)
    app.router.add_get("/api/ping", core.ping)
    app.router.add_static("/static/", web_root(), show_index=False)
    app["core"] = core
    return app


def main(argv=None):
    import argparse

    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--finish-update"] and len(argv) >= 3:
        # launched by the previous version: install this copy over it, then relaunch
        from logging.handlers import RotatingFileHandler
        from .show import data_dir
        from .updater import finish_update
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S",
                            handlers=[RotatingFileHandler(data_dir() / "lightsim.log", maxBytes=1_000_000,
                                                          backupCount=1, encoding="utf-8")])
        finish_update(argv[1], argv[2], argv[3:])
        return

    ap = argparse.ArgumentParser(prog="lightsim", description="Budget DIY light show that syncs to rekordbox")
    ap.add_argument("--port", type=int, default=8750)
    ap.add_argument("--lan", action="store_true", help="allow phones/tablets on your Wi-Fi to open the controller")
    ap.add_argument("--browser", action="store_true", help="use your web browser instead of the app window")
    ap.add_argument("--no-browser", action="store_true", help="server only (for development / headless boxes)")
    ap.add_argument("--show", type=Path, help="show file to use (default: per-user app data)")
    args = ap.parse_args(argv)

    from logging.handlers import RotatingFileHandler
    from .show import data_dir
    handlers = [RotatingFileHandler(data_dir() / "lightsim.log", maxBytes=1_000_000, backupCount=1, encoding="utf-8")]
    if sys.stderr:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S",
                        handlers=handlers)
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    show = Show(args.show)
    lan = args.lan or bool(show.data["settings"].get("lan_access"))
    from .updater import cleanup_old_downloads
    import threading
    threading.Thread(target=cleanup_old_downloads, daemon=True).start()

    if not (args.browser or args.no_browser):
        from .desktop import run_desktop, show_error
        if run_desktop(show, args.port, lan, data_dir()):
            return
        log.warning("Falling back to browser mode")
        show_error("LightingSim", "LightingSim couldn't open its app window, so it will open in your web browser "
                   "this time.\n\nIf this keeps happening on Windows, install the free Microsoft Edge WebView2 "
                   f"Runtime.\n\nDetails are in:\n{data_dir() / 'lightsim.log'}")
    host = "0.0.0.0" if lan else "127.0.0.1"
    url = f"http://127.0.0.1:{args.port}"
    print(f"\n  LightingSim {__version__}\n  Open {url}")
    if lan:
        for ip in lan_ips():
            print(f"  On your Wi-Fi: http://{ip}:{args.port}")
    print(f"  Show file: {show.path}\n  Press Ctrl+C here to quit.\n")
    if not args.no_browser:
        import threading
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        web.run_app(build_app(show, args.port, lan), host=host, port=args.port, print=None,
                    handle_signals=True, shutdown_timeout=2.0)
    except OSError as e:
        print(f"Could not start on port {args.port}: {e}\nIs LightingSim already running? Try --port 8751")
        if not args.no_browser:
            webbrowser.open(url)


if __name__ == "__main__":
    main()
