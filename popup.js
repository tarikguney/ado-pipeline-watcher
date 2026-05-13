function fmtAge(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function formatBranch(ref) {
  if (!ref) return null;
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/tags/')) return 'tag: ' + ref.slice('refs/tags/'.length);
  const pr = ref.match(/^refs\/pull\/(\d+)\/(?:merge|head)$/);
  if (pr) return `PR #${pr[1]}`;
  return ref;
}

function promptForEntry(e) {
  const lines = [
    `Watch this ADO pipeline run and notify me when it completes (succeeded / failed / partially / canceled).`,
    `- Definition: ${e.definition || '(unknown)'}`
  ];
  const num = e.buildNumber || e.runName;
  if (num) lines.push(`- Run: ${num}`);
  const branch = formatBranch(e.sourceBranch);
  if (branch) lines.push(`- Branch: ${branch}`);
  lines.push(`- URL: ${e.url}`);
  lines.push(``);
  lines.push(`If it fails or is partial, fetch the failing job's log tail and summarize the error.`);
  return lines.join('\n');
}

function promptForList(entries) {
  if (entries.length === 1) return promptForEntry(entries[0]);
  const header = `Watch these ${entries.length} ADO pipeline runs and notify me as each one completes (succeeded / failed / partially / canceled). One ping per run is fine.`;
  const blocks = entries.map((e, i) => {
    const lines = [`${i + 1}. Definition: ${e.definition || '(unknown)'}`];
    const num = e.buildNumber || e.runName;
    if (num) lines.push(`   Run: ${num}`);
    const branch = formatBranch(e.sourceBranch);
    if (branch) lines.push(`   Branch: ${branch}`);
    lines.push(`   URL: ${e.url}`);
    return lines.join('\n');
  });
  const footer = `If any fail or are partial, fetch the failing job's log tail and summarize the error.`;
  return [header, '', ...blocks, '', footer].join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

let toastTimer = null;
function showToast(message, opts = {}) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('error', !!opts.error);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), opts.duration || 1800);
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

let lastSeenPollTs = null;

function renderFooter(state) {
  const versionEl = document.getElementById('footer-version');
  versionEl.textContent = 'v' + (chrome.runtime.getManifest().version || '0');

  const statusEl = document.getElementById('footer-status');
  statusEl.classList.remove('warn');

  const polledAt = state?.lastPolledAt || 0;
  if (lastSeenPollTs !== null && polledAt > lastSeenPollTs) {
    statusEl.classList.remove('flash');
    void statusEl.offsetWidth; // restart animation
    statusEl.classList.add('flash');
  }
  lastSeenPollTs = polledAt;

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
    const subtitle = e.buildNumber || e.runName || null;
    const branch = formatBranch(e.sourceBranch);
    const showProgress = e.lastStatus === 'inProgress' && e.progress && e.progress.total > 0;
    const pct = showProgress ? Math.round((e.progress.done / e.progress.total) * 100) : 0;

    const progressBar = showProgress
      ? el('div', { class: 'progress', title: `${e.progress.done}/${e.progress.total} ${e.progress.granularity.toLowerCase()}s completed` }, [
          el('div', { class: 'progress-fill', style: `width: ${pct}%` }),
          el('div', { class: 'progress-label', text: `${pct}%` })
        ])
      : null;

    const li = el('li', {}, [
      el('div', { class: 'info' }, [
        el('div', { class: 'def' }, [
          el('span', { class: `dot ${e.lastStatus || 'unknown'}` }),
          el('a', { href: e.url, target: '_blank', text: e.definition || `Build ${e.buildId}` })
        ]),
        subtitle ? el('div', { class: 'subtitle', text: subtitle }) : null,
        branch ? el('div', { class: 'branch', text: `⎇ ${branch}`, title: e.sourceBranch || branch }) : null,
        progressBar,
        el('div', { class: 'meta', text: `${e.org} / ${e.project} · ${fmtAge(e.addedAt)}` })
      ]),
      el('button', {
        text: '✨',
        title: 'Generate AI prompt for this run',
        class: 'copy-btn',
        onclick: async () => {
          const ok = await copyText(promptForEntry(e));
          showToast(
            ok ? 'AI prompt for this run copied to clipboard' : 'Could not copy to clipboard',
            { error: !ok }
          );
        }
      }),
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
    const subtitle = r.buildNumber || r.runName || null;
    const branch = formatBranch(r.sourceBranch);
    const li = el('li', {}, [
      el('div', { class: 'info' }, [
        el('div', { class: 'def' }, [
          el('span', { class: 'result-icon', text: resultIcon(r.result) }),
          el('a', { href: r.url, target: '_blank', text: r.definition || `Build ${r.buildId}` })
        ]),
        subtitle ? el('div', { class: 'subtitle', text: subtitle }) : null,
        branch ? el('div', { class: 'branch', text: `⎇ ${branch}`, title: r.sourceBranch || branch }) : null,
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

document.getElementById('copy-all').addEventListener('click', async () => {
  const state = await send('GET_STATE');
  const list = state?.watchList || [];
  if (!list.length) {
    showToast('No watched runs to generate a prompt for', { error: true });
    return;
  }
  const ok = await copyText(promptForList(list));
  showToast(
    ok
      ? `AI prompt for ${list.length} run${list.length > 1 ? 's' : ''} copied to clipboard`
      : 'Could not copy to clipboard',
    { error: !ok }
  );
});

document.getElementById('refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    await send('POLL_NOW');
    await render();
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[target="_blank"]');
  if (a) {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'OPEN_URL', payload: { url: a.href } });
    window.close();
  }
});

render();
setInterval(render, 5000);
