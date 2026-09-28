// Pattern editor: scenes -> tracks -> (effect x step gate), with live playhead
// and warnings when a light can't physically keep up with the subdivision.
import { S, send, beatNow, scene } from './state.js';
import { $, $$, DIV_LABEL, RATE_OPTS, clamp, clone, colorOf, debounce, field, h, on, select, toast, uid } from './util.js';

const GROUPS = ['floods', 'strips', 'strings', 'bulbs'];
const ENV = [['hold', 'Hold (steady)'], ['gate', 'Gate (hard on/off)'], ['decay', 'Flash + decay'], ['swell', 'Swell up'], ['smooth', 'Smooth glide'], ['sine', 'Pulse (sine)']];
const SPREAD = [['all', 'All together'], ['alternate', 'Alternate odd/even'], ['chase', 'Chase L→R'], ['bounce', 'Bounce chase'], ['fill', 'Fill up'], ['random', 'Random light'], ['odd', 'Odd lights only'], ['even', 'Even lights only']];
const FALLBACK = [['pulse', 'Pulse slower'], ['hold', 'Steady glow'], ['skip', 'Stay dark']];
const BLEND = [['max', 'Brightest wins'], ['add', 'Add'], ['over', 'Cover'], ['mask', 'Mask (cut out)']];
const AXIS = [['x', 'Left → right'], ['y', 'Top → bottom'], ['diag', 'Diagonal'], ['radial', 'Centre → out'], ['angle', 'Around centre'], ['rank', 'Light order'], ['u', 'Along each light']];
const FX = {
  solid: { label: 'Solid colour', colors: [1, 1], params: [] },
  cycle: { label: 'Colour cycle', colors: [2, 6], params: ['rate', 'fade', 'axis', 'spread'] },
  sweep: { label: 'Sweep / chase band', colors: [1, 2], params: ['rate', 'width', 'axis', 'bounce', 'reverse', 'bg'] },
  wave: { label: 'Wave', colors: [1, 2], params: ['rate', 'cycles', 'depth', 'axis', 'reverse'] },
  rainbow: { label: 'Rainbow', colors: [0, 0], params: ['rate', 'cycles', 'sat', 'axis', 'reverse'] },
  gradient: { label: 'Gradient', colors: [2, 6], params: ['rate', 'cycles', 'axis', 'scroll'] },
  sparkle: { label: 'Sparkle', colors: [1, 6], params: ['rate', 'density'] },
  split: { label: 'Split colours', colors: [2, 6], params: ['rate', 'segments'] },
  flicker: { label: 'Flicker / candle', colors: [1, 2], params: ['depth'] },
};
const PARAM = {
  rate: { label: 'Speed', kind: 'rate', def: 4 },
  fade: { label: 'Fade', kind: 'unit', def: 0.3 },
  width: { label: 'Width', kind: 'unit', def: 0.25 },
  depth: { label: 'Depth', kind: 'unit', def: 0.6 },
  density: { label: 'Density', kind: 'unit', def: 0.15 },
  bg: { label: 'Background', kind: 'unit', def: 0 },
  sat: { label: 'Saturation', kind: 'unit', def: 1 },
  cycles: { label: 'Repeats', kind: 'num', def: 1, step: 0.25, min: 0, max: 8 },
  spread: { label: 'Travel', kind: 'num', def: 0, step: 0.1, min: 0, max: 4 },
  segments: { label: 'Segments', kind: 'num', def: 0, step: 1, min: 0, max: 32 },
  axis: { label: 'Direction', kind: 'axis', def: 'x' },
  bounce: { label: 'Bounce', kind: 'bool', def: false },
  reverse: { label: 'Reverse', kind: 'bool', def: false },
  scroll: { label: 'Scroll', kind: 'bool', def: true },
};

let root, ed = null;
let selTrack = null; // id of the track whose settings are open
const grids = []; // {grid, cells, t, last} for the playhead
const sendScene = debounce(() => ed && send('scene_update', { scene: ed }), 90);

export function initPatterns() {
  root = $('#tab-patterns');
  on('init', loadEditor);
  on('scenes', (id) => {
    // another client (e.g. a phone) edited this scene, or it was added/deleted: reload
    if (!ed || !scene(ed.id) || S.editScene !== ed.id || (id === ed.id && JSON.stringify(scene(id)) !== JSON.stringify(ed))) loadEditor();
    else renderHead();
  });
  on('palette', () => ed && renderEditor());
  on('fixtures', () => ed && renderWarnings());
  on('status', () => ed && renderWarningsThrottled());
  (function loop() { playhead(); requestAnimationFrame(loop); })();
}

function commit(rerender = false) {
  const i = S.show.scenes.findIndex((s) => s.id === ed.id);
  if (i >= 0) S.show.scenes[i] = clone(ed);
  sendScene();
  if (rerender) renderEditor();
}

function newScene() {
  send('scene_add', { scene: {
    name: 'New scene', bars: 1, color: S.show.palette.colors[0], utility: false,
    tracks: [newTrack()],
  } });
}
function newTrack() {
  return { id: uid('tr'), name: 'Track', target: ['all'], effect: { type: 'solid', colors: ['p0'] },
    gate: { div: 1, bars: 1, steps: [1, 1, 1, 1], env: 'decay', duty: 0.6, spread: 'all', fallback: 'pulse', swing: 0 },
    level: 1, blend: 'max', mute: false, solo: false };
}

// ------------------------------------------------------------------ layout
function loadEditor() {
  if (!scene(S.editScene)) S.editScene = S.show.bank[0] || null;
  const sc = scene(S.editScene);
  ed = sc ? clone(sc) : null;
  if (ed && !ed.tracks.some((t) => t.id === selTrack)) selTrack = ed.tracks[0]?.id || null;
  renderEditor();
}

function renderEditor() {
  if (!root) return;
  grids.length = 0;
  if (!ed) {
    root.replaceChildren(h('div.pat', h('div.pat-head', h('button.btn.sm.primary', { onclick: newScene }, '+ New scene'),
      h('span.muted', 'No scenes yet.'))));
    return;
  }
  const t = ed.tracks.find((x) => x.id === selTrack);
  root.replaceChildren(h('div.pat',
    h('div.pat-head#pat-head'),
    h('div.trows', ed.tracks.map((tr, i) => trackRow(tr, i)),
      h('div.row', { style: { paddingLeft: '6px' } },
        h('button.btn.xs', { onclick: () => { const nt = newTrack(); ed.tracks.push(nt); selTrack = nt.id; commit(true); } }, '+ Add track'))),
    t ? trackPanel(t, ed.tracks.indexOf(t)) : null));
  renderHead();
  renderWarnings();
}

function renderHead() {
  const box = $('#pat-head', root);
  if (!box || !ed) return;
  const previewing = S.status?.engine.preview === ed.id;
  const opts = S.show.bank.map((id) => scene(id)).filter(Boolean).map((s) => [s.id, `${s.name}  (${s.bars} bar${s.bars > 1 ? 's' : ''})`]);
  box.replaceChildren(
    select(opts, ed.id, (v) => { S.editScene = v; selTrack = null; loadEditor(); }, { class: 'scene-pick', 'aria-label': 'Scene to edit' }),
    h('input.name#sc-name', { type: 'text', value: ed.name, 'aria-label': 'Scene name', oninput: (e) => { ed.name = e.target.value; commit(); } }),
    h('input#sc-color', { type: 'color', value: ed.color || '#ff2d95', title: 'Pad colour', onchange: (e) => { ed.color = e.target.value; commit(); } }),
    select([[1, 'Loop 1 bar'], [2, 'Loop 2 bars'], [4, 'Loop 4 bars'], [8, 'Loop 8 bars']], ed.bars, (v) => {
      ed.bars = parseInt(v);
      ed.tracks.forEach((x) => { if (x.gate.bars > ed.bars) resample(x, x.gate.div, ed.bars); });
      commit(true);
    }, { id: 'sc-bars', 'aria-label': 'Loop length', style: 'height:30px' }),
    h('label.check', { title: 'Utility pads (like Full White) are skipped by autopilot' },
      h('input#sc-utility', { type: 'checkbox', checked: !!ed.utility, onchange: (e) => { ed.utility = e.target.checked; commit(); } }), 'Utility'),
    h('span.grow'),
    h('button.btn.sm', { class: previewing ? 'on' : '', title: 'Play this scene on the rig while editing (overrides the live scene)',
      onclick: (e) => { const on = S.status?.engine.preview !== ed.id; send('preview', { scene: on ? ed.id : null }); e.target.classList.toggle('on', on); } }, 'Audition'),
    h('button.btn.sm', { onclick: () => send('launch', { scene: ed.id }) }, 'Launch'),
    h('button.btn.sm', { onclick: newScene }, '+ New'),
    h('button.btn.sm', { onclick: () => send('scene_add', { scene: { ...clone(ed), name: ed.name + ' copy' } }) }, 'Duplicate'),
    h('button.btn.sm', { onclick: (e) => confirmDelete(e.target) }, 'Delete'),
    h('button.btn.sm.ghost', { onclick: () => send('restore_presets'), title: 'Bring back any built-in presets you deleted' }, 'Restore presets'));
}

function confirmDelete(btn) {
  if (btn.dataset.armed) { send('scene_delete', { id: ed.id }); return; }
  btn.dataset.armed = '1';
  btn.textContent = 'Really delete?';
  btn.classList.add('danger');
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Delete'; btn.classList.remove('danger'); } }, 3000);
}

function maxBarsFor(div) { return [8, 4, 2, 1].find((b) => b * 4 * div <= 128 && b <= ed.bars) || 1; }

/** Change subdivision/length but keep the rhythm where it was in time. */
function resample(t, div, bars) {
  const g = t.gate;
  const oldN = g.steps.length, oldDiv = g.div;
  const n = bars * 4 * div;
  const out = [];
  for (let i = 0; i < n; i++) {
    const beat = i / div;
    const j = Math.floor(beat * oldDiv + 1e-6);
    const ratio = oldDiv / div;
    if (Number.isInteger(ratio) && ratio > 1) {
      // coarser: a new step is lit if any old step inside it was
      let m = 0;
      for (let q = 0; q < ratio; q++) m = Math.max(m, g.steps[(j + q) % oldN]);
      out.push(m);
    } else {
      // finer: only the first sub-step of an old step inherits the hit
      const onGrid = Math.abs(beat * oldDiv - j) < 1e-6;
      out.push(onGrid ? g.steps[j % oldN] : 0);
    }
  }
  g.div = div; g.bars = bars; g.steps = out;
}

function targetLabel(t) {
  const tg = t.target?.length ? t.target : ['all'];
  return tg.includes('all') ? 'All lights' : tg.map((g) => g[0].toUpperCase() + g.slice(1)).join(' + ');
}

// ------------------------------------------------------------------ one row per track
function trackRow(t, i) {
  const g = t.gate;
  const pal = S.show.palette.colors;
  const c0 = t.effect.type === 'rainbow' ? 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' : colorOf((t.effect.colors || ['p0'])[0], pal);
  const row = h('div.trow', { class: [t.id === selTrack ? 'sel' : '', t.mute ? 'muted-t' : ''].join(' '), 'data-track': t.id },
    h('button.tlabel', { onclick: () => { selTrack = t.id; renderEditor(); }, title: 'Edit this track' },
      h('span.dotc', { style: { background: c0 } }),
      h('b', t.name), h('small', `${targetLabel(t)} · ${DIV_LABEL[g.div]}`), h('span.wicon.warn', { hidden: true, title: 'Some lights can’t keep up' }, '')),
    stepGrid(t),
    h('div.trow-tools',
      h('button.btn.xs', { class: t.mute ? 'on' : '', title: 'Mute', onclick: () => { t.mute = !t.mute; commit(true); } }, 'M'),
      h('button.btn.xs', { class: t.solo ? 'on' : '', title: 'Solo', onclick: () => { t.solo = !t.solo; commit(true); } }, 'S'),
      h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: t.level, title: 'Track level', 'aria-label': `${t.name} level`, style: { width: '70px' },
        oninput: (e) => { t.level = parseFloat(e.target.value); commit(); } })));
  return row;
}

// ------------------------------------------------------------------ settings panel for the selected track
function trackPanel(t, i) {
  const g = t.gate;
  const target = t.target?.length ? t.target : ['all'];
  const setTarget = (grp) => {
    if (grp === 'all') t.target = ['all'];
    else {
      let s = target.filter((x) => x !== 'all');
      s = s.includes(grp) ? s.filter((x) => x !== grp) : [...s, grp];
      t.target = s.length ? s : ['all'];
    }
    commit(true);
  };
  const maxBars = maxBarsFor(g.div);
  const fill = (fn) => () => { fn(); commit(true); };
  return h('div.tpanel',
    h('div.ctl',
      field('Track', h('input.tname', { type: 'text', value: t.name, oninput: (e) => { t.name = e.target.value; commit(); } })),
      h('span.chips', ['all', ...GROUPS].map((grp) =>
        h('button.chip', { class: target.includes(grp) ? 'on' : '', onclick: () => setTarget(grp) }, grp === 'all' ? 'All' : grp[0].toUpperCase() + grp.slice(1)))),
      field('Step', select(S.divs.map((d) => [d, DIV_LABEL[d]]), g.div, (v) => { const d = parseInt(v); resample(t, d, Math.min(g.bars, maxBarsFor(d))); commit(true); })),
      field('Length', select([1, 2, 4, 8].filter((b) => b <= maxBars).map((b) => [b, `${b} bar${b > 1 ? 's' : ''}`]), Math.min(g.bars, maxBars),
        (v) => { resample(t, g.div, parseInt(v)); commit(true); })),
      field('Envelope', select(ENV, g.env, (v) => { g.env = v; commit(); renderWarnings(); })),
      field('On %', h('input', { type: 'number', min: 5, max: 100, step: 5, value: Math.round((g.duty ?? 0.5) * 100),
        title: 'Gate on-time or decay length, as % of a step', onchange: (e) => { g.duty = clamp(e.target.value / 100, 0.05, 1); commit(); renderWarnings(); } })),
      field('Spread', select(SPREAD, g.spread, (v) => { g.spread = v; commit(); })),
      field('Slow lights', select(FALLBACK, g.fallback, (v) => { g.fallback = v; commit(); renderWarnings(); }, { title: 'What lights that can’t switch this fast should do' })),
      g.div % 2 === 0 ? field('Swing %', h('input', { type: 'number', min: 0, max: 60, step: 5, value: Math.round((g.swing || 0) * 100),
        onchange: (e) => { g.swing = clamp(e.target.value / 100, 0, 0.6); commit(); } })) : null,
      field('Mix', select(BLEND, t.blend || 'max', (v) => { t.blend = v; commit(); }, { title: 'How this track mixes with the ones above' })),
      h('span.row', { style: { gap: '3px', alignSelf: 'end' } },
        h('button.btn.xs', { title: 'Move up', disabled: i === 0, onclick: () => { ed.tracks.splice(i - 1, 0, ed.tracks.splice(i, 1)[0]); commit(true); } }, '↑'),
        h('button.btn.xs', { title: 'Move down', disabled: i === ed.tracks.length - 1, onclick: () => { ed.tracks.splice(i + 1, 0, ed.tracks.splice(i, 1)[0]); commit(true); } }, '↓'),
        h('button.btn.xs', { title: 'Duplicate track', onclick: () => { const c = { ...clone(t), id: uid('tr'), name: t.name + ' 2' }; ed.tracks.splice(i + 1, 0, c); selTrack = c.id; commit(true); } }, '⧉'),
        h('button.btn.xs', { title: 'Delete track', onclick: () => { ed.tracks.splice(i, 1); selTrack = ed.tracks[Math.max(0, i - 1)]?.id; commit(true); } }, '✕'))),
    effectRow(t),
    h('div.step-tools',
      h('span.muted', { style: { fontSize: '11px', marginRight: '4px' } }, 'Steps:'),
      ...[['All', () => g.steps.fill(1)], ['None', () => g.steps.fill(0)],
        ['Beats', () => g.steps.forEach((_, k) => (g.steps[k] = k % g.div === 0 ? 1 : 0))],
        ['Offbeats', () => g.steps.forEach((_, k) => (g.steps[k] = g.div >= 2 && k % g.div === g.div / 2 ? 1 : 0))],
        ['2 & 4', () => g.steps.forEach((_, k) => (g.steps[k] = k % g.div === 0 && Math.floor(k / g.div) % 2 === 1 ? 1 : 0))],
        ['Invert', () => g.steps.forEach((v, k) => (g.steps[k] = v > 0 ? 0 : 1))],
        ['◀', () => g.steps.push(g.steps.shift())], ['▶', () => g.steps.unshift(g.steps.pop())],
        ['Random', () => g.steps.forEach((_, k) => (g.steps[k] = Math.random() < 0.35 ? (Math.random() < 0.3 ? 0.5 : 1) : 0))],
      ].map(([label, fn]) => h('button.btn.xs', { onclick: fill(fn) }, label)),
      h('span.muted', { style: { fontSize: '11px', marginLeft: '6px' } }, 'Click/drag the grid to paint · Shift or right-click = half')),
    h('div.warnings', { 'data-track': t.id }));
}

function stepGrid(t) {
  const g = t.gate;
  const n = g.steps.length;
  const grid = h('div.steps', { style: { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` } });
  const cells = g.steps.map((v, k) => h('div.step', {
    'data-k': k,
    class: [k % (g.div * 4) === 0 ? 'bar' : k % g.div === 0 ? 'beat' : '', v >= 0.99 ? 'v1' : v > 0 ? 'vh' : ''].join(' '),
  }));
  grid.append(...cells);
  let paint = null;
  const apply = (cell) => {
    const k = +cell.dataset.k;
    if (g.steps[k] === paint) return;
    g.steps[k] = paint;
    cell.classList.toggle('v1', paint >= 0.99);
    cell.classList.toggle('vh', paint > 0 && paint < 0.99);
  };
  grid.addEventListener('contextmenu', (e) => e.preventDefault());
  grid.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.step');
    if (!cell) return;
    e.preventDefault();
    if (selTrack !== t.id) { selTrack = t.id; root.querySelectorAll('.trow').forEach((r) => r.classList.toggle('sel', r.dataset.track === t.id)); }
    const cur = g.steps[+cell.dataset.k];
    const half = e.shiftKey || e.button === 2;
    paint = cur > 0 && (!half || cur < 0.99) ? 0 : half ? 0.5 : 1;
    apply(cell);
    grid.setPointerCapture(e.pointerId);
  });
  grid.addEventListener('pointermove', (e) => {
    if (paint == null) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el.parentElement === grid) apply(el);
  });
  const end = () => {
    if (paint == null) return;
    paint = null;
    commit();
    if (!root.querySelector(`.tpanel .warnings[data-track="${t.id}"]`)) renderEditor(); // switched track: show its settings
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
  grids.push({ grid, cells, t, last: -1 });
  return grid;
}

function effectRow(t) {
  const fx = t.effect;
  const def = FX[fx.type] || FX.solid;
  const row = h('div.ctl',
    field('Look', select(Object.entries(FX).map(([k, v]) => [k, v.label]), fx.type, (v) => {
      const d = FX[v];
      const keep = fx.colors || ['p0'];
      t.effect = { type: v, colors: d.colors[1] ? keep.slice(0, d.colors[1]) : [] };
      while (t.effect.colors.length < d.colors[0]) t.effect.colors.push(`p${t.effect.colors.length % 4}`);
      d.params.forEach((p) => (t.effect[p] = fx[p] ?? PARAM[p].def));
      commit(true);
    })));
  if (def.colors[1] > 0) row.append(field('Colours', colorChips(t)));
  for (const p of def.params) {
    const P = PARAM[p];
    const val = fx[p] ?? P.def;
    const set = (v) => { fx[p] = v; commit(); };
    let ctl;
    if (P.kind === 'rate') ctl = select(RATE_OPTS, val, (v) => set(parseFloat(v)));
    else if (P.kind === 'axis') ctl = select(AXIS, val, set);
    else if (P.kind === 'bool') ctl = h('input', { type: 'checkbox', checked: !!val, onchange: (e) => set(e.target.checked), style: { height: '28px' } });
    else if (P.kind === 'unit') ctl = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: val, style: { width: '84px', height: '28px' }, oninput: (e) => set(parseFloat(e.target.value)) });
    else ctl = h('input', { type: 'number', min: P.min, max: P.max, step: P.step, value: val, onchange: (e) => set(parseFloat(e.target.value)) });
    row.append(field(P.label, ctl));
  }
  return row;
}

function colorChips(t) {
  const fx = t.effect;
  const [min, max] = FX[fx.type].colors;
  const pal = S.show.palette.colors;
  const wrap = h('div.colors');
  fx.colors.forEach((c, i) => {
    wrap.append(h('button.cchip', { style: { background: colorOf(c, pal) }, title: c,
      onclick: (e) => colorMenu(e.currentTarget, c, (nc) => { if (nc == null) fx.colors.splice(i, 1); else fx.colors[i] = nc; commit(true); }, fx.colors.length > min) },
    /^p\d$/.test(c) ? c : ''));
  });
  if (fx.colors.length < max) wrap.append(h('button.btn.xs', { onclick: () => { fx.colors.push(`p${fx.colors.length % 4}`); commit(true); } }, '+'));
  return wrap;
}

function colorMenu(anchor, cur, done, canRemove) {
  document.querySelector('.cmenu')?.remove();
  const pal = S.show.palette.colors;
  const r = anchor.getBoundingClientRect();
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  const pick = (v) => { close(); done(v); };
  const custom = /^#/.test(cur) ? cur : colorOf(cur, pal);
  const menu = h('div.cmenu', { style: { left: `${Math.min(r.left, innerWidth - 240)}px`, top: `${Math.max(8, r.top - 118)}px` } },
    h('div.muted', { style: { fontSize: '11px' } }, 'Palette slots follow the palette you pick in Perform'),
    h('div.row', pal.slice(0, 4).map((c, i) => h('button.cchip', { style: { background: c }, onclick: () => pick(`p${i}`) }, `p${i}`)),
      h('button.cchip', { style: { background: '#fff' }, onclick: () => pick('white') }, 'W')),
    h('div.row', h('input', { type: 'color', value: custom, onchange: (e) => pick(e.target.value) }), h('span.muted', { style: { fontSize: '12px' } }, 'Fixed colour'),
      canRemove ? h('button.btn.xs', { style: { marginLeft: 'auto' }, onclick: () => pick(null) }, 'Remove') : null));
  document.body.append(menu);
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
}

// ------------------------------------------------------------------ physical limits
function divisors(d) { const o = []; for (let c = 1; c <= d; c++) if (d % c === 0) o.push(c); return o; }
function fmtDiv(d) { return d === 1 ? '1-beat' : DIV_LABEL[d].replace(' trip', '-triplet'); }

export function analyzeTrack(t) {
  const st = S.show.settings;
  const bpm = (S.status?.clock.bpm || S.bpm || 120) * (S.status?.clock.speed || 1);
  const beatMs = 60000 / bpm;
  const fps = st.fps || 60;
  const cap = st.max_flash_hz || 0;
  const g = t.gate;
  const k = g.env === 'gate' ? Math.max(0.05, Math.min(g.duty, 1 - g.duty)) : ['decay', 'swell'].includes(g.env) ? 0.5 : 1;
  const tgt = t.target?.length ? t.target : ['all'];
  const fxs = S.show.fixtures.filter((f) => tgt.includes('all') || tgt.includes(f.group) || tgt.includes(f.id));
  if (!fxs.length) return [{ info: true, text: 'No lights in this target yet. Add some in the Rig tab.' }];
  const groups = new Map();
  for (const f of fxs) {
    const mp = Math.max(f.caps.min_pulse_ms, cap > 0 ? 500 / cap : 0);
    const up = 980 / Math.min(f.caps.update_hz, fps);
    let c = 1;
    for (const d of divisors(g.div)) { const step = beatMs / d; if (step * k >= mp && step >= up) c = d; }
    if (c < g.div) (groups.get(c) || groups.set(c, []).get(c)).push(f.name);
  }
  const out = [];
  const what = { pulse: (c) => `pulse at ${fmtDiv(c)} instead`, hold: () => 'hold a steady glow instead', skip: () => 'stay dark for this track' };
  for (const [c, names] of groups) {
    const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
    out.push({ text: `${list} can’t switch at ${fmtDiv(g.div)} (${Math.round(bpm)} BPM) → will ${what[g.fallback || 'pulse'](c)}` });
  }
  return out;
}

function renderWarnings() {
  if (!ed) return;
  for (const t of ed.tracks) {
    const box = root.querySelector(`.warnings[data-track="${t.id}"]`);
    if (!box) continue; // only the open track shows its warnings in full
    const ws = analyzeTrack(t);
    const key = JSON.stringify(ws);
    if (box.dataset.key === key) continue;
    box.dataset.key = key;
    box.replaceChildren(...ws.map((w) => h('div.warn', { class: w.info ? 'info' : '' }, w.text)));
  }
  for (const t of ed.tracks) {
    const icon = root.querySelector(`.trow[data-track="${t.id}"] .wicon`);
    if (icon) icon.hidden = !analyzeTrack(t).some((w) => !w.info);
  }
}
let lastWarn = 0;
function renderWarningsThrottled() {
  const now = performance.now();
  if (now - lastWarn > 1000) { lastWarn = now; renderWarnings(); }
}

// ------------------------------------------------------------------ playhead
function playhead() {
  if (!root || root.hidden || !grids.length) return;
  const b = beatNow();
  for (const gr of grids) {
    const g = gr.t.gate;
    const n = gr.cells.length;
    const k = ((Math.floor(b * g.div) % n) + n) % n;
    if (k === gr.last) continue;
    gr.cells[gr.last]?.classList.remove('play');
    gr.cells[k]?.classList.add('play');
    gr.last = k;
  }
}
