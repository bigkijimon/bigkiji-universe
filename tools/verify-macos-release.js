'use strict';

// What the signature on this build is actually good for.
//
// This ran three checks in a row and threw on the first failure. On a self-signed build —
// which is what `npm run dist` produces on this machine, because there is no Apple
// Developer ID — the second check always fails, and the owner got a Node stack trace
// ending in `status: 3` for a build that was fine. Measured 2026-08-09: the app was
// signed, installed to /Applications and launched, and this tool called it an error.
//
// Gatekeeper rejecting a self-signed app is not a defect, it is the definition. So the
// build is classified first and then judged by the standard that applies to it:
//
//   Developer ID  — codesign, Gatekeeper, and a stapled notarization ticket. Distributable.
//   self-signed   — codesign only. Runs on THIS Mac and cannot be given to anyone else.
//   unsigned      — a failure either way: the identifier falls back to `Electron` and
//                   macOS resets the microphone and screen-recording grants every build.
//
// Exit code is the contract: 0 when the build meets the standard for what it is.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../../dist/mac-arm64/BigKiji Universe.app');
if (!fs.existsSync(appPath)) throw new Error(`Signed app not found: ${appPath}`);

/**
 * Run a command, returning BOTH streams and whether it succeeded. Never throws.
 *
 * Both streams, because `codesign -dv` writes everything to stderr — Identifier,
 * Authority, TeamIdentifier, all of it. Reading only stdout returns '' for a perfectly
 * signed bundle, and this file then reports it as unsigned. That is what the first
 * version of this rewrite did, on an app whose signature had just been verified by hand.
 */
function attempt(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  const out = `${String(result.stdout || '')}${String(result.stderr || '')}`.trim();
  return { ok: result.status === 0, out };
}

const details = attempt('/usr/bin/codesign', ['-dv', '--verbose=2', appPath]).out;
const authority = (details.match(/^Authority=(.+)$/m) || [])[1] || '';
const identifier = (details.match(/^Identifier=(.+)$/m) || [])[1] || '';
const developerId = /^Developer ID Application:/.test(authority);
const signed = Boolean(authority);

console.log(`app        ${appPath}`);
console.log(`identifier ${identifier || '(none)'}`);
console.log(`authority  ${authority || '(unsigned)'}`);

let failures = 0;
const check = (name, result, hint = '') => {
  console.log(`${result.ok ? '  ok  ' : '  FAIL'} ${name}`);
  if (result.ok) return;
  failures += 1;
  if (hint) console.log(`       ${hint}`);
  if (result.out) console.log(`       ${result.out.split('\n')[0]}`);
};

// The one check every build has to pass, whatever it is signed with.
check('the signature is intact and covers the whole bundle',
  attempt('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]));
// macOS keys TCC grants on the identifier. An unsigned build falls back to `Electron`,
// so the microphone permission the owner granted is revoked on every rebuild.
if (identifier !== 'com.bigkiji.universe') {
  failures += 1;
  console.log(`  FAIL the identifier must be com.bigkiji.universe, not "${identifier}"`);
  console.log('       macOS keys microphone and screen-recording grants on this string;');
  console.log('       a build that changes it makes the owner re-grant them every time.');
}

if (developerId) {
  check('Gatekeeper accepts it', attempt('/usr/sbin/spctl', ['--assess', '--verbose=2', '--type', 'exec', appPath]));
  check('a notarization ticket is stapled', attempt('/usr/bin/xcrun', ['stapler', 'validate', appPath]),
    'run dist:mac with APPLE_KEYCHAIN_PROFILE set, or the download is blocked on first launch');
  if (!failures) console.log('\n[RELEASE] Developer ID, Gatekeeper and notarization all valid — distributable.');
} else if (signed) {
  // Stated, not silently skipped. This limit is the whole difference between this build
  // and one the owner could send to somebody.
  console.log('  ..   Gatekeeper and notarization are not checked: this is a self-signed build.');
  console.log('       `spctl` will say "rejected" and that is correct — a self-signed app cannot be');
  console.log('       notarized. It runs on this Mac (a local build carries no quarantine flag) and');
  console.log('       cannot be given to anyone else. For that: Apple Developer Program ($99/yr) and');
  console.log('       a Developer ID Application certificate — `npm run dist` picks one up on its own.');
  if (!failures) console.log('\n[LOCAL BUILD] signed, stable identifier, runs on this Mac. Not distributable.');
} else {
  failures += 1;
  console.log('  FAIL the build is unsigned');
  console.log('       ~/.certs/bigkiji-dev/ holds the local signer; see the signing reference.');
}

process.exit(failures ? 1 : 0);
