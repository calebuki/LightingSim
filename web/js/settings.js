// Sync & Settings tab.
import { S, send, request, scene } from './state.js';
import { $, field, h, on, select, toast } from './util.js';

let root;
let lastLearned = null;

const CONTROLS = [
  ['master', 'Master fader'], ['flash', 'Flash (hold)'], ['strobe', 'Strobe (hold)'], ['blackout', 'Blackout toggle'],
  ['tap', 'Tap tempo'], ['next', 'Next scene'], ['prev', 'Previous scene'], ['align_bar', 'Align bar (the 1)'],
  ['align_phrase', 'Align phrase'], ['autopilot', 'Autopilot on/off'],
  ['group:floods', 'Floods fader'], ['group:strips', 'Strips fader'], ['group:strings', 'Strings fader'], ['group:bulbs', 'Bulbs fader'],
];

export function initSettings() {
  root = $('#tab-settings');
  on('init', render);
  on('settings', render);
  on('scenes', () => !root.hidden && render());
  on('status', (m) => {
    if (m.learned && JSON.stringify(m.learned) !== JSON.stringify(lastLearned)) {
      lastLearned = m.learned;
      toast(`Mapped ${m.learned.key} → ${labelFor(m.learned.target)}`);
    }
    root.querySelectorAll('[data-learn]').forEach((b) => b.classList.toggle('learning', b.dataset.learn === m.learn));
    const src = $('#sync-status', root);
    if (src) src.textContent = m.clock.detail;
    root.querySelectorAll('[data-dmx]').forEach((el) => {
      const d = m.outputs.dmx[el.dataset.dmx];
      el.className = 'tag ' + (!d || d.type === 'none' ? 'off' : d.ok ? 'ok' : 'warn');
      el.textContent = !d || d.type === 'none' ? 'off' : d.ok ? 'connected' : (d.error || 'not connected');
    });
  });
}

function labelFor(t) {
  if (t?.startsWith('scene:')) return `Launch “${scene(t.slice(6))?.name || '?'}”`;
  return CONTROLS.find(([k]) => k === t)?.[1] || t;
}
const patch = (p) => send('settings', { patch: p });

function render() {
  if (!S.show || !root) return;
  const st = S.show.settings;
  root.replaceChildren(h('div.settings',
    syncCard(st), midiCard(st), dmxCard(st), safetyCard(st), showCard(), remoteCard(st)));
}

function syncCard(st) {
  const opt = (v, title, sub) => h('label.src',
    h('input', { type: 'radio', name: 'clock', value: v, checked: st.clock_source === v, onchange: () => patch({ clock_source: v }) }),
    h('strong', title), h('small', sub));
  return h('div.card',
    h('h4', 'Sync to rekordbox'),
    h('p.mono#sync-status', { style: { fontSize: '12px' } }, ''),
    h('div.src-options',
      opt('link', 'Ableton Link (recommended)', 'Tempo and bar position straight from rekordbox over your network. Free, no cables.'),
      opt('midi', 'MIDI clock', 'For DJ software, drum machines or mixers that send MIDI clock.'),
      opt('internal', 'Manual / tap tempo', 'Type the BPM or tap along. Works with anything, even vinyl.')),
    st.clock_source === 'link' ? h('ol',
      h('li', 'In rekordbox switch to ', h('b', 'PERFORMANCE'), ' mode.'),
      h('li', 'Click ', h('b', 'LINK'), ' at the top of the screen so it lights up (rekordbox 6+). If it’s missing, search rekordbox’s Preferences for “Link”.'),
      h('li', 'Make the playing deck the tempo ', h('b', 'MASTER'), '. LightingSim follows its BPM and bar phase.'),
      h('li', 'If the lights land on beat 3 instead of 1, press ', h('b', '1'), ' in the top bar on a downbeat. Press ', h('b', 'PHR'), ' on the first beat of a drop to line up 8-bar loops.')) : null,
    st.clock_source === 'midi' ? h('p', 'Choose the MIDI input that sends clock in the MIDI card. rekordbox itself doesn’t send MIDI clock; use Link for rekordbox.') : null);
}

function midiCard(st) {
  const inputs = S.midiInputs || [];
  const map = st.midi_map || {};
  const keyFor = (t) => Object.entries(map).find(([, v]) => v === t)?.[0];
  const row = (t, label) => {
    const k = keyFor(t);
    return h('div.map-row',
      h('span.grow', label), h('code', k || '—'),
      h('button.btn.xs', { 'data-learn': t, onclick: () => send('midi_learn', { target: S.status?.learn === t ? null : t }) }, 'Learn'),
      k ? h('button.btn.xs', { onclick: () => send('midi_unmap', { key: k }) }, '✕') : null);
  };
  return h('div.card',
    h('h4', 'MIDI controllers', h('button.btn.xs', { onclick: async () => { S.midiInputs = await request('scan', { kind: 'midi' }); render(); } }, 'Refresh')),
    S.midiError ? h('p', S.midiError) : null,
    inputs.length ? h('div', { style: { display: 'grid', gap: '4px' } }, inputs.map((n) =>
      h('label.check', h('input', { type: 'checkbox', checked: (st.midi_inputs || []).includes(n),
        onchange: (e) => patch({ midi_inputs: e.target.checked ? [...(st.midi_inputs || []), n] : (st.midi_inputs || []).filter((x) => x !== n) }) }), n)))
      : h('p', 'No MIDI devices found. Plug in a pad controller or your DJ controller and press Refresh.'),
    h('p', 'Press Learn, then hit a pad, key or knob. Pads launch scenes; faders and knobs work for master, flash and group levels.'),
    h('div.map-list',
      CONTROLS.map(([t, l]) => row(t, l)),
      S.show.bank.slice(0, 32).map((id) => row(`scene:${id}`, `Launch “${scene(id)?.name}”`))));
}

function dmxCard(st) {
  const ifaces = st.dmx_interfaces || [];
  const ports = S.serialPorts || [];
  const setIface = (i, k, v) => { const list = ifaces.map((d) => ({ ...d })); list[i][k] = v; patch({ dmx_interfaces: list }); };
  return h('div.card',
    h('h4', 'DMX interfaces', h('button.btn.xs', { onclick: async () => { S.serialPorts = await request('scan', { kind: 'serial' }); render(); } }, 'Rescan USB')),
    ...ifaces.map((d, i) => h('div', { style: { display: 'grid', gap: '8px', paddingBottom: '8px', borderBottom: '1px solid var(--line)' } },
      h('div.row', h('strong.mono', d.id), h('span.tag', { 'data-dmx': d.id }, '…'), h('span.grow'),
        ifaces.length > 1 ? h('button.btn.xs', { onclick: () => patch({ dmx_interfaces: ifaces.filter((_, j) => j !== i) }) }, 'Remove') : null),
      h('div.row',
        field('Type', select([['none', 'Not used'], ['opendmx', 'USB Open DMX (FTDI, ~$15)'], ['usbpro', 'Enttec USB Pro / clone'], ['artnet', 'Art-Net (Wi-Fi node)']], d.type,
          (v) => setIface(i, 'type', v)), 'grow'),
        ['opendmx', 'usbpro'].includes(d.type) ? field('USB port', select([['', 'Choose…'], ...ports.map((p) => [p.device, `${p.device} ${p.description !== p.device ? '· ' + p.description : ''}`])], d.port || '',
          (v) => setIface(i, 'port', v)), 'grow') : null,
        d.type === 'artnet' ? field('Node IP', h('input', { type: 'text', value: d.host || '', placeholder: 'blank = broadcast', onchange: (e) => setIface(i, 'host', e.target.value.trim()) }), 'grow') : null,
        d.type === 'artnet' ? field('Universe', h('input', { type: 'number', min: 0, max: 32767, value: d.universe || 0, style: { width: '80px' }, onchange: (e) => setIface(i, 'universe', parseInt(e.target.value) || 0) })) : null))),
    h('button.btn.xs', { style: { justifySelf: 'start' }, onclick: () => patch({ dmx_interfaces: [...ifaces, { id: `dmx${ifaces.length + 1}`, type: 'none', port: '', host: '', universe: 0 }] }) }, '+ Add interface'),
    h('p', 'Windows may need the FTDI VCP driver for Open DMX cables; macOS has it built in. Lights only receive DMX while LIVE is on.'));
}

function safetyCard(st) {
  return h('div.card',
    h('h4', 'Safety & performance'),
    h('div.row',
      field('Flash rate limit', select([[0, 'Off'], [3, '3 flashes/sec'], [5, '5 flashes/sec'], [8, '8 flashes/sec'], [12, '12 flashes/sec']], st.max_flash_hz || 0,
        (v) => patch({ max_flash_hz: parseFloat(v) }), { id: 'max-flash' }), 'grow'),
      field('Engine rate', select([[30, '30 fps'], [44, '44 fps (DMX)'], [60, '60 fps'], [90, '90 fps'], [120, '120 fps']], st.fps || 60,
        (v) => patch({ fps: parseInt(v) }), { id: 'fps' }), 'grow')),
    h('p', 'Fast strobes (roughly 3–30 flashes a second) can trigger seizures in people with photosensitive epilepsy. Turn on a limit when guests are around, and warn people before strobe-heavy sets.'),
    h('p', 'Higher engine rates let fast lights follow 1/32 steps at club tempos, at the cost of more CPU.'),
    field('Interface look', select([['console', 'Console (dark)'], ['graphite', 'Graphite (warm dark)'], ['daylight', 'Daylight (outdoor setup)']],
      st.theme === 'neon' ? 'console' : st.theme || 'console', (v) => patch({ theme: v }), { id: 'ui-theme' })));
}

function showCard() {
  return h('div.card',
    h('h4', 'Show file'),
    h('p', 'Everything autosaves on this computer. Export a show file to move your rig and presets to another laptop, or keep it in your GitHub repo.'),
    h('div.row',
      h('a.btn.sm', { href: '/api/export', download: '' }, 'Export show'),
      h('label.btn.sm', { style: { cursor: 'pointer' } }, 'Import show…', h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: importShow })),
      h('button.btn.sm', { onclick: () => send('restore_presets') }, 'Restore built-in presets'),
      h('button.btn.sm', { onclick: (e) => {
        const b = e.target;
        if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Replaces rig + scenes. Sure?'; b.classList.add('danger'); return; }
        send('reset_demo');
      } }, 'Reset to demo rig')));
}
async function importShow(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const show = JSON.parse(await file.text());
    if (!Array.isArray(show.fixtures) || !Array.isArray(show.scenes)) throw new Error('not a LightingSim show file');
    send('import_show', { show });
    toast(`Imported “${show.name || file.name}”`);
  } catch (err) {
    toast(`Couldn’t import: ${err.message}`, true);
  }
}

function remoteCard(st) {
  return h('div.card',
    h('h4', 'Phone remote', h('span.mono', { style: { letterSpacing: 0, textTransform: 'none', fontWeight: 400 } }, `v${S.version}`)),
    h('label.check', h('input', { type: 'checkbox', checked: !!st.lan_access, onchange: (e) => patch({ lan_access: e.target.checked }) }),
      'Let phones on this Wi-Fi open the controller'),
    S.lan && S.lanUrls.length
      ? h('p', 'Open ', ...S.lanUrls.map((u) => h('b.mono', { style: { color: 'var(--text)' } }, u + ' ')), 'on your phone to fire scenes from the booth.')
      : h('p', st.lan_access ? 'Restart LightingSim to turn this on.' : 'Off: only this computer can control the lights.'),
    h('div.row',
      h('button.btn.sm', { onclick: async () => { await fetch('/api/quit', { method: 'POST' }).catch(() => {}); toast('LightingSim stopped. You can close this tab.'); } }, 'Quit LightingSim')));
}
