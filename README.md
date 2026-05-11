# ADO Pipeline Watcher

A Chrome/Edge extension that watches Azure DevOps pipeline runs and pops a desktop notification when they finish. No PAT required — it rides your existing browser session cookies.

## Install

1. Download the latest `ado-pipeline-watcher-vX.Y.Z.zip` from the [Releases page](https://github.com/tarikguney/ado-pipeline-watcher/releases) and unzip it somewhere permanent (the browser loads the extension from this folder — don't delete it).
2. Open `edge://extensions` or `chrome://extensions` and turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the unzipped folder.
4. Pin the extension to the toolbar and sign in to `https://dev.azure.com/<your-org>` in the same browser profile.

To update, drop the new release into the same folder and click the ↻ reload icon on the extension card.

> Chrome and Edge no longer allow one-click `.crx` installs from outside the official stores. A store listing is planned.

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
