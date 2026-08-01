'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appPath = path.resolve(__dirname, '../../dist/mac-arm64/BigKiji Universe.app');
if (!fs.existsSync(appPath)) throw new Error(`Signed app not found: ${appPath}`);
function run(file, args) {
  console.log(`$ ${file} ${args.join(' ')}`);
  execFileSync(file, args, { stdio: 'inherit' });
}
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
run('/usr/sbin/spctl', ['--assess', '--verbose=2', '--type', 'exec', appPath]);
run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
console.log('[MACOS RELEASE VERIFIED] Developer ID signature, Gatekeeper assessment and notarization ticket are valid.');
