'use strict';
// The console window is markup in one file and behaviour in another, joined only by
// string ids. A renamed id fails silently — no error, just a control that stops working
// — and Electron windows are not covered by the smoke test beyond tray and main. So the
// contract between the two files is checked here, statically, where it is cheap.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('src/components/UI/console.html');
const js = read('src/components/UI/console.js');
const main = read('src/core/main.js');
const preload = read('src/core/preload.js');

// ---- every id the behaviour asks for exists in the markup -------------------
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const referenced = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
for (const id of referenced) {
  assert.ok(declared.has(id), `console.js reads #${id}, which console.html does not define`);
}
assert.ok(referenced.size > 15, 'the id sweep should be finding the real control set');

// ---- the files the window loads are actually on disk ------------------------
for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
  if (src.startsWith('http')) continue;
  assert.ok(fs.existsSync(path.resolve(root, 'src/components/UI', src)), `console.html loads a missing script: ${src}`);
}
for (const [, href] of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
  assert.ok(fs.existsSync(path.resolve(root, 'src/components/UI', href)), `console.html loads a missing stylesheet: ${href}`);
}

// ---- house rules ------------------------------------------------------------
// backdrop-filter and vibrancy destroy each other (electron#39529, measured in
// glass-lab). This window sets no vibrancy, and must not start using the other half.
// Matches the declaration, not the word: this file explains the rule in a comment, and
// a test that cannot tell prose from CSS would forbid documenting the reason.
assert.ok(!/(?:^|[;{\s])(?:-webkit-)?backdrop-filter\s*:/im.test(html), 'console.html must not use backdrop-filter');
assert.ok(/Content-Security-Policy/.test(html), 'the window that renders model output needs a CSP');
assert.ok(!/vibrancy/.test(main.slice(main.indexOf('function createConsoleWindow'), main.indexOf('function createConsoleWindow') + 1200)),
  'the console window is opaque on purpose — adding vibrancy would break its stylesheet');

// Model output is escaped before it is marked up, and never assigned raw.
assert.ok(/renderMarkdown/.test(js), 'assistant replies go through the escaping renderer');
assert.ok(/bubble\.textContent = text/.test(js), "the owner's own text is set as text, never parsed");

// Motion discipline: transitions rather than keyframes for anything retriggered, and a
// reduced-motion escape hatch that follows the app setting as well as the OS one.
assert.ok(/prefers-reduced-motion/.test(html), 'the OS reduced-motion setting is honoured');
assert.ok(/reduce-motion/.test(html) && /reduce-motion/.test(js), "and so is the app's own appearance.reduceMotion");
assert.ok(/button:active\s*\{\s*transform:\s*scale\(\.97\)/.test(html), 'buttons acknowledge the press');

// ---- main process wiring ----------------------------------------------------
assert.ok(/function createConsoleWindow\(\)/.test(main), 'main.js creates the console window');
assert.ok(/consoleWin\.loadFile\(path\.join\(UI_ROOT, 'console\.html'\)\)/.test(main), 'and loads console.html');
assert.ok(/for \(const w of \[trayWin, mainWin, consoleWin\]\)/.test(main),
  'the console window must receive broadcasts, or it shows a frozen snapshot of a live system');
assert.ok(/ipcMain\.on\('open-console'/.test(main), 'something has to be able to open it');
assert.ok(/openConsole: \(\) => ipcRenderer\.send\('open-console'\)/.test(preload), 'and the renderer needs the door');
assert.ok(/Open Console/.test(main), 'the tray menu offers it');

// Closing hides rather than destroys, matching the other windows: a destroyed window
// would drop the broadcast target and take the terminal mirror with it.
const block = main.slice(main.indexOf('function createConsoleWindow'));
assert.ok(/consoleWin\.on\('close'.*e\.preventDefault\(\); consoleWin\.hide\(\)/s.test(block.slice(0, 1400)),
  'close hides the console window instead of destroying it');

// ---- the switch the owner asked for ----------------------------------------
assert.ok(/setView\('terminal'\)/.test(js) && /setView\('chat'\)/.test(js), 'both views are reachable');
assert.ok(/event\.key === '1'/.test(js) && /event\.key === '2'/.test(js), 'and reachable from the keyboard');
assert.ok(/bk\.ptyInput/.test(js) && /bk\.onPtyData/.test(js), 'the terminal is wired to the real pty');
assert.ok(/openMain\(\)/.test(js), 'the 3D scene is one button away rather than underneath');

// ---- specialist panes and the approval gate ---------------------------------
// A pane per assignment is only worth having if it shows the real process. These pin
// that it is fed by the live run/task channels rather than a mock, and that the
// approval echoes the exact hashes the coordinator demands — approve() throws
// STALE_RUN_REVISION / STALE_PLAN_HASH / STALE_DISCLOSURE_HASH otherwise, and an
// approval button that always fails is worse than none.
assert.ok(/onRunEvent/.test(js) && /onTaskLog/.test(js) && /onTaskEvent/.test(js),
  'panes are driven by the live run and task channels');
assert.ok(/revision: run\.revision/.test(js) && /planHash: run\.planHash/.test(js) && /disclosureHash: run\.disclosureHash/.test(js),
  'approval echoes revision, plan hash and disclosure hash');
assert.ok(/idempotencyKey/.test(js), 'and carries an idempotency key so a double click is not a double start');
assert.ok(/AWAITING_APPROVAL/.test(js) && /SECURITY_BLOCKED/.test(js),
  'both waiting states are surfaced — a blocked run must not look approvable');
assert.ok(/els\.approvalGo\.disabled = blocked/.test(js), 'a sandbox refusal disables the button rather than failing on click');
assert.ok(/\.replace\(ANSI, ''\)/.test(js), 'provider output is stripped of escape sequences before it reaches the DOM');
assert.ok(/line\.textContent =/.test(js), 'and set as text, never parsed — this is raw CLI output');
assert.ok(/LOG_LINES/.test(js) && /removeChild\(log\.firstChild\)/.test(js),
  'the log is bounded; a long run must not grow the DOM without limit');
assert.ok(/CSS\.escape/.test(js), 'task ids reach a selector, so they are escaped');
assert.ok(/listRuns/.test(js), 'a run already waiting when the window opens is picked up');

// ---- the change counter ------------------------------------------------------
// #diffStat sat empty from the day this window was built while the CLI rendered
// real diffs, so the surface the owner approves from showed less than the one
// they do not. It is a counter, not a diff view, and these pin the two properties
// that make the number trustworthy rather than decorative.
assert.ok(/els\.diff\.(textContent|append)/.test(js), '#diffStat is written to, not just read');
assert.ok(/HUNK/.test(js) && /@@ /.test(js),
  'counting starts at a hunk header — a bare + at the start of a line is prose far more often than a patch');
assert.ok(/diffs\.clear\(\)/.test(js),
  'a new run starts a new count; carrying the last one forward overstates what is about to happen');
{
  // Run the real function, lifted out of the window's IIFE, so the arithmetic is
  // checked rather than the presence of the code that does it.
  const start = js.indexOf('const diffs = new Map()');
  const end = js.indexOf('function renderDiffStat()');
  assert.ok(start > 0 && end > start, 'the counter should be findable in console.js');
  const build = new Function('els', 'renderDiffStat', `${js.slice(start, end)}\nreturn { countDiff, diffs };`);
  const { countDiff, diffs } = build({ diff: { textContent: '', title: '' } }, () => {});
  const tally = (id, text) => { countDiff(id, text); const e = diffs.get(id) || {}; return { added: e.added || 0, removed: e.removed || 0 }; };

  assert.deepEqual(tally('a', '+ this is prose\n- and so is this'), { added: 0, removed: 0 },
    'text before any hunk header is not a patch');
  assert.deepEqual(tally('b', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n ctx\n+one\n+two\n-gone'),
    { added: 2, removed: 1 }, 'file headers between diff --git and the first @@ are not content');
  assert.deepEqual(tally('c', '@@ -1,0 +1,2 @@\n+++i;\n+count++;'), { added: 2, removed: 0 },
    'inside a hunk, +++i; is a line somebody added — not a file header');
  assert.deepEqual(tally('d', '@@ -1,1 +0,0 @@\n----'), { added: 0, removed: 1 },
    'and a removed markdown rule is a removed line');
  assert.deepEqual(tally('e', '@@ -1,0 +1,1 @@\n+real\nsummary:\n- updated x\n- ran tests\n- all green'),
    { added: 1, removed: 0 },
    'a hunk ends at the first line that is not diff-shaped; what the provider narrates afterwards is prose');
  assert.deepEqual(tally('f', '@@ -1,0 +1,1 @@\n+real\n\nFAIL x\n- Expected\n+ Received'), { added: 1, removed: 0 },
    'including jest output, which is full of leading + and -');
}

console.log('console window selftest: PASS · markup and behaviour agree on every id · assets exist · opaque with no backdrop-filter · CSP present · broadcasts reach it · chat and terminal both reachable · one pane per real assignment · approval echoes the exact hashes · the change counter counts patches, not prose');
