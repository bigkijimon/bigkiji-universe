'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const main = require.resolve('@electron/rebuild');
const cli = path.join(path.dirname(main), 'cli.js');
const result = spawnSync(process.execPath, [cli, '-f', '-w', 'node-pty'], { stdio: 'inherit', shell: false });
if (result.error || result.status !== 0) {
  console.warn('[BigKiji] node-pty rebuild was unavailable; runtime will use pipe mode.');
}
