// "Update available" button + confirm dialog. The app downloads, installs and restarts itself.
import { S, send } from './state.js';
import { $, h, on, toast } from './util.js';

let lastStatus = '';

export function initUpdate() {
  const btn = $('#update-btn');
  btn.addEventListener('click', () => {
    const u = S.status?.update;
    if (!u || ['downloading', 'installing'].includes(u.status)) return;
    confirmUpdate(u);
  });
  on('status', (m) => {
    const u = m.update;
    if (!u) return;
    const busy = ['downloading', 'installing'].includes(u.status);
    btn.hidden = !(u.available || busy);
    if (busy) {
      btn.replaceChildren(u.status === 'installing' ? 'Installing…' : `Downloading ${Math.round(u.progress * 100)}%`,
        h('span.bar', { style: { width: `${u.progress * 100}%` } }));
    } else if (u.available) {
      btn.replaceChildren(`Update to ${u.latest}`);
    }
    if (u.status !== lastStatus) {
      if (u.status === 'error' && u.error && lastStatus) toast(u.error, true);
      if (u.status === 'installing') toast('Installing the update. LightingSim will restart in a moment.');
      lastStatus = u.status;
    }
  });
}

export function confirmUpdate(u) {
  const close = () => bg.remove();
  const bg = h('div.modal-bg', { onclick: (e) => e.target === bg && close() },
    h('div.modal', { role: 'dialog', 'aria-label': 'Update LightingSim', style: { width: 'min(460px, 100%)' } },
      h('div.modal-head', h('h3', `Update to LightingSim ${u.latest}?`)),
      u.can_install
        ? h('p.muted', { style: { margin: 0 } }, `You have ${u.current}. LightingSim will download the update, close, and reopen by itself in about a minute. Your rig, scenes and settings are kept. Live lights go dark while it restarts.`)
        : h('p.muted', { style: { margin: 0 } }, 'You’re running from source code. Update by running “git pull” in the LightingSim folder, then restart.'),
      h('div.row', { style: { justifyContent: 'flex-end' } },
        h('a.btn.sm.ghost', { href: u.notes_url, target: '_blank', rel: 'noopener' }, 'What’s new'),
        h('button.btn.sm', { onclick: close }, 'Later'),
        u.can_install ? h('button.btn.sm.primary', { onclick: () => { send('update_install'); close(); } }, 'Update now') : null)));
  document.body.append(bg);
}
