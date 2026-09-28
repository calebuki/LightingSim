// Perform tab: launch pads, transitions, momentary FX, group faders, autopilot, palette.
import { S, send, beatNow, scene } from './state.js';
import { $, $$, field, h, on, select } from './util.js';

const TR_LABEL = { cut: 'Cut', fade: 'Crossfade', wipe: 'Wipe L→R', iris: 'Iris out', flash: 'White flash', dip: 'Dip to black' };
const Q_LABEL = { now: 'Instantly', beat: 'Next beat', bar: 'Next bar', '2bar': 'Next 2 bars', '4bar': 'Next 4 bars', '8bar': 'Next phrase (8)' };

let root;
let dragId = null;

export function initPerform() {
  root = $('#tab-perform');
  on('init', render);
  on('scenes', renderPads);
  on('settings', renderSide);
  on('palette', renderSide);
  on('status', updateLive);
  (function loop() { progress(); requestAnimationFrame(loop); })();
}

function render() {
  root.replaceChildren(h('div.perform', h('div.pads#pads'), h('div.side#perform-side')));
  renderPads();
  renderSide();
}

function renderPads() {
  const pads = $('#pads', root);
  if (!pads) return;
  pads.replaceChildren(...S.show.bank.map((id, i) => {
    const sc = scene(id);
    if (!sc) return null;
    const el = h('button.pad', {
      'data-id': id, draggable: true, class: sc.utility ? 'utility' : '',
      style: { '--c': sc.color || 'var(--accent)' },
      title: 'Click: launch on the next boundary · Shift+click: launch now · drag to reorder',
      onclick: (e) => send('launch', { scene: id, quantize: e.shiftKey ? 'now' : undefined }),
      ondragstart: () => { dragId = id; el.classList.add('dragging'); },
      ondragend: () => el.classList.remove('dragging'),
      ondragover: (e) => e.preventDefault(),
      ondrop: (e) => {
        e.preventDefault();
        if (!dragId || dragId === id) return;
        const bank = S.show.bank.filter((x) => x !== dragId);
        bank.splice(bank.indexOf(id), 0, dragId);
        S.show.bank = bank;
        send('bank_order', { ids: bank });
        renderPads();
      },
    },
    h('span.pad-name', sc.name),
    h('span.pad-meta', h('span', `${sc.bars} bar${sc.bars > 1 ? 's' : ''} · ${sc.tracks.length} trk`), h('span.pad-key', i < 9 ? String(i + 1) : '')),
    h('span.pad-prog'));
    return el;
  }));
  updateLive(S.status);
}

function updateLive(m) {
  if (!m || !root) return;
  const e = m.engine;
  $$('.pad', root).forEach((p) => {
    p.classList.toggle('active', p.dataset.id === e.current);
    p.classList.toggle('queued', !!e.queued && p.dataset.id === e.queued.scene);
  });
  const ap = $('#ap-enabled', root);
  if (ap && document.activeElement !== ap) ap.checked = !!m.autopilot;
  const fl = $('#fx-strobe', root);
  if (fl) fl.classList.toggle('held', !!e.strobe);
}

// loop position bar on the active pad
function progress() {
  if (!S.status || !root || root.hidden) return;
  const cur = S.status.engine.current;
  const sc = scene(cur);
  const el = root.querySelector(`.pad[data-id="${cur}"] .pad-prog`);
  $$('.pad-prog', root).forEach((p) => p !== el && (p.style.width = '0'));
  if (el && sc) {
    const len = sc.bars * 4;
    const b = beatNow();
    el.style.width = `${(((b % len) + len) % len) / len * 100}%`;
  }
}

function momentary(id, label, down, up) {
  const b = h(`button.btn#${id}`, label);
  const release = () => { b.classList.remove('held'); up(); };
  b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); b.classList.add('held'); down(); });
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  return b;
}

function renderSide() {
  const side = $('#perform-side', root);
  if (!side) return;
  const st = S.show.settings;
  const tr = st.transition || { type: 'fade', beats: 2 };
  const ap = st.autopilot || {};
  const gl = S.status?.engine.group_levels || { floods: 1, strips: 1, strings: 1, bulbs: 1 };

  side.replaceChildren(
    h('div.card',
      h('h4', 'Transition'),
      h('div.row',
        field('Style', select(S.transitions.map((t) => [t, TR_LABEL[t] || t]), tr.type,
          (v) => send('settings', { patch: { transition: { ...tr, type: v } } }), { id: 'tr-type' }), 'grow'),
        field('Length', select([[0.5, '½ beat'], [1, '1 beat'], [2, '2 beats'], [4, '1 bar'], [8, '2 bars'], [16, '4 bars']], tr.beats,
          (v) => send('settings', { patch: { transition: { ...tr, beats: parseFloat(v) } } }), { id: 'tr-beats' }))),
      field('Launch on', select(S.quantize.map((q) => [q, Q_LABEL[q] || q]), st.launch_quantize,
        (v) => send('settings', { patch: { launch_quantize: v } }), { id: 'launch-q' }))),

    h('div.card',
      h('h4', 'Hits', h('span.muted', { style: { letterSpacing: 0, textTransform: 'none', fontWeight: 400 } }, 'hold')),
      h('div.momentary',
        momentary('fx-flash', 'FLASH', () => send('flash', { value: 1 }), () => send('flash', { value: 0 })),
        momentary('fx-strobe', 'STROBE', () => send('strobe', { on: true }), () => send('strobe', { on: false }))),
      h('div.row',
        field('Strobe rate', select([[4, '1/4'], [8, '1/8'], [16, '1/16'], [32, '1/32']], st.strobe_div,
          (v) => send('settings', { patch: { strobe_div: parseInt(v) } }), { id: 'strobe-div' }), 'grow'),
        field('Hit colour', h('input#flash-color', { type: 'color', value: st.flash_color,
          onchange: (e) => send('settings', { patch: { flash_color: e.target.value } }) })))),

    h('div.card',
      h('h4', 'Groups'),
      h('div.groups', ['floods', 'strips', 'strings', 'bulbs'].map((g) =>
        h('label.vfader', h('input', { type: 'range', min: 0, max: 1, step: 0.01, id: `gl-${g}`, value: gl[g] ?? 1,
          oninput: (e) => send('group_level', { group: g, value: parseFloat(e.target.value) }) }), g)))),

    h('div.card',
      h('h4', 'Autopilot'),
      h('label.check', h('input#ap-enabled', { type: 'checkbox', checked: !!ap.enabled,
        onchange: (e) => send('settings', { patch: { autopilot: { ...ap, enabled: e.target.checked } } }) }),
        'Change scenes on phrase boundaries'),
      h('div.row',
        field('Every', select([[4, '4 bars'], [8, '8 bars'], [16, '16 bars'], [32, '32 bars']], ap.every_bars || 16,
          (v) => send('settings', { patch: { autopilot: { ...ap, every_bars: parseInt(v) } } }), { id: 'ap-every' }), 'grow'),
        field('Order', select([['shuffle', 'Shuffle'], ['sequence', 'Pad order']], ap.order || 'shuffle',
          (v) => send('settings', { patch: { autopilot: { ...ap, order: v } } }), { id: 'ap-order' }), 'grow')),
      h('p.muted', { style: { margin: 0, fontSize: '12px' } }, 'Skips utility pads (Full White, Dark). Align the phrase with PHR so changes land on the drop.')),

    h('div.card',
      h('h4', 'Palette', h('span.muted', { style: { letterSpacing: 0, textTransform: 'none', fontWeight: 400 } }, 'p0 – p3')),
      h('div.swatches', S.show.palette.colors.map((c, i) =>
        h('label.swatch', { style: { background: c }, title: `p${i}` },
          h('input', { type: 'color', value: c, 'aria-label': `Palette colour p${i}`,
            onchange: (e) => {
              const colors = [...S.show.palette.colors];
              colors[i] = e.target.value;
              send('palette', { palette: { name: 'Custom', colors } });
            } })))),
      h('div.pal-list', S.palettes.map((p) =>
        h('button.pal-chip', { class: p.name === S.show.palette.name ? 'on' : '', onclick: () => send('palette', { palette: p }) },
          h('i', p.colors.map((c) => h('b', { style: { background: c } }))), p.name)))),
  );
}
