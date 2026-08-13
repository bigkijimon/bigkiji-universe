'use strict';

// Where BigKiji's own API keys live.
//
// They used to live only in `<repo>/app/.env`, which works for the daemon started
// from source and does not work at all for the packaged app: the .app resolves its
// root to Contents/Resources/app, and a secrets file is correctly not packaged
// there. Measured 2026-08-03 — with a valid ZAI_API_KEY on disk, the GUI still
// showed GLM as OFFLINE, because the process that drew that label had never seen
// the file.
//
// The data root is the right home. It belongs to the owner rather than to a
// checkout, it is outside the git repository and outside the bundle, and it
// survives every rebuild. The repo path stays as a development fallback, so a
// fresh clone still works without moving anything.
//
// Loaded, never written: putting a key here is the owner's action, in the Settings
// window or in this file. dotenv does not overwrite a variable that is already set,
// so an explicit export still wins over both.

const path = require('path');

/**
 * The .env files to try, most specific first.
 * @returns {string[]}
 */
function envCandidates({ dataRoot = '', appRoot = '' } = {}) {
  return [dataRoot && path.join(dataRoot, '.env'), appRoot && path.join(appRoot, '.env')].filter(Boolean);
}

/**
 * Load whichever of them exists, in order. Returns the files that were read.
 * @returns {string[]}
 */
function loadEnvFiles({ dataRoot = '', appRoot = '', dotenv = null, expand = null } = {}) {
  const files = [];
  for (const file of envCandidates({ dataRoot, appRoot })) {
    try {
      const parser = dotenv || require('dotenv');
      // `quiet` keeps dotenv 17 as quiet as dotenv 16 was. Without it every load
      // prints a line to STDOUT — not stderr — advertising dotenvx and vestauth,
      // and this resolver runs on both surfaces: the Electron main process and the
      // `bigkiji` CLI, whose stdout is read by other programs. dotenv 16 ignores the
      // option, so a downgrade does not break on it.
      const result = parser.config({ path: file, quiet: true });
      if (result.error) continue;
      if (expand) expand(result);
      files.push(file);
    } catch (_) { /* an unreadable .env is a missing .env */ }
  }
  return files;
}

module.exports = { envCandidates, loadEnvFiles };
