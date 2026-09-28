// Shared app state + server connection primitives.
export const S = {
  show: null, profiles: {}, palettes: [], divs: [], transitions: [], quantize: [],
  status: null, sel: null, editScene: null, lanUrls: [], serialPorts: [], midiInputs: [],
  frame: null, beat: 0, beatT: 0, bpm: 120, speed: 1, connected: false,
};

let ws = null;
let reqId = 0;
export const pending = new Map();

export function setSocket(s) { ws = s; }

export function send(op, data = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, ...data }));
}
export function request(op, data = {}) {
  const req = ++reqId;
  send(op, { ...data, req });
  return new Promise((res) => {
    pending.set(req, res);
    setTimeout(() => pending.has(req) && (pending.delete(req), res([])), 6000);
  });
}
/** Estimated beat right now (frames arrive ~30/s; interpolate between them). */
export function beatNow() {
  return S.beat + ((performance.now() - S.beatT) / 60000) * S.bpm * S.speed;
}
export const scene = (id) => S.show?.scenes.find((s) => s.id === id);
export const fixture = (id) => S.show?.fixtures.find((f) => f.id === id);
export const palette = () => S.show?.palette?.colors || ['#ffffff'];
