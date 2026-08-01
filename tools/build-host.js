'use strict';

const { spawnSync } = require('child_process');
const target = process.platform === 'darwin' ? 'dist:mac' : process.platform === 'win32' ? 'dist:win' : 'dist:linux';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', target], { stdio: 'inherit', shell: false });
process.exit(result.status == null ? 1 : result.status);
