// Content script - injects a floating "Watch this pipeline" button on ADO run pages.

(function () {
  const BTN_ID = 'ado-watcher-watch-btn';

  function parseRun() {
    // URL shape:
    //   https://dev.azure.com/{org}/{project}/_build/results?buildId=12345&view=...
    //   https://{instance}.visualstudio.com/{project}/_build/results?buildId=12345
    try {
      const u = new URL(location.href);
      const buildId = u.searchParams.get('buildId');
      if (!buildId) return null;

      let org = null, project = null;
      if (u.hostname === 'dev.azure.com') {
        const parts = u.pathname.split('/').filter(Boolean);
        // [org, project, '_build', 'results']
        if (parts.length >= 2) {
          org = parts[0];
          project = parts[1];
        }
      } else if (u.hostname.endsWith('.visualstudio.com')) {
        org = u.hostname.split('.')[0];
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length >= 1) project = parts[0];
      }
      if (!org || !project) return null;

      // Best-effort definition/run name from page title or DOM.
      const title = document.title || '';
      // Title commonly looks like: "{buildNumber} - {definition} (results) - {project} - ..."
      let definition = null, runName = null;
      const titleMatch = title.match(/^(.+?)\s*-\s*(.+?)\s*\(/);
      if (titleMatch) {
        runName = titleMatch[1].trim();
        definition = titleMatch[2].trim();
      }

      return {
        org, project, buildId,
        definition,
        runName,
        url: location.href
      };
    } catch {
      return null;
    }
  }

  function setBtnState(btn, watching) {
    btn.dataset.watching = watching ? '1' : '0';
    btn.textContent = watching ? '✓ Watching — click to stop' : '🔔 Watch this pipeline';
    btn.title = watching
      ? 'Pipeline is being watched. Click to stop.'
      : 'Get a desktop notification when this run finishes.';
  }

  function ensureButton(run) {
    let btn = document.getElementById(BTN_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.className = 'ado-watcher-btn';
      document.body.appendChild(btn);
      btn.addEventListener('click', async () => {
        const current = parseRun();
        if (!current) return;
        const watching = btn.dataset.watching === '1';
        if (watching) {
          await chrome.runtime.sendMessage({
            type: 'REMOVE_WATCH',
            payload: { id: `${current.org}/${current.project}/${current.buildId}` }
          });
          setBtnState(btn, false);
        } else {
          await chrome.runtime.sendMessage({ type: 'ADD_WATCH', payload: current });
          setBtnState(btn, true);
        }
      });
    }
    refreshButtonState(btn, run);
  }

  async function refreshButtonState(btn, run) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'IS_WATCHING',
        payload: { org: run.org, project: run.project, buildId: run.buildId }
      });
      setBtnState(btn, !!(resp && resp.watching));
    } catch {
      setBtnState(btn, false);
    }
  }

  function removeButton() {
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.remove();
  }

  function tick() {
    const run = parseRun();
    if (run) ensureButton(run);
    else removeButton();
  }

  // ADO is a SPA; watch for URL changes.
  let lastUrl = location.href;
  const obs = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      tick();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  tick();
})();
