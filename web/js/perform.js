// Perform tab (launch pads) + the always-visible live rail on the right.
import { S, send, beatNow, scene } from './state.js';
import { $, $$, h, on, select } from './util.js';

const TR_LABEL = { cut: 'Cut', fade: 'Crossfade', wipe: 'Wipe L→R', iris: 'Iris out', flash: 'White flash', dip: 'Dip to black' };
const Q_LABEL = { now: 'Instantly', beat: 'Next beat', bar: 'Next bar', '2bar': 'Next 2 bars', '4bar': 'Next 4 bars', '8bar': 'Next phrase' };

let root, rail;
let dragId = null;

export function initPerform() {
  root = $('#tab-perform');
  rail = $('#rail');
  on('init', render);
  on('scenes', renderPads);
  on('settings', renderRail);
  on('palette', renderRail);
  on('status', updateLive);
  (function loop() { progress(); requestAnimationFrame(loop); })();
}

function render() {
  root.replaceChildren(h('div.pads#pads'));
  renderPads();
  renderRail();
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
  const ap = $('#ap-enabled', rail);
  if (ap && document.activeElement !== ap) ap.checked = !!m.autopilot;
  $('#fx-strobe', rail)?.classList.toggle('held', !!e.strobe);
  for (const g of ['floods', 'strips', 'strings', 'bulbs']) {
    const f = $(`#gl-${g}`, rail);
    if (f && document.activeElement !== f) f.value = e.group_levels[g] ?? 1;
  }
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

const settings = (patch) => send('settings', { patch });

function renderRail() {
  if (!rail || !S.show) return;
  const st = S.show.settings;
  const tr = st.transition || { type: 'fade', beats: 2 };
  const ap = st.autopilot || {};
  const gl = S.status?.engine.group_levels || { floods: 1, strips: 1, strings: 1, bulbs: 1 };

  rail.replaceChildren(
    h('div.rsec',
      h('h4', 'Hits', h('small', 'hold · F / S')),
      h('div.momentary',
        momentary('fx-flash', 'FLASH', () => send('flash', { value: 1 }), () => send('flash', { value: 0 })),
        momentary('fx-strobe', 'STROBE', () => send('strobe', { on: true }), () => send('strobe', { on: false }))),
      h('div.two',
        select([[4, 'Strobe 1/4'], [8, 'Strobe 1/8'], [16, 'Strobe 1/16'], [32, 'Strobe 1/32']], st.strobe_div,
          (v) => settings({ strobe_div: parseInt(v) }), { id: 'strobe-div', 'aria-label': 'Strobe rate' }),
        h('label.row', { style: { gap: '6px', fontSize: '12px', color: 'var(--muted)' } },
          h('input#flash-color', { type: 'color', value: st.flash_color, onchange: (e) => settings({ flash_color: e.target.value }) }), 'Hit colour'))),

    h('div.rsec',
      h('h4', 'Transition'),
      h('div.two',
        select(S.transitions.map((t) => [t, TR_LABEL[t] || t]), tr.type,
          (v) => settings({ transition: { ...tr, type: v } }), { id: 'tr-type', 'aria-label': 'Transition style' }),
        select([[0.5, '½ beat'], [1, '1 beat'], [2, '2 beats'], [4, '1 bar'], [8, '2 bars'], [16, '4 bars']], tr.beats,
          (v) => settings({ transition: { ...tr, beats: parseFloat(v) } }), { id: 'tr-beats', 'aria-label': 'Transition length' })),
      h('div.two',
        h('span.muted', { style: { fontSize: '12px', alignSelf: 'center' } }, 'Launch on'),
        select(S.quantize.map((q) => [q, Q_LABEL[q] || q]), st.launch_quantize,
          (v) => settings({ launch_quantize: v }), { id: 'launch-q', 'aria-label': 'Launch on' }))),

    h('div.rsec',
      h('h4', 'Groups'),
      h('div.groups', ['floods', 'strips', 'strings', 'bulbs'].map((g) =>
        h('label.vfader', h('input', { type: 'range', min: 0, max: 1, step: 0.01, id: `gl-${g}`, value: gl[g] ?? 1,
          oninput: (e) => send('group_level', { group: g, value: parseFloat(e.target.value) }) }), g)))),

    h('div.rsec',
      h('h4', 'Autopilot', h('label.row', { style: { gap: '6px' } }, h('input#ap-enabled', { type: 'checkbox', checked: !!ap.enabled,
        'aria-label': 'Autopilot', onchange: (e) => settings({ autopilot: { ...ap, enabled: e.target.checked } }) }))),
      h('div.two',
        select([[4, 'Every 4 bars'], [8, 'Every 8 bars'], [16, 'Every 16 bars'], [32, 'Every 32 bars']], ap.every_bars || 16,
          (v) => settings({ autopilot: { ...ap, every_bars: parseInt(v) } }), { id: 'ap-every', 'aria-label': 'Autopilot interval' }),
        select([['shuffle', 'Shuffle'], ['sequence', 'Pad order']], ap.order || 'shuffle',
          (v) => settings({ autopilot: { ...ap, order: v } }), { id: 'ap-order', 'aria-label': 'Autopilot order' }))),

    h('div.rsec',
      h('h4', 'Palette', h('small', 'p0 – p3 · click to edit')),
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
