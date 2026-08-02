'use strict';

// Rebuild node-pty against the Electron ABI after an install.
//
// @electron/rebuild is a devDependency, so it is only here when someone is
// working on BigKiji itself. When the CLI is installed as a dependency of
// something else — which is the point of shipping `bigkiji` as a terminal
// command — the module is absent, and resolving it at the top of this file
// threw and failed the whole install. There is nothing to rebuild in that
// situation: the CLI talks to the daemon over HTTP and never opens a pty.

const { spawnSync } = require('child_process');
const path = require('path');

let main;
try {
  main = require.resolve('@electron/rebuild');
} catch (_) {
  process.exit(0); // no Electron toolchain here, and none is needed
}

const cli = path.join(path.dirname(main), 'cli.js');
const result = spawnSync(process.execPath, [cli, '-f', '-w', 'node-pty'], { stdio: 'inherit', shell: false });
if (result.error || result.status !== 0) {
  console.warn('[bigkiji] node-pty rebuild was unavailable; runtime will use pipe mode.');
}
