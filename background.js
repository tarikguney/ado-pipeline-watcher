// ADO Pipeline Watcher - service worker
// Polls watched ADO pipeline runs using the browser's existing session cookies.

const ALARM_NAME = 'ado-poll';
const POLL_PERIOD_MIN = 1;
const RECENT_TTL_MS = 24 * 60 * 60 * 1000;

const STATE = {
  watchList: 'watchList',       // [{ id, org, project, buildId, definition, runName, url, addedAt, lastStatus }]
  recent: 'recentlyFinished',   // [{ ...sameShape, finishedAt, result }]
  authPaused: 'authPausedOrgs'  // { [org]: pausedUntilTs }
};

function runKey(org, project, buildId) {
  return `${org}/${project}/${buildId}`;
}

async function getList(key) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] || (key === STATE.authPaused ? {} : []);
}

async function setList(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MIN, delayInMinutes: 0.05 });
  }
}

async function updateBadge() {
  const list = await getList(STATE.watchList);
  const count = list.length;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0078d4' });
}

function entryBaseUrl(entry) {
  // Backward-compat for v0.2.0 entries that pre-date the baseUrl field.
  return entry.baseUrl || `https://dev.azure.com/${encodeURIComponent(entry.org)}`;
}

function buildApiUrl(entry) {
  return `${entryBaseUrl(entry)}/${encodeURIComponent(entry.project)}/_apis/build/builds/${encodeURIComponent(entry.buildId)}?api-version=7.1`;
}

function timelineApiUrl(entry) {
  return `${entryBaseUrl(entry)}/${encodeURIComponent(entry.project)}/_apis/build/builds/${encodeURIComponent(entry.buildId)}/timeline?api-version=7.1`;
}

async function fetchBuild(entry) {
  const resp = await fetch(buildApiUrl(entry), {
    method: 'GET',
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
    cache: 'no-store'
  });
  return resp;
}

async function fetchProgress(entry) {
  try {
    const resp = await fetch(timelineApiUrl(entry), {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const records = data?.records || [];
    if (!records.length) return null;
    // Prefer Stage granularity; fall back to Job; fall back to Task.
    for (const type of ['Stage', 'Job', 'Task']) {
      const subset = records.filter(r => r.type === type);
      if (subset.length) {
        const done = subset.filter(r => r.state === 'completed').length;
        return { done, total: subset.length, granularity: type };
      }
    }
    return null;
  } catch {
    return null;
  }
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

function resultLabel(result) {
  switch (result) {
    case 'succeeded': return 'Succeeded';
    case 'failed': return 'Failed';
    case 'partiallySucceeded': return 'Partially succeeded';
    case 'canceled': return 'Canceled';
    default: return result || 'Completed';
  }
}

async function notifyFinished(entry, build) {
  const result = build.result || 'unknown';
  const title = `${resultIcon(result)} ${resultLabel(result)}`;
  const defName = build.definition?.name || entry.definition || 'Pipeline';
  const num = build.buildNumber ? ` #${build.buildNumber}` : '';
  const message = `${defName}${num}`;
  const notifId = `ado-${entry.id}-${Date.now()}`;
  await chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    contextMessage: `${entry.org} / ${entry.project}`,
    requireInteraction: result !== 'succeeded',
    priority: result === 'succeeded' ? 1 : 2
  });
  // Track URL so click opens the run.
  const map = (await chrome.storage.local.get('notifUrls')).notifUrls || {};
  map[notifId] = entry.url;
  await chrome.storage.local.set({ notifUrls: map });
}

async function pauseAuthForOrg(org) {
  const paused = await getList(STATE.authPaused);
  paused[org] = Date.now() + 10 * 60 * 1000; // pause 10 min
  await setList(STATE.authPaused, paused);
  await chrome.notifications.create(`ado-auth-${org}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'ADO session expired',
    message: `Open https://dev.azure.com/${org} and sign in to resume watching.`,
    priority: 2
  });
}

async function isOrgPaused(org) {
  const paused = await getList(STATE.authPaused);
  const until = paused[org];
  if (!until) return false;
  if (Date.now() > until) {
    delete paused[org];
    await setList(STATE.authPaused, paused);
    return false;
  }
  return true;
}

async function pollOnce() {
  const list = await getList(STATE.watchList);
  if (!list.length) return;

  const remaining = [];
  const finishedNow = [];

  for (const entry of list) {
    try {
      if (await isOrgPaused(entry.org)) {
        remaining.push(entry);
        continue;
      }
      const resp = await fetchBuild(entry);
      if (resp.status === 401 || resp.status === 403) {
        await pauseAuthForOrg(entry.org);
        remaining.push(entry);
        continue;
      }
      if (resp.status === 404) {
        // Run gone - drop silently.
        continue;
      }
      if (!resp.ok) {
        remaining.push(entry);
        continue;
      }
      const build = await resp.json();
      entry.lastStatus = build.status;
      entry.definition = build.definition?.name || entry.definition;
      entry.buildNumber = build.buildNumber || entry.buildNumber;
      entry.sourceBranch = build.sourceBranch || entry.sourceBranch || null;

      if (build.status === 'completed') {
        entry.progress = null;
        await notifyFinished(entry, build);
        finishedNow.push({ ...entry, finishedAt: Date.now(), result: build.result });
      } else {
        if (build.status === 'inProgress') {
          entry.progress = await fetchProgress(entry);
        } else {
          entry.progress = null;
        }
        remaining.push(entry);
      }
    } catch (e) {
      // Network blip - keep entry, try again next tick.
      remaining.push(entry);
    }
  }

  await chrome.storage.local.set({ lastPolledAt: Date.now() });
  await setList(STATE.watchList, remaining);

  if (finishedNow.length) {
    const recent = await getList(STATE.recent);
    const cutoff = Date.now() - RECENT_TTL_MS;
    const merged = [...finishedNow, ...recent].filter(r => r.finishedAt >= cutoff).slice(0, 20);
    await setList(STATE.recent, merged);
  }

  await updateBadge();
}

// --- Messages from content script and popup ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'ADD_WATCH') {
        const { org, project, buildId, baseUrl, definition, runName, url } = msg.payload;
        const list = await getList(STATE.watchList);
        const id = runKey(org, project, buildId);
        if (!list.find(e => e.id === id)) {
          list.push({
            id, org, project, buildId,
            baseUrl: baseUrl || null,
            definition: definition || null,
            runName: runName || null,
            url,
            addedAt: Date.now(),
            lastStatus: 'unknown'
          });
          await setList(STATE.watchList, list);
          await updateBadge();
          await ensureAlarm();
          // Kick an immediate poll so the popup shows live status fast.
          pollOnce();
        }
        sendResponse({ ok: true, watching: true });
      } else if (msg.type === 'REMOVE_WATCH') {
        const { id } = msg.payload;
        const list = await getList(STATE.watchList);
        await setList(STATE.watchList, list.filter(e => e.id !== id));
        await updateBadge();
        sendResponse({ ok: true });
      } else if (msg.type === 'IS_WATCHING') {
        const { org, project, buildId } = msg.payload;
        const list = await getList(STATE.watchList);
        const id = runKey(org, project, buildId);
        sendResponse({ ok: true, watching: !!list.find(e => e.id === id) });
      } else if (msg.type === 'UNDO_REMOVE') {
        // Re-add a recently finished entry to the watch list.
        const { id } = msg.payload;
        const recent = await getList(STATE.recent);
        const item = recent.find(r => r.id === id);
        if (item) {
          const list = await getList(STATE.watchList);
          if (!list.find(e => e.id === id)) {
            list.push({
              id: item.id,
              org: item.org,
              project: item.project,
              buildId: item.buildId,
              baseUrl: item.baseUrl || null,
              definition: item.definition,
              runName: item.runName,
              url: item.url,
              addedAt: Date.now(),
              lastStatus: 'unknown'
            });
            await setList(STATE.watchList, list);
          }
          await setList(STATE.recent, recent.filter(r => r.id !== id));
          await updateBadge();
          pollOnce();
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'DISMISS_RECENT') {
        const { id } = msg.payload;
        const recent = await getList(STATE.recent);
        await setList(STATE.recent, recent.filter(r => r.id !== id));
        sendResponse({ ok: true });
      } else if (msg.type === 'CLEAR_RECENT') {
        await setList(STATE.recent, []);
        sendResponse({ ok: true });
      } else if (msg.type === 'GET_STATE') {
        const watchList = await getList(STATE.watchList);
        const recent = await getList(STATE.recent);
        const authPaused = await getList(STATE.authPaused);
        const { lastPolledAt } = await chrome.storage.local.get('lastPolledAt');
        sendResponse({
          ok: true,
          watchList,
          recent,
          authPaused,
          lastPolledAt: lastPolledAt || 0,
          pollPeriodMs: POLL_PERIOD_MIN * 60 * 1000
        });
      } else if (msg.type === 'POLL_NOW') {
        await pollOnce();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async
});

// --- Notification clicks open the run URL ---

chrome.notifications.onClicked.addListener(async (notifId) => {
  const map = (await chrome.storage.local.get('notifUrls')).notifUrls || {};
  const url = map[notifId];
  if (url) {
    chrome.tabs.create({ url });
    delete map[notifId];
    await chrome.storage.local.set({ notifUrls: map });
  }
  chrome.notifications.clear(notifId);
});

chrome.notifications.onClosed.addListener(async (notifId) => {
  const map = (await chrome.storage.local.get('notifUrls')).notifUrls || {};
  if (map[notifId]) {
    delete map[notifId];
    await chrome.storage.local.set({ notifUrls: map });
  }
});

// --- Alarms ---

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollOnce();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await updateBadge();
});
