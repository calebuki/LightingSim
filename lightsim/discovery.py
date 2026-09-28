"""Find budget lights on the LAN so you don't have to hunt for IP addresses."""
from __future__ import annotations

import asyncio
import json
import socket

import aiohttp


class _Collector(asyncio.DatagramProtocol):
    def __init__(self):
        self.found: list[tuple[str, dict]] = []

    def datagram_received(self, data, addr):
        try:
            self.found.append((addr[0], json.loads(data.decode("utf-8", "ignore"))))
        except Exception:
            pass


async def scan_govee(timeout: float = 2.0) -> list[dict]:
    """Govee LAN API: multicast scan on 4001, devices answer on 4002."""
    loop = asyncio.get_running_loop()
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", 4002))
    except OSError as e:
        return [{"error": f"Port 4002 busy ({e}). Close the Govee desktop app and retry."}]
    tr, proto = await loop.create_datagram_endpoint(_Collector, sock=sock)
    try:
        msg = json.dumps({"msg": {"cmd": "scan", "data": {"account_topic": "reserve"}}}).encode()
        tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        tx.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        for _ in range(2):
            tx.sendto(msg, ("239.255.255.250", 4001))
            await asyncio.sleep(timeout / 2)
        tx.close()
    finally:
        tr.close()
    out, seen = [], set()
    for ip, d in proto.found:
        data = d.get("msg", {}).get("data", {})
        ip = data.get("ip", ip)
        if ip in seen:
            continue
        seen.add(ip)
        out.append({"protocol": "govee", "host": ip, "name": data.get("sku", "Govee"), "id": data.get("device", "")})
    return out


async def scan_wiz(timeout: float = 1.5) -> list[dict]:
    loop = asyncio.get_running_loop()
    tr, proto = await loop.create_datagram_endpoint(_Collector, local_addr=("0.0.0.0", 0), allow_broadcast=True)
    try:
        msg = json.dumps({"method": "getPilot", "params": {}}).encode()
        for _ in range(3):
            tr.sendto(msg, ("255.255.255.255", 38899))
            await asyncio.sleep(timeout / 3)
    finally:
        tr.close()
    out, seen = [], set()
    for ip, d in proto.found:
        if ip in seen or "result" not in d:
            continue
        seen.add(ip)
        out.append({"protocol": "wiz", "host": ip, "name": "WiZ " + d["result"].get("mac", "")[-4:], "id": d["result"].get("mac", "")})
    return out


async def check_wled(host: str) -> dict:
    """Ask a WLED controller for its name and LED count."""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2.5)) as s:
            async with s.get(f"http://{host}/json/info") as r:
                info = await r.json(content_type=None)
        return {"ok": True, "name": info.get("name", "WLED"), "leds": info.get("leds", {}).get("count", 0),
                "version": info.get("ver", "")}
    except Exception as e:
        return {"ok": False, "error": f"No WLED at {host}: {e.__class__.__name__}"}
