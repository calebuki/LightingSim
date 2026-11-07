// Play tab: scene pads and the live controls next to them.
import { S, send, beatNow, scene } from './state.js';
import { $, $$, h, on, select, showTab } from './util.js';
import { resolveVisual, visualName as nameOfVisual } from './visuals/library.js';
import { heldOn, openTV, toggleHold } from './tvpanel.js';

const TR_LABEL = { cut: 'Cut', fade: 'Fade', wipe: 'Wipe', iris: 'Iris', flash: 'Flash', dip: 'Dip' };
const Q_LABEL = { now: 'Now', beat: 'Next beat', bar: 'Next bar', '2bar': '2 bars', '4bar': '4 bars', '8bar': '8 bars' };
const GROUP_LABEL = { floods: 'Flood', strips: 'Strip', strings: 'String', bulbs: 'Bulb', screens: 'TV' };

let root, pads, ctl;
let dragId = null;

const settings = (patch) => send('settings', { patch });

export function initPlay() {
  root = $('#tab-play');
  on('init', render);
  on('scenes', renderPads);
  on('settings', renderCtl);
  on('palette', renderCtl);
  on('status', updateLive);
  (function loop() { progress(); requestAnimationFrame(loop); })();
}

function render() {
  pads = h('div#pads');
  ctl = h('div#ctl');
  root.replaceChildren(pads, ctl);
  renderPads();
  renderCtl();
}

export function visualName(sc) {
  return nameOfVisual(resolveVisual(sc?.visual).id);
}

function renderPads() {
  if (!pads) return;
  const list = S.show.bank.map(scene).filter(Boolean);
  const cols = Math.max(4, Math.ceil(Math.sqrt(list.length * 2)));
  pads.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  const filler = (cols - (list.length % cols)) % cols;
  pads.replaceChildren(
    ...list.map((sc, i) => {
      const el = h('button.pad', {
        'data-id': sc.id, draggable: true,
        onclick: (e) => send('launch', { scene: sc.id, quantize: e.shiftKey ? 'now' : undefined }),
        ondragstart: () => { dragId = sc.id; },
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => {
          e.preventDefault();
          if (!dragId || dragId === sc.id) return;
          const bank = S.show.bank.filter((x) => x !== dragId);
          bank.splice(bank.indexOf(sc.id), 0, dragId);
          S.show.bank = bank;
          send('bank_order', { ids: bank });
          renderPads();
        },
      },
      h('span.pad-name', sc.name),
      h('span.pad-vis', visualName(sc)),
      i < 9 ? h('span.pad-key', String(i + 1)) : null,
      h('i.pad-prog'));
      return el;
    }),
    ...Array.from({ length: filler }, () => h('div.pad-empty')));
  updateLive(S.status);
}

function updateLive(m) {
  if (!m || !pads) return;
  const e = m.engine;
  $$('.pad', pads).forEach((p) => {
    p.classList.toggle('on', p.dataset.id === e.current);
    p.classList.toggle('queued', !!e.queued && p.dataset.id === e.queued.scene);
  });
  $('#fx-strobe', ctl)?.classList.toggle('on', !!e.strobe);
  $('#fx-flash', ctl)?.classList.toggle('on', e.flash > 0);
  for (const g of Object.keys(GROUP_LABEL)) {
    const f = $(`#gl-${g}`, ctl);
    if (f && document.activeElement !== f) f.value = e.group_levels[g] ?? 1;
  }
  const n = $('#tv-visual', ctl);
  if (n) {
    const label = heldOn() ? visualName({ visual: S.show.settings.tv.held }) : visualName(scene(e.preview || e.current));
    if (n.textContent !== label) n.textContent = label;
  }
}

function progress() {
  if (!S.status || !pads || root.hidden) return;
  const cur = S.status.engine.current;
  const sc = scene(cur);
  const el = pads.querySelector(`.pad[data-id="${cur}"] .pad-prog`);
  $$('.pad-prog', pads).forEach((p) => p !== el && (p.style.width = '0'));
  if (el && sc) {
    const len = sc.bars * 4;
    el.style.width = `${(((beatNow() % len) + len) % len) / len * 100}%`;
  }
}

function hold(id, label, down, up) {
  const b = h(`button.hit#${id}`, label);
  const release = () => { b.classList.remove('held'); up(); };
  b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); b.classList.add('held'); down(); });
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  return b;
}

const row = (label, ...kids) => h('div.row', h('span.lbl', label), h('div.row-c', ...kids));

function renderCtl() {
  if (!ctl || !S.show) return;
  if (document.activeElement?.id === 'tv-energy') return; // don't rebuild the slider under the pointer
  const st = S.show.settings;
  const tr = st.transition || { type: 'fade', beats: 2 };
  const ap = st.autopilot || {};
  const tv = st.tv || {};
  const gl = S.status?.engine.group_levels || {};

  ctl.replaceChildren(
    h('div.col',
      h('div.hits',
        hold('fx-flash', 'Flash', () => send('flash', { value: 1 }), () => send('flash', { value: 0 })),
        hold('fx-strobe', 'Strobe', () => send('strobe', { on: true }), () => send('strobe', { on: false }))),
      row('Strobe',
        select([[4, '1/4'], [8, '1/8'], [16, '1/16'], [32, '1/32']], st.strobe_div, (v) => settings({ strobe_div: parseInt(v) }), { 'aria-label': 'Strobe rate' }),
        h('input', { type: 'color', value: st.flash_color, 'aria-label': 'Flash colour', onchange: (e) => settings({ flash_color: e.target.value }) })),
      row('Change',
        select(S.transitions.map((t) => [t, TR_LABEL[t] || t]), tr.type, (v) => settings({ transition: { ...tr, type: v } }), { 'aria-label': 'Transition' }),
        select([[0.5, '½ beat'], [1, '1 beat'], [2, '2 beats'], [4, '1 bar'], [8, '2 bars'], [16, '4 bars']], tr.beats, (v) => settings({ transition: { ...tr, beats: parseFloat(v) } }), { 'aria-label': 'Transition length' })),
      row('Launch',
        select(S.quantize.map((q) => [q, Q_LABEL[q] || q]), st.launch_quantize, (v) => settings({ launch_quantize: v }), { 'aria-label': 'Launch on' })),
      row('Auto',
        h('button.toggle', { class: ap.enabled ? 'on' : '', 'aria-pressed': !!ap.enabled, onclick: () => settings({ autopilot: { ...ap, enabled: !ap.enabled } }) }, ap.enabled ? 'On' : 'Off'),
        select([[4, '4 bars'], [8, '8 bars'], [16, '16 bars'], [32, '32 bars']], ap.every_bars || 16, (v) => settings({ autopilot: { ...ap, every_bars: parseInt(v) } }), { 'aria-label': 'Change every' })),
      row('Order',
        select([['shuffle', 'Shuffle'], ['sequence', 'In order']], ap.order || 'shuffle', (v) => settings({ autopilot: { ...ap, order: v } }), { 'aria-label': 'Order' }))),

    h('div.col',
      row('TV',
        h('button#tv-visual.link', { title: 'Open the visual library', onclick: () => showTab('tv') }, ''),
        h('button.toggle', { class: tv.hold ? 'on' : '', title: 'Keep this visual when scenes change (H)', onclick: toggleHold }, 'Hold'),
        h('button', { title: 'Open the TV picture in its own window', onclick: openTV }, 'Open')),
      row('Energy',
        h('input#tv-energy', { type: 'range', min: 0, max: 1, step: 0.01, value: tv.energy ?? 0.5, 'aria-label': 'TV energy',
          oninput: (e) => settings({ tv: { energy: parseFloat(e.target.value) } }) })),
      h('div.faders', Object.entries(GROUP_LABEL).map(([g, label]) =>
        h('label.fader',
          h('input', { type: 'range', id: `gl-${g}`, min: 0, max: 1, step: 0.01, value: gl[g] ?? 1,
            oninput: (e) => send('group_level', { group: g, value: parseFloat(e.target.value) }) }),
          h('span', label)))),
      h('div.palettes', S.palettes.map((p) =>
        h('button.pal', { class: p.name === S.show.palette.name ? 'on' : '', title: p.name, 'aria-label': p.name, onclick: () => send('palette', { palette: p }) },
          p.colors.map((c) => h('i', { style: { background: c } }))))),
      h('div.swatches', S.show.palette.colors.map((c, i) =>
        h('label.swatch', { style: { background: c } },
          h('input', { type: 'color', value: c, 'aria-label': `Colour ${i + 1}`,
            onchange: (e) => {
              const colors = [...S.show.palette.colors];
              colors[i] = e.target.value;
              send('palette', { palette: { name: 'Custom', colors } });
            } })))))
  );
  updateLive(S.status);
}
