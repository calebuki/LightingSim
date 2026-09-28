"""Capture real UDP output on localhost and check the wire format."""
import json
import socket

import numpy as np

from lightsim.engine import Layout
from lightsim.fixtures import make_fixture
from lightsim.outputs import OutputManager


def _listen(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", port))
    s.settimeout(1.0)
    return s


def _show(fixtures, dmx=None):
    return {"fixtures": fixtures, "settings": {"dmx_interfaces": dmx or []}}


def test_wled_ddp_packet():
    rx = _listen(4048)
    fx = make_fixture("strip_wled", 0.1, 0.5, pixels=4)
    fx["patch"].update(host="127.0.0.1", start=2)
    lay = Layout([fx], 1)
    om = OutputManager()
    om.configure(lay, _show([fx]))
    held = np.array([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]], dtype=float)
    om.send(held, np.array([True]), lay)
    data, _ = rx.recvfrom(2000)
    rx.close()
    assert data[0] == 0x41 and data[2] == 0x0B  # v1 + push, RGB 8-bit
    assert int.from_bytes(data[8:10], "big") == 6 * 3  # 2 blank pixels + 4
    assert data[10:16] == bytes(6) and data[16:19] == b"\xff\x00\x00" and data[-3:] == b"\xff\xff\xff"


def test_artnet_packet():
    rx = _listen(6454)
    fx = make_fixture("flood_dmx", 0.5, 0.5)
    fx["patch"].update(interface="an", address=10, channels=["dim", "r", "g", "b", "strobe"])
    lay = Layout([fx], 1)
    om = OutputManager()
    om.configure(lay, _show([fx], [{"id": "an", "type": "artnet", "host": "127.0.0.1", "universe": 3}]))
    om.send(np.array([[0.0, 1.0, 0.0]]), np.array([True]), lay)
    data, _ = rx.recvfrom(1000)
    rx.close()
    assert data[:8] == b"Art-Net\x00" and int.from_bytes(data[14:16], "little") == 3
    dmx = data[18:]
    assert list(dmx[9:14]) == [255, 0, 255, 0, 0]


def test_govee_and_wiz_json():
    gv, wz = _listen(4003), _listen(38899)
    g = make_fixture("govee_string", 0.2, 0.2)
    g["patch"]["host"] = "127.0.0.1"
    w = make_fixture("bulb_wiz", 0.5, 0.5)
    w["patch"]["host"] = "127.0.0.1"
    lay = Layout([g, w], 1)
    om = OutputManager()
    om.configure(lay, _show([g, w]))
    held = np.zeros((lay.P, 3))
    held[:, 2] = 0.5
    om.send(held, np.array([True, True]), lay)
    msgs = [json.loads(gv.recvfrom(2000)[0]) for _ in range(3)]
    assert msgs[-1]["msg"]["cmd"] == "colorwc" and msgs[-1]["msg"]["data"]["color"]["b"] == 128
    wiz = json.loads(wz.recvfrom(2000)[0])
    assert wiz["method"] == "setPilot" and wiz["params"]["b"] == 255 and wiz["params"]["dimming"] == 50
    gv.close()
    wz.close()
