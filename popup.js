function fmtAge(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function resultIcon(result) {
  switch (result) {
    case 'succeeded': return '✅';
    case 'failed': return '❌';
    case 'partiallySucceeded': return '⚠️';
    case 'canceled': return '⊘';
    default: return 'ℹ️';
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

async function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

function fmtSec(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60 ? ' ' + (s % 60) + 's' : ''}`;
}

function renderFooter(state) {
  const versionEl = document.getElementById('footer-version');
  versionEl.textContent = 'v' + (chrome.runtime.getManifest().version || '0');

  const statusEl = document.getElementById('footer-status');
  statusEl.classList.remove('warn');

  const pausedOrgs = Object.entries(state?.authPaused || {})
    .filter(([_, until]) => until > Date.now())
    .map(([org]) => org);

  if (pausedOrgs.length) {
    statusEl.classList.add('warn');
    statusEl.textContent = `⚠ session expired: ${pausedOrgs.join(', ')} — reopen ADO to re-auth`;
    return;
  }

  const watching = (state?.watchList || []).length;
  const lastPolledAt = state?.lastPolledAt || 0;
  const period = state?.pollPeriodMs || 60000;

  let parts = [];
  if (lastPolledAt) {
    const ago = (Date.now() - lastPolledAt) / 1000;
    const nextIn = Math.max(0, (lastPolledAt + period - Date.now()) / 1000);
    parts.push(`checked ${fmtSec(ago)} ago`);
    parts.push(`next in ${fmtSec(nextIn)}`);
  } else {
    parts.push('not polled yet');
  }
  parts.push(`${watching} watching`);
  statusEl.textContent = parts.join(' · ');
}

async function render() {
  const state = await send('GET_STATE');
  const watchList = state?.watchList || [];
  const recent = state?.recent || [];
  renderFooter(state);

  const watchUl = document.getElementById('watch-list');
  const recentUl = document.getElementById('recent-list');
  watchUl.innerHTML = '';
  recentUl.innerHTML = '';

  document.getElementById('empty-watching').style.display = watchList.length ? 'none' : '';
  document.getElementById('empty-recent').style.display = recent.length ? 'none' : '';

  for (const e of watchList) {
    const subtitle = e.buildNumber || e.runName;
    const showProgress = e.lastStatus === 'inProgress' && e.progress && e.progress.total > 0;
    const pct = showProgress ? Math.round((e.progress.done / e.progress.total) * 100) : 0;

    const progressBar = showProgress
      ? el('div', { class: 'progress', title: `${e.progress.done}/${e.progress.total} ${e.progress.granularity.toLowerCase()}s completed` }, [
          el('div', { class: 'progress-fill', style: `width: ${pct}%` }),
          el('div', { class: 'progress-label', text: `${pct}%` })
        ])
      : null;

    const li = el('li', {}, [
      el('span', { class: `dot ${e.lastStatus || 'unknown'}` }),
      el('div', { class: 'info' }, [
        el('div', { class: 'def' }, [
          el('a', { href: e.url, target: '_blank', text: e.definition || `Build ${e.buildId}` })
        ]),
        subtitle ? el('div', { class: 'subtitle', text: subtitle }) : null,
        progressBar,
        el('div', { class: 'meta', text: `${e.org} / ${e.project} · ${fmtAge(e.addedAt)}` })
      ]),
      el('button', {
        text: '✕',
        title: 'Stop watching',
        onclick: async () => {
          await send('REMOVE_WATCH', { id: e.id });
          render();
        }
      })
    ]);
    watchUl.appendChild(li);
  }

  for (const r of recent) {
    const subtitle = r.buildNumber || r.runName;
    const li = el('li', {}, [
      el('span', { text: resultIcon(r.result) }),
      el('div', { class: 'info' }, [
        el('div', { class: 'def' }, [
          el('a', { href: r.url, target: '_blank', text: r.definition || `Build ${r.buildId}` })
        ]),
        subtitle ? el('div', { class: 'subtitle', text: subtitle }) : null,
        el('div', { class: 'meta', text: `${r.org} / ${r.project} · finished ${fmtAge(r.finishedAt)}` })
      ]),
      el('button', {
        text: 'Undo',
        title: 'Add back to watch list',
        onclick: async () => {
          await send('UNDO_REMOVE', { id: r.id });
          render();
        }
      }),
      el('button', {
        text: '✕',
        title: 'Dismiss',
        onclick: async () => {
          await send('DISMISS_RECENT', { id: r.id });
          render();
        }
      })
    ]);
    recentUl.appendChild(li);
  }
}

document.getElementById('clear-recent').addEventListener('click', async () => {
  await send('CLEAR_RECENT');
  render();
});

document.getElementById('refresh').addEventListener('click', async () => {
  await send('POLL_NOW');
  render();
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[target="_blank"]');
  if (a) {
    e.preventDefault();
    chrome.tabs.create({ url: a.href });
  }
});

render();
setInterval(render, 5000);
