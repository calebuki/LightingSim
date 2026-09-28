// Rig tab + inspector: add lights, patch them to real hardware, tune their physical limits.
import { S, send, request, fixture } from './state.js';
import { $, DIV_LABEL, clone, emit, field, h, on, select, toast } from './util.js';

const PROTOCOLS = [['none', 'Simulate only'], ['wled', 'WLED (ESP strip/pixels)'], ['govee', 'Govee LAN'], ['wiz', 'WiZ bulb'], ['dmx', 'DMX']];
const CAPS = [
  ['update_hz', 'Updates / sec', 'How often the device accepts a new value'],
  ['latency_ms', 'Latency ms', 'Network + firmware delay. LightingSim sends this much early when LIVE'],
  ['rise_ms', 'Fade-up ms', 'Physical/firmware fade when brightening'],
  ['fall_ms', 'Fade-down ms', 'Filament glow or firmware smoothing when dimming'],
  ['min_pulse_ms', 'Shortest flash ms', 'Faster patterns get re-timed by the track’s “Slow lights” rule'],
];
let root;

export function initRig() {
  root = $('#tab-rig');
  on('init', renderRig);
  on('fixtures', () => { renderRig(); renderInspector(); });
  on('select', () => { renderInspector(); highlightRow(); });
  on('settings', renderRig);
  on('add-light', openAddModal);
  on('fixture-moved', (f) => {
    const a = $('#fx-angle');
    if (a && f.id === S.sel) a.value = f.angle;
  });
}

// ------------------------------------------------------------------ helpers
export function fastestDiv(caps, bpm = 128, fps = 60) {
  const beatMs = 60000 / bpm;
  let best = 0;
  for (const d of [1, 2, 4, 8, 16, 32]) {
    const step = beatMs / d;
    if (step * 0.5 >= caps.min_pulse_ms && step >= 980 / Math.min(caps.update_hz, fps)) best = d;
  }
  return best;
}
function speedMeter(caps) {
  const d = fastestDiv(caps);
  const lvl = [0, 1, 2, 4, 8, 16, 32].indexOf(d);
  return h('span.speed', { title: 'Fastest clean on/off at 128 BPM' },
    [1, 2, 3, 4, 5, 6].map((i) => h('b', { class: i <= lvl ? 'on' : '' })),
    h('span', { style: { marginLeft: '6px' } }, d ? `strobes to ${DIV_LABEL[d]} @128` : 'no strobing'));
}
function outputLabel(f) {
  const p = f.patch || {};
  if (p.protocol === 'dmx') return `DMX ${p.interface} @${p.address}`;
  if (p.protocol === 'none' || !p.protocol) return 'Sim only';
  return `${p.protocol.toUpperCase()} ${p.host || '(no IP)'}`;
}
function outputTag(f) {
  const p = f.patch || {};
  if (!p.protocol || p.protocol === 'none') return h('span.tag.off', 'sim');
  if (p.protocol === 'dmx') {
    const iface = S.show.settings.dmx_interfaces.find((d) => d.id === p.interface);
    const ok = iface && iface.type !== 'none';
    return h('span.tag', { class: ok ? 'ok' : 'warn' }, ok ? 'patched' : 'set up DMX');
  }
  return h('span.tag', { class: p.host ? 'ok' : 'warn' }, p.host ? 'patched' : 'needs IP');
}
function update(f, rerender = false) {
  send('fixture_update', { fixture: f, quiet: true });
  emit('layout-local');
  if (rerender) { renderInspector(); renderRig(); }
}

// ------------------------------------------------------------------ rig tab
function renderRig() {
  if (!root || !S.show) return;
  const st = S.show.settings.stage;
  const fxs = S.show.fixtures;
  const counts = {};
  fxs.forEach((f) => (counts[f.kind] = (counts[f.kind] || 0) + 1));

  root.replaceChildren(h('div.rig',
    h('div', { style: { display: 'grid', gap: '10px', alignContent: 'start' } },
      h('div.row',
        h('button.btn.sm.primary', { onclick: openAddModal }, '+ Add light'),
        h('button.btn.sm', { onclick: (e) => scan('govee', e.target) }, 'Find Govee lights'),
        h('button.btn.sm', { onclick: (e) => scan('wiz', e.target) }, 'Find WiZ bulbs'),
        h('span.grow'),
        h('span.muted', { style: { fontSize: '12px' } }, `${fxs.length} lights · ${fxs.reduce((a, f) => a + f.pixels, 0)} pixels`)),
      h('div#scan-results.row'),
      h('div', { style: { overflowX: 'auto' } },
        h('table.list',
          h('thead', h('tr', ['Name', 'Type', 'Group', 'Output', 'Limits', ''].map((c) => h('th', c)))),
          h('tbody', fxs.map((f) => h('tr', { 'data-id': f.id, class: f.id === S.sel ? 'sel' : '', onclick: () => { S.sel = f.id; emit('select'); } },
            h('td', f.name),
            h('td.muted', S.profiles[f.kind]?.label || f.kind),
            h('td', h('span.tag', f.group)),
            h('td', outputTag(f), ' ', h('span.muted.mono', { style: { fontSize: '11px' } }, outputLabel(f))),
            h('td.mono.muted', { style: { fontSize: '11px' } }, `${f.caps.update_hz}Hz · ${f.caps.latency_ms}ms`),
            h('td', h('button.btn.xs', { onclick: (e) => { e.stopPropagation(); send('identify', { id: f.id }); } }, 'Identify')))))))),

    h('div', { style: { display: 'grid', gap: '12px', alignContent: 'start' } },
      h('div.card',
        h('h4', 'Stage'),
        h('div.row',
          h('label.btn.sm', { style: { cursor: 'pointer' } }, 'Upload photo of your space',
            h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => loadBackground(e.target.files[0]) })),
          st.background ? h('button.btn.sm', { onclick: () => send('settings', { patch: { stage: { ...st, background: '' } } }) }, 'Remove photo') : null),
        h('div.row',
          field('Shape', select([[1.7778, '16:9 wide'], [1.3333, '4:3'], [2.3333, '21:9 ultra-wide'], [1, 'Square']], st.aspect,
            (v) => send('settings', { patch: { stage: { ...st, aspect: parseFloat(v) } } }), { id: 'stage-aspect' }), 'grow'),
          field('Photo dim', h('input#stage-dim', { type: 'range', min: 0, max: 0.95, step: 0.05, value: st.bg_dim ?? 0.55,
            onchange: (e) => send('settings', { patch: { stage: { ...st, bg_dim: parseFloat(e.target.value) } } }) })),
          field('Haze', h('input#stage-haze', { type: 'range', min: 0, max: 1, step: 0.05, value: st.haze ?? 0.5,
            onchange: (e) => send('settings', { patch: { stage: { ...st, haze: parseFloat(e.target.value) } } }) }))),
        h('p.muted', { style: { margin: 0, fontSize: '12px' } }, 'Drag lights on the stage to place them. Drag the square handles to stretch strips and strings, the round handle to aim floods. Hold Shift to snap.')),
      h('div.card',
        h('h4', 'Your rig'),
        Object.keys(counts).length
          ? h('div', { style: { display: 'grid', gap: '6px' } }, Object.entries(counts).map(([k, n]) =>
            h('div.row', { style: { justifyContent: 'space-between', fontSize: '12.5px' } },
              h('span', `${n} × ${S.profiles[k]?.label || k}`), h('span.mono', { style: { color: 'var(--ok)', fontSize: '11px' } }, S.profiles[k]?.cost || ''))))
          : h('p.muted', 'No lights yet.'),
        h('p.muted', { style: { margin: 0, fontSize: '12px' } }, 'Cheapest fast path: one $5 ESP32 running WLED drives strips and pixel bulbs. A $15–20 FTDI USB-DMX cable runs budget DMX floods.')),
    )));
}
function highlightRow() {
  root?.querySelectorAll('tr[data-id]').forEach((r) => r.classList.toggle('sel', r.dataset.id === S.sel));
}

async function scan(kind, btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Searching…';
  const res = await request('scan', { kind });
  btn.disabled = false; btn.textContent = label;
  const box = $('#scan-results');
  if (!box) return res;
  if (!res.length) { box.replaceChildren(h('span.muted', { style: { fontSize: '12px' } }, kind === 'govee' ? 'No Govee devices answered. Turn on “LAN Control” for each light in the Govee app, and keep this computer on the same Wi-Fi.' : 'No WiZ bulbs answered. Check they’re on the same Wi-Fi and “Allow local communication” is on in the WiZ app.')); return res; }
  if (res[0].error) { box.replaceChildren(h('span.warn', res[0].error)); return res; }
  const taken = new Set(S.show.fixtures.map((f) => f.patch?.host).filter(Boolean));
  box.replaceChildren(h('span.muted', { style: { fontSize: '12px' } }, 'Found:'), ...res.map((d) =>
    h('button.btn.xs', {
      disabled: taken.has(d.host),
      onclick: () => send('fixture_add', {
        kind: d.protocol === 'govee' ? 'govee_string' : 'bulb_wiz', x: 0.2 + Math.random() * 0.6, y: 0.3 + Math.random() * 0.3,
        name: d.name, patch: { protocol: d.protocol, host: d.host } }),
    }, `${d.name} · ${d.host}${taken.has(d.host) ? ' (added)' : ''}`)));
  return res;
}

function loadBackground(file) {
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const st = S.show.settings.stage;
    send('settings', { patch: { stage: { ...st, background: c.toDataURL('image/jpeg', 0.8), aspect: +(img.width / img.height).toFixed(4) } } });
    URL.revokeObjectURL(img.src);
    toast('Photo set as stage background');
  };
  img.src = URL.createObjectURL(file);
}

// ------------------------------------------------------------------ add-light modal
function openAddModal() {
  const close = () => bg.remove();
  const bg = h('div.modal-bg', { onclick: (e) => e.target === bg && close() },
    h('div.modal', { role: 'dialog', 'aria-label': 'Add a light' },
      h('div.modal-head', h('h3', 'Add a light'), h('button.btn.sm', { onclick: close }, 'Close')),
      h('p.muted', { style: { margin: 0, fontSize: '13px' } }, 'Each type carries its real-world speed limits, so the simulator shows what your hardware will actually do.'),
      h('div.kinds', Object.entries(S.profiles).map(([k, p]) => h('button.kind', {
        onclick: () => { send('fixture_add', { kind: k, x: 0.3 + Math.random() * 0.4, y: 0.3 + Math.random() * 0.3 }); close(); },
      }, h('strong', p.label), speedMeter(p), h('small', p.notes), h('span.cost', p.cost))))));
  document.body.append(bg);
}

// ------------------------------------------------------------------ inspector
export function renderInspector() {
  const box = $('#inspector');
  if (!S.show) return;
  const f = fixture(S.sel);
  if (!f) {
    box.replaceChildren(h('div.empty-insp',
      h('h3', 'Nothing selected'),
      h('span', 'Click a light on the stage to patch it to real hardware, rename it, or tune its limits.'),
      h('button.btn.sm.primary', { onclick: openAddModal, style: { justifySelf: 'start' } }, '+ Add a light'),
      S.lanUrls?.length ? h('span', 'Phone remote: open ', h('b.mono', S.lanUrls[0]), ' on the same Wi-Fi.') : null));
    return;
  }
  const prof = S.profiles[f.kind] || {};
  const p = f.patch;
  const set = (k, v, rerender) => { f[k] = v; update(f, rerender); };
  const setP = (k, v, rerender) => { p[k] = v; update(f, rerender); };
  const line = ['line', 'string'].includes(f.shape);

  box.replaceChildren(
    h('div.insp-head',
      h('span.insp-swatch', { style: { background: f.color === 'mono' ? f.tint : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' } }),
      h('h3', f.name),
      h('span.grow'),
      h('button.btn.xs', { onclick: () => $('#inspector').classList.remove('open'), class: 'close-insp' }, '✕')),
    h('div.insp-grid',
      field('Name', h('input#fx-name', { type: 'text', value: f.name, oninput: (e) => { f.name = e.target.value; update(f); } }), 'full'),
      field('Type', select(Object.entries(S.profiles).map(([k, v]) => [k, v.label]), f.kind, (v) => applyProfile(f, v), { id: 'fx-kind' }), 'full'),
      field('Group', select([['floods', 'Floods'], ['strips', 'Strips'], ['strings', 'Strings'], ['bulbs', 'Bulbs']], f.group, (v) => set('group', v), { id: 'fx-group' })),
      field('Colour', select([['rgb', 'RGB colour'], ['mono', 'Single colour']], f.color, (v) => set('color', v, true), { id: 'fx-color' })),
      f.color === 'mono' ? field('Light tint', h('input#fx-tint', { type: 'color', value: f.tint, onchange: (e) => set('tint', e.target.value) })) : null,
      line || f.pixels > 1 ? field(f.shape === 'string' ? 'Bulbs' : 'Pixels', h('input#fx-pixels', { type: 'number', min: 1, max: 1024, value: f.pixels,
        onchange: (e) => set('pixels', Math.max(1, Math.min(1024, parseInt(e.target.value) || 1))) })) : null,
      f.shape === 'flood' ? field('Aim °', h('input#fx-angle', { type: 'number', step: 5, value: f.angle, onchange: (e) => set('angle', parseFloat(e.target.value)) })) : null,
      field('Size', h('input#fx-size', { type: 'range', min: 0.5, max: 2.5, step: 0.1, value: f.size || 1, oninput: (e) => set('size', parseFloat(e.target.value)) }))),

    h('div.insp-section',
      h('h4', 'Output'),
      field('Send via', select(PROTOCOLS, p.protocol || 'none', (v) => { f.patch = defaultPatch(v, p); update(f, true); }, { id: 'fx-proto' })),
      ...patchFields(f, setP),
      h('p.insp-note', prof.notes || '')),

    h('div.insp-section',
      h('h4', 'Physical limits'),
      speedMeter(f.caps),
      ...CAPS.map(([k, label, hint]) => h('label.cap-row', h('span', label, h('small', hint)),
        h('input', { type: 'number', min: 0, step: k === 'update_hz' ? 1 : 5, value: f.caps[k], id: `cap-${k}`,
          onchange: (e) => { f.caps[k] = Math.max(k === 'update_hz' ? 1 : 0, parseFloat(e.target.value) || 0); update(f, true); } }))),
      h('button.btn.xs', { style: { justifySelf: 'start' }, onclick: () => { f.caps = pickCaps(prof); update(f, true); } }, 'Reset to type defaults')),

    h('div.insp-actions',
      h('button.btn.sm', { onclick: () => send('identify', { id: f.id }) }, 'Identify'),
      h('button.btn.sm', { onclick: () => send('fixture_duplicate', { id: f.id }) }, 'Duplicate'),
      h('span.grow'),
      h('button.btn.sm', { onclick: (e) => {
        const b = e.target;
        if (b.dataset.armed) return send('fixture_delete', { ids: [f.id] });
        b.dataset.armed = '1'; b.textContent = 'Really remove?'; b.classList.add('danger');
      } }, 'Remove')),
  );
}

function pickCaps(prof) {
  return { update_hz: prof.update_hz, latency_ms: prof.latency_ms, rise_ms: prof.rise_ms, fall_ms: prof.fall_ms, min_pulse_ms: prof.min_pulse_ms };
}
function defaultPatch(proto, old = {}) {
  if (proto === 'dmx') return { protocol: 'dmx', interface: old.interface || 'dmx1', address: old.address || 1, channels: old.channels || ['r', 'g', 'b'], gamma: old.gamma ?? 2.2 };
  if (proto === 'wled') return { protocol: 'wled', host: old.host || '', start: old.start || 0 };
  if (proto === 'govee' || proto === 'wiz') return { protocol: proto, host: old.host || '' };
  return { protocol: 'none' };
}
function applyProfile(f, kind) {
  const p = S.profiles[kind];
  Object.assign(f, { kind, group: p.group, shape: p.shape, color: p.color, tint: p.tint || '#ffffff', pixels: p.pixels, caps: pickCaps(p) });
  if (['line', 'string'].includes(p.shape) && f.x2 === f.x && f.y2 === f.y) { f.x2 = Math.min(1, f.x + 0.25); }
  if (p.shape === 'string' && !f.sag) f.sag = 0.06;
  f.patch = defaultPatch(p.protocol, p.protocol === 'dmx' ? { channels: p.channels } : {});
  update(f, true);
}

function patchFields(f, setP) {
  const p = f.patch;
  const out = [];
  if (p.protocol === 'wled') {
    const status = h('span.insp-note');
    out.push(h('div.insp-grid',
      field('WLED IP', h('input#fx-host', { type: 'text', value: p.host || '', placeholder: '192.168.1.50', onchange: (e) => setP('host', e.target.value.trim()) })),
      field('First pixel', h('input#fx-start', { type: 'number', min: 0, value: p.start || 0, onchange: (e) => setP('start', parseInt(e.target.value) || 0) }))),
    h('div.row', h('button.btn.xs', { onclick: async () => {
      status.textContent = 'Checking…';
      const [r] = await request('scan', { kind: 'wled', host: p.host });
      status.textContent = r?.ok ? `✓ ${r.name}: ${r.leds} LEDs, WLED ${r.version}` : r?.error || 'No answer';
    } }, 'Check connection'), status),
    h('p.insp-note', 'Several strips on one ESP? Give each its own “First pixel” so they share the controller.'));
  } else if (p.protocol === 'govee' || p.protocol === 'wiz') {
    const res = h('div.row');
    out.push(field('Device IP', h('input#fx-host', { type: 'text', value: p.host || '', placeholder: '192.168.1.60', onchange: (e) => setP('host', e.target.value.trim()) })),
      h('div.row', h('button.btn.xs', { onclick: async (e) => {
        const b = e.target; b.disabled = true; b.textContent = 'Searching…';
        const found = await request('scan', { kind: p.protocol });
        b.disabled = false; b.textContent = 'Find on Wi-Fi';
        res.replaceChildren(...(found.length && !found[0].error ? found.map((d) => h('button.btn.xs', { onclick: () => setP('host', d.host, true) }, `${d.name} ${d.host}`))
          : [h('span.insp-note', found[0]?.error || 'Nothing answered. Enable LAN control in the vendor app.')]));
      } }, 'Find on Wi-Fi')), res);
  } else if (p.protocol === 'dmx') {
    const ifaces = S.show.settings.dmx_interfaces;
    const n = (p.channels || []).length * f.pixels;
    out.push(h('div.insp-grid',
      field('Interface', select(ifaces.map((d) => [d.id, `${d.id} (${d.type})`]), p.interface, (v) => setP('interface', v), { id: 'fx-iface' })),
      field('Start address', h('input#fx-addr', { type: 'number', min: 1, max: 512, value: p.address || 1, onchange: (e) => setP('address', parseInt(e.target.value) || 1, true) })),
      field('Channels (in order)', h('input#fx-chans', { type: 'text', value: (p.channels || []).join(', '),
        title: 'dim, r, g, b, w, strobe, or a number to hold a channel at that value (e.g. mode = 0)',
        onchange: (e) => setP('channels', e.target.value.split(/[\s,]+/).filter(Boolean), true) }), 'full'),
      field('Gamma', h('input#fx-gamma', { type: 'number', min: 1, max: 3, step: 0.1, value: p.gamma ?? 2.2, onchange: (e) => setP('gamma', parseFloat(e.target.value) || 1) }))),
    h('p.insp-note', `Uses DMX ${p.address}–${p.address + n - 1}. Words: dim r g b w strobe; numbers hold a channel (e.g. “0” for a mode channel). Set the light’s own strobe channel to 0: LightingSim strobes in software.`));
  } else {
    out.push(h('p.insp-note', 'Simulate only. Pick an output when you buy the light.'));
  }
  return out;
}
