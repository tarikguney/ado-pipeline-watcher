# ADO Pipeline Watcher

A Chrome/Edge extension that watches Azure DevOps pipeline runs and pops a desktop notification when they finish. No PAT required — it rides your existing browser session cookies.

## Install

> **Why not a one-click install?** Chrome and Edge both removed double-click `.crx` installs from outside the official stores for security. Until this extension is published to the Edge Add-ons / Chrome Web Store, the install is a few extra clicks — but it only takes a minute and you only do it once. Updates are a one-click "reload" against the same folder.

### Option A — From a GitHub release (recommended for end users)

1. Go to the [Releases page](https://github.com/tarikguney/ado-pipeline-watcher/releases) and download the latest `ado-pipeline-watcher-vX.Y.Z.zip`.
2. Unzip it somewhere permanent (e.g. `C:\Tools\ado-pipeline-watcher` on Windows or `~/tools/ado-pipeline-watcher` on macOS/Linux). **Do not delete this folder** — the browser loads the extension from it.
3. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
4. Toggle **Developer mode** on (top-right corner).
5. Click **Load unpacked** and select the unzipped folder.
6. Pin the extension to the toolbar (puzzle-piece icon → pin).
7. Sign in to `https://dev.azure.com/<your-org>` in the same browser profile.

**To update:** download the newer release ZIP, replace the contents of the same folder, then click the ↻ reload icon on the extension card.

### Option B — From a git clone (for development)

```bash
git clone https://github.com/tarikguney/ado-pipeline-watcher.git
```

Then follow steps 3–7 above, pointing **Load unpacked** at the cloned repo.

### Option C — `.crx` drag-drop (not recommended)

A `.crx` may also be attached to releases. You can drag it onto `chrome://extensions` with developer mode on, but Chrome/Edge will often disable it on the next browser restart unless the extension ID is in an enterprise allow-list policy. Use **Option A** instead.

### Future: Edge Add-ons / Chrome Web Store

Once published, install will be a single click from the store. That's the only way to get true "double-click" install on modern Chrome/Edge.

## Usage

1. Open any ADO pipeline run page (URL contains `/_build/results?buildId=...`).
2. Click the blue **🔔 Watch this pipeline** pill in the bottom-right of the page.
3. Close the tab if you want — polling continues in the background once per minute.
4. When the run finishes you get a desktop notification:
   - ✅ Succeeded
   - ❌ Failed (sticky — stays until dismissed)
   - ⚠️ Partially succeeded (sticky)
   - ⊘ Canceled
5. Click the notification to jump back to the run page.
6. The run is auto-removed from the watch list and appears under **Recently finished** in the popup with an **Undo** button for 5 minutes.

## How it works

- **Adding**: a content script on `_build/results` pages parses `org`, `project`, `buildId` from the URL and sends them to the service worker.
- **Polling**: a `chrome.alarms` tick fires every minute; the service worker calls
  `GET https://dev.azure.com/{org}/{project}/_apis/build/builds/{buildId}?api-version=7.1`
  with `credentials: 'include'`. Your browser attaches the ADO session cookie automatically.
- **Storage**: watch list lives in `chrome.storage.local`, so it survives browser restart.
- **Auth expiry**: a 401/403 triggers a "session expired" notification and pauses polling for that org for 10 minutes.

## Supported hosts

- `https://dev.azure.com/<org>/...`
- `https://<org>.visualstudio.com/...` (legacy)

## Permissions

- `storage`, `alarms`, `notifications`, `tabs`
- Host access to `dev.azure.com` and `*.visualstudio.com` only.
