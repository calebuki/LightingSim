"""Hardware outputs. Everything here is cheap, LAN or USB, no cloud.

- WLED (ESP8266/ESP32 LED strips & pixel bulbs): DDP over UDP 4048, low latency
- Govee LAN API: UDP 4003 JSON (enable "LAN Control" per device in the Govee app)
- WiZ bulbs: UDP 38899 JSON
- DMX: Enttec DMX USB Pro (and clones), FTDI "Open DMX" cables, Art-Net nodes

The engine already sample-and-holds at each fixture's update rate, so drivers
just send when their fixture's value was refreshed (plus keep-alives).
"""
from __future__ import annotations

import json
import logging
import socket
import threading
import time

import numpy as np

log = logging.getLogger("lightsim.out")

try:
    import serial
    from serial.tools import list_ports
except Exception:  # pragma: no cover
    serial = None
    list_ports = None


def list_serial_ports() -> list[dict]:
    if not list_ports:
        return []
    return [{"device": p.device, "description": p.description or p.device} for p in list_ports.comports()]


class Udp:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self.sock.setblocking(False)
        self.errors = 0

    def send(self, data: bytes, host: str, port: int):
        if not host:
            return
        try:
            self.sock.sendto(data, (host, port))
        except (OSError, ValueError):
            self.errors += 1


# ----------------------------------------------------------------------------- WLED
class DdpSender:
    PORT = 4048
    MAX = 1440  # bytes per packet (480 RGB pixels)

    def __init__(self, udp: Udp, host: str):
        self.udp, self.host = udp, host
        self.members: list[tuple[int, int]] = []  # (fixture index, start pixel)
        self.seq = 0
        self.last = 0.0

    def send(self, lay, rgb8: np.ndarray, upd, now):
        if not (any(upd[i] for i, _ in self.members) or now - self.last > 1.0):
            return
        self.last = now
        end = max(s + int(lay.offsets[i + 1] - lay.offsets[i]) for i, s in self.members)
        buf = np.zeros((end, 3), np.uint8)
        for i, s in self.members:
            a, b = lay.offsets[i], lay.offsets[i + 1]
            buf[s:s + (b - a)] = rgb8[a:b]
        data = buf.tobytes()
        self.seq = (self.seq % 15) + 1
        for off in range(0, len(data), self.MAX):
            chunk = data[off:off + self.MAX]
            push = 0x01 if off + self.MAX >= len(data) else 0x00
            hdr = bytes([0x40 | push, self.seq, 0x0B, 0x01]) + off.to_bytes(4, "big") + len(chunk).to_bytes(2, "big")
            self.udp.send(hdr + chunk, self.host, self.PORT)


# ----------------------------------------------------------------------------- Govee
class GoveeSender:
    PORT = 4003

    def __init__(self, udp: Udp, host: str, index: int):
        self.udp, self.host, self.i = udp, host, index
        self.last_rgb = None
        self.last = 0.0
        self.woke = False

    def _cmd(self, cmd: str, data: dict):
        self.udp.send(json.dumps({"msg": {"cmd": cmd, "data": data}}).encode(), self.host, self.PORT)

    def send(self, lay, rgb8, upd, now):
        if not upd[self.i] and now - self.last < 2.0:
            return
        a, b = lay.offsets[self.i], lay.offsets[self.i + 1]
        c = rgb8[a:b].max(axis=0)  # whole device is one colour on the LAN API
        rgb = (int(c[0]), int(c[1]), int(c[2]))
        if rgb == self.last_rgb and now - self.last < 2.0:
            return
        if not self.woke:
            self._cmd("turn", {"value": 1})
            self._cmd("brightness", {"value": 100})
            self.woke = True
        self._cmd("colorwc", {"color": {"r": rgb[0], "g": rgb[1], "b": rgb[2]}, "colorTemInKelvin": 0})
        self.last_rgb, self.last = rgb, now


# ----------------------------------------------------------------------------- WiZ
class WizSender:
    PORT = 38899

    def __init__(self, udp: Udp, host: str, index: int):
        self.udp, self.host, self.i = udp, host, index
        self.last_msg = None
        self.last = 0.0

    def send(self, lay, rgb8, upd, now):
        if not upd[self.i] and now - self.last < 2.0:
            return
        a = lay.offsets[self.i]
        r, g, b = (int(v) for v in rgb8[a])
        m = max(r, g, b)
        if m < 8:
            params = {"state": False}
        else:
            k = 255.0 / m
            params = {"state": True, "r": min(255, int(r * k)), "g": min(255, int(g * k)), "b": min(255, int(b * k)),
                      "dimming": max(10, min(100, int(m / 2.55)))}
        if params == self.last_msg and now - self.last < 2.0:
            return
        self.udp.send(json.dumps({"id": 1, "method": "setPilot", "params": params}).encode(), self.host, self.PORT)
        self.last_msg, self.last = params, now


# ----------------------------------------------------------------------------- DMX
class DmxInterface:
    """A 512-channel universe plus a transport."""

    def __init__(self, cfg: dict, udp: Udp):
        self.cfg = cfg
        self.type = cfg.get("type", "none")
        self.udp = udp
        self.universe = bytearray(512)
        self.members: list[dict] = []
        self.dirty = True
        self.ser = None
        self.error = ""
        self.seq = 0
        self.last = 0.0
        self._stop = False
        self._thread = None
        if self.type in ("usbpro", "opendmx"):
            self._open_serial()
            if self.type == "opendmx" and self.ser:
                self._thread = threading.Thread(target=self._opendmx_loop, daemon=True, name="opendmx")
                self._thread.start()

    def _open_serial(self):
        port = self.cfg.get("port")
        if not serial or not port:
            self.error = "No serial port selected" if serial else "pyserial not installed"
            return
        try:
            if self.type == "opendmx":
                self.ser = serial.Serial(port, 250000, bytesize=8, parity="N", stopbits=2, timeout=0)
            else:
                self.ser = serial.Serial(port, 57600, timeout=0)
            self.error = ""
        except Exception as e:
            self.error = f"{port}: {e}"
            log.warning("DMX open failed: %s", self.error)

    def _opendmx_loop(self):
        # FTDI "Open DMX" has no brains: we generate break + frame ~30x/s ourselves
        while not self._stop and self.ser:
            try:
                self.ser.break_condition = True
                time.sleep(0.0002)
                self.ser.break_condition = False
                time.sleep(0.00002)
                self.ser.write(b"\x00" + bytes(self.universe))
            except Exception as e:
                self.error = str(e)
                time.sleep(1.0)
            time.sleep(0.028)

    def flush(self, now: float):
        if self.type == "usbpro" and self.ser and (self.dirty or now - self.last > 1.0):
            data = b"\x00" + bytes(self.universe)
            n = len(data)
            try:
                self.ser.write(bytes([0x7E, 6, n & 0xFF, n >> 8]) + data + b"\xE7")
            except Exception as e:
                self.error = str(e)
        elif self.type == "artnet" and (self.dirty or now - self.last > 1.0):
            u = int(self.cfg.get("universe", 0))
            self.seq = (self.seq % 255) + 1
            pkt = (b"Art-Net\x00" + (0x5000).to_bytes(2, "little") + (14).to_bytes(2, "big")
                   + bytes([self.seq, 0]) + u.to_bytes(2, "little") + (512).to_bytes(2, "big") + bytes(self.universe))
            self.udp.send(pkt, self.cfg.get("host") or "255.255.255.255", 6454)
        else:
            return
        self.last = now
        self.dirty = False

    def close(self):
        self._stop = True
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass


def dmx_values(channels: list[str], rgb: np.ndarray, mono: bool, tint_max: float, gamma: float) -> list[int]:
    """Map one pixel's RGB (0..1) to a fixture's channel list."""
    r, g, b = (float(x) for x in rgb)
    tokens = [c.lower().strip() for c in channels]
    lvl = max(r, g, b)
    if mono or not any(t in ("r", "g", "b") for t in tokens):
        dim = min(1.0, lvl / max(tint_max, 1e-3)) ** gamma
        return [_const(t, dim, dim, dim, dim, dim) for t in tokens]
    w = 0.0
    if "w" in tokens or "white" in tokens:
        w = min(r, g, b)
        r, g, b = r - w, g - w, b - w
    if "dim" in tokens and lvl > 0:
        dim = lvl ** gamma
        return [_const(t, dim, r / lvl, g / lvl, b / lvl, w / lvl) for t in tokens]
    return [_const(t, 1.0, r ** gamma, g ** gamma, b ** gamma, w ** gamma) for t in tokens]


def _const(t, dim, r, g, b, w) -> int:
    m = {"dim": dim, "r": r, "g": g, "b": b, "w": w, "white": w}
    if t in m:
        return max(0, min(255, int(m[t] * 255 + 0.5)))
    if t.isdigit():
        return max(0, min(255, int(t)))
    return 0  # strobe/mode/speed/amber/uv... parked at 0; we strobe in software


# ----------------------------------------------------------------------------- manager
class OutputManager:
    def __init__(self):
        self.udp = Udp()
        self.senders: list = []
        self.dmx: dict[str, DmxInterface] = {}
        self.dmx_members: list[tuple[DmxInterface, int, dict, float]] = []
        self.lock = threading.Lock()
        self.dmx_cfg_key = None

    def configure(self, lay, show: dict):
        with self.lock:
            st = show["settings"]
            key = json.dumps(st.get("dmx_interfaces", []), sort_keys=True)
            if key != self.dmx_cfg_key:
                for d in self.dmx.values():
                    d.close()
                self.dmx = {c["id"]: DmxInterface(c, self.udp) for c in st.get("dmx_interfaces", [])}
                self.dmx_cfg_key = key
            self.senders = []
            self.dmx_members = []
            ddp: dict[str, DdpSender] = {}
            for i, fx in enumerate(lay.fixtures):
                p = fx.get("patch", {})
                proto = p.get("protocol", "none")
                host = (p.get("host") or "").strip()
                if proto == "wled" and host:
                    s = ddp.get(host)
                    if s is None:
                        s = ddp[host] = DdpSender(self.udp, host)
                        self.senders.append(s)
                    s.members.append((i, int(p.get("start", 0))))
                elif proto == "govee" and host:
                    self.senders.append(GoveeSender(self.udp, host, i))
                elif proto == "wiz" and host:
                    self.senders.append(WizSender(self.udp, host, i))
                elif proto == "dmx" and p.get("interface") in self.dmx:
                    tint = max(lay.tint[i]) if len(lay.tint) else 1.0
                    self.dmx_members.append((self.dmx[p["interface"]], i, p, tint))

    def send(self, held: np.ndarray, upd: np.ndarray, lay):
        now = time.perf_counter()
        with self.lock:
            if self.senders:
                rgb8 = (np.clip(held, 0, 1) * 255 + 0.5).astype(np.uint8)
                for s in self.senders:
                    s.send(lay, rgb8, upd, now)
            for dev, i, p, tint in self.dmx_members:
                if not upd[i]:
                    continue
                addr = max(1, int(p.get("address", 1))) - 1
                chans = p.get("channels") or ["r", "g", "b"]
                gamma = float(p.get("gamma", 2.2))
                a, b = lay.offsets[i], lay.offsets[i + 1]
                vals = []
                for px in held[a:b]:
                    vals += dmx_values(chans, px, bool(lay.mono[i]), tint, gamma)
                end = min(512, addr + len(vals))
                dev.universe[addr:end] = bytes(vals[: end - addr])
                dev.dirty = True
            for dev in self.dmx.values():
                dev.flush(now)

    def blackout_all(self, lay):
        """Leave every light dark when the app stops or live output is disarmed."""
        if lay is not None and lay.P:
            self.send(np.zeros((lay.P, 3)), np.ones(lay.F, bool), lay)
        with self.lock:
            for dev in self.dmx.values():
                dev.universe[:] = bytes(512)
                dev.dirty = True
                dev.flush(time.perf_counter())

    def status(self) -> dict:
        return {
            "dmx": {k: {"type": d.type, "ok": not d.error and d.type != "none", "error": d.error} for k, d in self.dmx.items()},
            "network_senders": len(self.senders),
            "udp_errors": self.udp.errors,
        }

    def close(self):
        for d in self.dmx.values():
            d.close()
