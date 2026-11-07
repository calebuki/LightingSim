// Server connection, shared by the controller and the TV page.
import { S, fixture, pending, scene, setSocket } from './state.js';
import { emit } from './util.js';

function onFrame(buf) {
  const dv = new DataView(buf);
  S.beat = dv.getFloat64(4, true);
  S.bpm = dv.getFloat32(12, true);
  S.beatT = performance.now();
  S.frame = new Uint8Array(buf, 16);
}

const handlers = {
  init(m) {
    Object.assign(S, {
      show: m.show, profiles: m.profiles, palettes: m.palettes, divs: m.divs, transitions: m.transitions,
      quantize: m.quantize, lanUrls: m.lan_urls, serialPorts: m.serial_ports, midiInputs: m.midi_inputs,
      midiError: m.midi_error, version: m.version, lan: m.lan,
    });
    if (!scene(S.editScene)) S.editScene = S.show.bank[0] || null;
    if (S.sel && !fixture(S.sel)) S.sel = null;
    emit('init');
  },
  status(m) {
    S.status = m;
    S.speed = m.clock.speed;
    emit('status', m);
  },
  fixtures(m) {
    S.show.fixtures = m.fixtures;
    if (m.select) S.sel = m.select;
    if (S.sel && !fixture(S.sel)) S.sel = null;
    emit('fixtures');
  },
  layout_version() {},
  scene(m) {
    const i = S.show.scenes.findIndex((s) => s.id === m.scene.id);
    if (i >= 0) S.show.scenes[i] = m.scene; else S.show.scenes.push(m.scene);
    S.show.bank = m.bank;
    if (m.select) S.editScene = m.scene.id;
    emit('scenes', m.scene.id);
  },
  scene_deleted(m) {
    S.show.scenes = S.show.scenes.filter((s) => s.id !== m.id);
    S.show.bank = m.bank;
    if (S.editScene === m.id) S.editScene = S.show.bank[0] || null;
    emit('scenes');
  },
  bank(m) { S.show.bank = m.bank; emit('scenes'); },
  palette(m) { S.show.palette = m.palette; emit('palette'); },
  settings(m) { S.show.settings = m.settings; emit('settings'); },
  scan_result(m) { const r = pending.get(m.req); if (r) { pending.delete(m.req); r(m.results); } },
  error(m) { emit('server-error', m.message); },
};

export function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  setSocket(ws);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { S.connected = true; emit('online', true); };
  ws.onclose = () => { S.connected = false; emit('online', false); setTimeout(connect, 1000); };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return onFrame(e.data);
    const m = JSON.parse(e.data);
    handlers[m.type]?.(m);
  };
}
