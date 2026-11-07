// Rig tab: add lights, place them on the stage, patch them to real hardware, tune their limits.
import { S, send, request, fixture } from './state.js';
import { $, DIV_LABEL, emit, field, h, on, select, toast } from './util.js';
import { openTV } from './tvpanel.js';
import { GROUPS, TV_WIDTH } from './visuals/walls.js';

const PROTOCOLS = [['none', 'Simulate'], ['wled', 'WLED'], ['govee', 'Govee LAN'], ['wiz', 'WiZ'], ['dmx', 'DMX']];
const CAPS = [
  ['update_hz', 'Updates / sec'],
  ['latency_ms', 'Latency ms'],
  ['rise_ms', 'Fade up ms'],
  ['fall_ms', 'Fade down ms'],
  ['min_pulse_ms', 'Shortest flash ms'],
];
let root, list, inspector;
let page = 'light';

export function initRig() {
  root = $('#tab-rig');
  list = h('div#rig-list');
  inspector = h('div#inspector');
  root.append(list, inspector);
  on('init', renderAll);
  on('fixtures', renderAll);
  on('settings', renderAll);
  on('select', () => { renderInspector(); markRow(); });
  on('fixture-moved', (f) => {
    const a = $('#fx-angle');
    if (a && f.id === S.sel) a.value = f.angle;
    const sz = $('#fx-size');
    if (sz && f.id === S.sel) sz.value = f.size;
  });
}

function renderAll() {
  if (!S.show) return;
  if (document.activeElement?.type === 'range' && inspector.contains(document.activeElement)) return; // mid-drag
  renderList();
  renderInspector();
}

// ------------------------------------------------------------------ list
function statusClass(f) {
  const p = f.patch || {};
  if (f.shape === 'screen') return 'ok';
  if (!p.protocol || p.protocol === 'none') return '';
  if (p.protocol === 'dmx') {
    const iface = S.show.settings.dmx_interfaces.find((d) => d.id === p.interface);
    return iface && iface.type !== 'none' ? 'ok' : 'warn';
  }
  return p.host ? 'ok' : 'warn';
}

function renderList() {
  list.replaceChildren(
    h('div.bar-row',
      h('button', { onclick: openAddModal }, 'Add'),
      h('button', { onclick: (e) => scan('govee', e.target) }, 'Find Govee'),
      h('button', { onclick: (e) => scan('wiz', e.target) }, 'Find WiZ')),
    h('div#scan-results.bar-row'),
    h('div.fx-list', S.show.fixtures.map((f) => h('button.fx-item', {
      class: f.id === S.sel ? 'on' : '', 'data-id': f.id,
      onclick: () => { S.sel = f.id === S.sel ? null : f.id; emit('select'); },
    }, h('i.st', { class: statusClass(f) }), h('span', f.name)))));
}
function markRow() {
  list.querySelectorAll('.fx-item').forEach((r) => r.classList.toggle('on', r.dataset.id === S.sel));
}

async function scan(kind, btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Searching';
  const res = await request('scan', { kind });
  btn.disabled = false; btn.textContent = label;
  const box = $('#scan-results');
  if (!box) return res;
  if (!res.length) { box.replaceChildren(h('span.note', kind === 'govee' ? 'None found. Turn on LAN Control in the Govee app.' : 'None found. Turn on local communication in the WiZ app.')); return res; }
  if (res[0].error) { box.replaceChildren(h('span.note.warn', res[0].error)); return res; }
  const taken = new Set(S.show.fixtures.map((f) => f.patch?.host).filter(Boolean));
  box.replaceChildren(...res.map((d) =>
    h('button', {
      disabled: taken.has(d.host),
      onclick: () => send('fixture_add', {
        kind: d.protocol === 'govee' ? 'govee_string' : 'bulb_wiz', x: 0.2 + Math.random() * 0.6, y: 0.3 + Math.random() * 0.3,
        name: d.name, patch: { protocol: d.protocol, host: d.host } }),
    }, `${d.name} ${d.host}`)));
  return res;
}

// ------------------------------------------------------------------ add
function fastestDiv(caps, bpm = 128, fps = 60) {
  const beatMs = 60000 / bpm;
  let best = 0;
  for (const d of [1, 2, 4, 8, 16, 32]) {
    const step = beatMs / d;
    if (step * 0.5 >= caps.min_pulse_ms && step >= 980 / Math.min(caps.update_hz, fps)) best = d;
  }
  return best;
}

function openAddModal() {
  const close = () => bg.remove();
  const bg = h('div.modal-bg', { onclick: (e) => e.target === bg && close() },
    h('div.modal', { role: 'dialog', 'aria-label': 'Add' },
      h('table.kinds', h('tbody', Object.entries(S.profiles).map(([k, p]) => {
        const d = fastestDiv(p);
        return h('tr', { onclick: () => { if (k === 'tv') addTV(); else send('fixture_add', { kind: k, x: 0.3 + Math.random() * 0.4, y: 0.3 + Math.random() * 0.3 }); close(); } },
          h('td', p.label),
          h('td.dim', p.shape === 'screen' ? '' : d ? `strobes to ${DIV_LABEL[d]}` : 'no strobe'),
          h('td.dim', p.cost));
      })))));
  document.body.append(bg);
}

// ------------------------------------------------------------------ inspector
function update(f, rerender = false) {
  send('fixture_update', { fixture: f, quiet: true });
  emit('layout-local');
  if (rerender) { renderInspector(); renderList(); }
}

export function renderInspector() {
  if (!inspector || !S.show) return;
  const f = fixture(S.sel);
  if (!f) return inspector.replaceChildren(...stageControls());
  if (f.shape === 'screen') return inspector.replaceChildren(...screenControls(f).filter(Boolean));

  const tabs = h('div.tabs', [['light', 'Light'], ['output', 'Output'], ['limits', 'Limits']].map(([k, label]) =>
    h('button', { class: page === k ? 'on' : '', onclick: () => { page = k; renderInspector(); } }, label)));
  const body = page === 'output' ? outputPage(f) : page === 'limits' ? limitsPage(f) : lightPage(f);
  inspector.replaceChildren(tabs, ...body.filter(Boolean));
}

function lightPage(f) {
  const set = (k, v, rerender) => { f[k] = v; update(f, rerender); };
  const line = ['line', 'string'].includes(f.shape);
  return [
    h('div.grid2',
      field('Name', h('input#fx-name', { type: 'text', value: f.name, oninput: (e) => { f.name = e.target.value; update(f); } })),
      field('Type', select(Object.entries(S.profiles).filter(([, v]) => v.shape !== 'screen').map(([k, v]) => [k, v.label]), f.kind, (v) => applyProfile(f, v), { id: 'fx-kind' })),
      field('Group', select([['floods', 'Floods'], ['strips', 'Strips'], ['strings', 'Strings'], ['bulbs', 'Bulbs']], f.group, (v) => set('group', v), { id: 'fx-group' })),
      field('Colour', select([['rgb', 'RGB'], ['mono', 'Single']], f.color, (v) => set('color', v, true), { id: 'fx-color' })),
      f.color === 'mono' ? field('Tint', h('input#fx-tint', { type: 'color', value: f.tint, onchange: (e) => set('tint', e.target.value) })) : null,
      line || f.pixels > 1 ? field(f.shape === 'string' ? 'Bulbs' : 'Pixels', h('input#fx-pixels', { type: 'number', min: 1, max: 1024, value: f.pixels,
        onchange: (e) => set('pixels', Math.max(1, Math.min(1024, parseInt(e.target.value) || 1))) })) : null,
      f.shape === 'flood' ? field('Aim', h('input#fx-angle', { type: 'number', step: 5, value: f.angle, onchange: (e) => set('angle', parseFloat(e.target.value)) })) : null,
      field('Size', h('input#fx-size', { type: 'range', min: 0.5, max: 2.5, step: 0.1, value: f.size || 1, oninput: (e) => set('size', parseFloat(e.target.value)) }))),
    actions(f),
  ];
}

function actions(f) {
  return h('div.bar-row',
    f.shape !== 'screen' ? h('button', { onclick: () => send('identify', { id: f.id }) }, 'Identify') : null,
    h('button', { onclick: () => send('fixture_duplicate', { id: f.id }) }, 'Copy'),
    h('button', { onclick: (e) => {
      const b = e.target;
      if (b.dataset.armed) return send('fixture_delete', { ids: [f.id] });
      b.dataset.armed = '1'; b.textContent = 'Sure?'; b.classList.add('alert');
    } }, 'Remove'));
}

/** Sets TVs side by side in a row, edge to edge, shrinking the row if it wouldn't fit on stage. */
function placeInRow(tvs) {
  const gap = 0.004;
  const size = Math.min(tvs[0].size || 1, (0.94 - gap * (tvs.length - 1)) / (tvs.length * TV_WIDTH));
  const w = TV_WIDTH * size;
  const total = tvs.length * w + gap * (tvs.length - 1);
  const mid = tvs.reduce((a, t) => a + t.x, 0) / tvs.length;
  const left = Math.max(0.03, Math.min(0.97 - total, mid - total / 2));
  tvs.forEach((t, i) => {
    t.size = size;
    t.x = left + w / 2 + i * (w + gap);
    t.y = tvs[0].y;
  });
}

function lineUp(wall) {
  const tvs = S.show.fixtures.filter((f) => f.shape === 'screen' && f.wall === wall).sort((a, b) => a.x - b.x);
  placeInRow(tvs);
  tvs.forEach((t) => update(t));
  renderInspector();
}

/** A new TV joins the one you're on, side by side, and extends its picture. The first TV stands alone. */
function addTV() {
  const screens = S.show.fixtures.filter((f) => f.shape === 'screen');
  const count = screens.length;
  if (!count) return send('fixture_add', { kind: 'tv', x: 0.5, y: 0.29, name: 'TV' });
  const anchor = fixture(S.sel)?.shape === 'screen' ? fixture(S.sel) : screens[count - 1];
  if (!anchor.wall) anchor.wall = GROUPS.find((g) => !screens.some((t) => t.wall === g)) || GROUPS[0];
  const row = screens.filter((t) => t.wall === anchor.wall).sort((a, b) => a.x - b.x);
  const next = { x: row[row.length - 1].x + 0.01, y: anchor.y, size: anchor.size || 1 };
  placeInRow([...row, next]);
  row.forEach((t) => update(t));
  send('fixture_add', { kind: 'tv', x: next.x, y: next.y, size: next.size, wall: anchor.wall, name: `TV ${count + 1}` });
}

function screenControls(f) {
  const setGroup = (g) => {
    f.wall = g;
    update(f, true);
  };
  return [
    h('div.row', h('span.lbl', 'Group'),
      h('div.seg', [['', 'None'], ...GROUPS.map((g) => [g, g])].map(([g, label]) =>
        h('button', { class: (f.wall || '') === g ? 'on' : '', onclick: () => setGroup(g) }, label)))),
    h('div.grid2',
      field('Name', h('input#fx-name', { type: 'text', value: f.name, oninput: (e) => { f.name = e.target.value; update(f); } })),
      field('Size', h('input#fx-size', { type: 'range', min: 0.4, max: 4, step: 0.05, value: f.size || 1, oninput: (e) => { f.size = parseFloat(e.target.value); update(f); } })),
      field('Delay ms', h('input#fx-delay', { type: 'number', min: 0, max: 500, step: 5, value: f.caps.latency_ms, title: 'The TV’s input lag. The picture is sent this much early.',
        onchange: (e) => { f.caps.latency_ms = Math.max(0, parseFloat(e.target.value) || 0); update(f); } }))),
    h('div.bar-row',
      f.wall ? h('button', { title: 'Set this group side by side', onclick: () => lineUp(f.wall) }, 'Line up') : null,
      h('button', { onclick: openTV }, 'Open'),
      h('button', { title: 'Add a TV next to this one', onclick: addTV }, 'Add TV'),
      h('button', { onclick: (e) => {
        const b = e.target;
        if (b.dataset.armed) return send('fixture_delete', { ids: [f.id] });
        b.dataset.armed = '1'; b.textContent = 'Sure?'; b.classList.add('alert');
      } }, 'Remove')),
    S.lan && S.lanUrls[0] ? h('code', `${S.lanUrls[0]}/tv?id=${f.id}`) : null,
  ];
}

function outputPage(f) {
  const p = f.patch;
  const setP = (k, v, rerender) => { p[k] = v; update(f, rerender); };
  return [
    field('Send via', select(PROTOCOLS, p.protocol || 'none', (v) => { f.patch = defaultPatch(v, p); update(f, true); }, { id: 'fx-proto' })),
    ...patchFields(f, setP),
  ];
}

function limitsPage(f) {
  const prof = S.profiles[f.kind] || {};
  return [
    ...CAPS.map(([k, label]) => h('label.row', h('span.lbl.wide', label), h('input', { type: 'number', min: 0, step: k === 'update_hz' ? 1 : 5, value: f.caps[k], id: `cap-${k}`,
      onchange: (e) => { f.caps[k] = Math.max(k === 'update_hz' ? 1 : 0, parseFloat(e.target.value) || 0); update(f, true); } }))),
    h('div.bar-row', h('button', { onclick: () => { f.caps = pickCaps(prof); update(f, true); } }, 'Reset')),
  ];
}

function stageControls() {
  const st = S.show.settings.stage;
  const stageSet = (patch) => send('settings', { patch: { stage: { ...st, ...patch } } });
  return [
    h('div.bar-row',
      h('label.btn', 'Photo', h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => loadBackground(e.target.files[0]) })),
      st.background ? h('button', { onclick: () => stageSet({ background: '' }) }, 'Remove') : null,
      h('button.toggle', { class: st.show_labels ? 'on' : '', onclick: () => stageSet({ show_labels: !st.show_labels }) }, 'Labels')),
    h('div.grid2',
      field('Shape', select([[1.7778, '16:9'], [1.3333, '4:3'], [2.3333, '21:9'], [1, '1:1']], st.aspect, (v) => stageSet({ aspect: parseFloat(v) }), { id: 'stage-aspect' })),
      field('Haze', h('input#stage-haze', { type: 'range', min: 0, max: 1, step: 0.05, value: st.haze ?? 0.5, oninput: (e) => stageSet({ haze: parseFloat(e.target.value) }) })),
      field('Room light', h('input#stage-room', { type: 'range', min: 0, max: 1, step: 0.05, value: st.room ?? 0.1, oninput: (e) => stageSet({ room: parseFloat(e.target.value) }) }))),
  ];
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
  };
  img.onerror = () => toast('Couldn’t read that image', true);
  img.src = URL.createObjectURL(file);
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
    const status = h('span.note');
    out.push(h('div.grid2',
      field('IP', h('input#fx-host', { type: 'text', value: p.host || '', placeholder: '192.168.1.50', onchange: (e) => setP('host', e.target.value.trim()) })),
      field('First pixel', h('input#fx-start', { type: 'number', min: 0, value: p.start || 0, onchange: (e) => setP('start', parseInt(e.target.value) || 0) }))),
    h('div.bar-row', h('button', { onclick: async () => {
      status.textContent = 'Checking';
      const [r] = await request('scan', { kind: 'wled', host: p.host });
      status.textContent = r?.ok ? `${r.name}: ${r.leds} LEDs` : r?.error || 'No answer';
    } }, 'Check'), status));
  } else if (p.protocol === 'govee' || p.protocol === 'wiz') {
    const res = h('div.bar-row');
    out.push(field('IP', h('input#fx-host', { type: 'text', value: p.host || '', placeholder: '192.168.1.60', onchange: (e) => setP('host', e.target.value.trim()) })),
      h('div.bar-row', h('button', { onclick: async (e) => {
        const b = e.target; b.disabled = true; b.textContent = 'Searching';
        const found = await request('scan', { kind: p.protocol });
        b.disabled = false; b.textContent = 'Find';
        res.replaceChildren(...(found.length && !found[0].error ? found.map((d) => h('button', { onclick: () => setP('host', d.host, true) }, `${d.name} ${d.host}`))
          : [h('span.note', found[0]?.error || 'None found.')]));
      } }, 'Find')), res);
  } else if (p.protocol === 'dmx') {
    const ifaces = S.show.settings.dmx_interfaces;
    const n = (p.channels || []).length * f.pixels;
    out.push(h('div.grid2',
      field('Interface', select(ifaces.map((d) => [d.id, `${d.id} ${d.type}`]), p.interface, (v) => setP('interface', v), { id: 'fx-iface' })),
      field('Address', h('input#fx-addr', { type: 'number', min: 1, max: 512, value: p.address || 1, onchange: (e) => setP('address', parseInt(e.target.value) || 1, true) })),
      field('Channels', h('input#fx-chans', { type: 'text', value: (p.channels || []).join(', '),
        title: 'dim r g b w strobe, or a number to hold a channel at that value',
        onchange: (e) => setP('channels', e.target.value.split(/[\s,]+/).filter(Boolean), true) })),
      field('Gamma', h('input#fx-gamma', { type: 'number', min: 1, max: 3, step: 0.1, value: p.gamma ?? 2.2, onchange: (e) => setP('gamma', parseFloat(e.target.value) || 1) }))),
    h('span.note', `Uses ${p.address} to ${p.address + n - 1}`));
  }
  return out;
}
