// The console window's contract, checked statically and by running the real functions.
//
// HISTORY — read this before changing anything below.
//
// This file replaces the CommonJS console-window-selftest.js that guarded console.html +
// console.js. That window was markup in one file and behaviour in another, joined only by
// string ids, so the old test swept every $('id') and asserted the markup declared it. The
// window is now React (src/components/UI/console-app), where that particular failure mode
// does not exist — but the failure mode it stood for does: a renamed *IPC method* still
// fails silently, because preload.js is the join now instead of element ids. So that sweep
// became the bk.* sweep below rather than being dropped.
//
// Two assertions were deliberately retired. They are named here rather than deleted in
// silence, because a test that vanishes without explanation reads like an oversight:
//
//   - `bubble.textContent = text`  — pinned that the owner's own text was never parsed.
//     JSX interpolation escapes by construction; there is no longer a code path that could
//     parse it. Replaced by the stronger check that dangerouslySetInnerHTML appears in
//     exactly one file.
//   - `CSS.escape`                 — pinned that task ids were escaped before reaching a
//     selector. React keys the panes by taskId; no selector is built from one.
//
// Everything else was carried across. Where the old test grepped for a literal, this one
// imports the function and runs it, which is strictly harder to fool.

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const APP = 'src/components/UI/console-app';
const DIST = 'src/components/UI/console-dist';

const main = read('src/core/main.js');
const preload = read('src/core/preload.js');

// Every source file of the window, so the sweeps below cannot miss one by being written
// before it existed.
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}
const sources = walk(APP).filter((file) => /\.(jsx?|mjs|css|html)$/.test(file));
const code = Object.fromEntries(sources.map((file) => [file, read(file)]));
const jsFiles = sources.filter((file) => /\.(jsx?|mjs)$/.test(file));
const cssFiles = sources.filter((file) => file.endsWith('.css'));

assert.ok(jsFiles.length > 8, 'the source sweep should be finding the real file set');
assert.ok(cssFiles.length >= 1, 'and the stylesheet');

// Prose about a rule is not the rule. The old test learned this for backdrop-filter: a
// check that cannot tell a comment from code forbids documenting the reason for itself.
const stripComments = (text) => text
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ---- the join between the window and the main process ----------------------
// Every bk.* the app calls must exist in preload.js. This is the React-era equivalent of
// the old id sweep: rename a method on one side and nothing throws until a user clicks it.
{
  const exposed = new Set([...preload.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
  assert.ok(exposed.size > 60, 'the preload sweep should be finding the real API surface');
  const used = new Set();
  for (const file of jsFiles) {
    for (const [, name] of stripComments(code[file]).matchAll(/\bbk\.([A-Za-z0-9_]+)/g)) used.add(name);
  }
  assert.ok(used.size > 10, 'the window should be using a real slice of the IPC surface');
  for (const name of used) {
    assert.ok(exposed.has(name), `the console calls bk.${name}, which preload.js does not expose`);
  }
}

// ---- IPC subscriptions happen exactly once ---------------------------------
// preload.js has no off/removeListener on any on* helper, so a subscription made from a
// component effect is permanent and remounting stacks another. That is how one terminal
// becomes two. lib/ipc.js owns every subscription; nothing else may take one.
{
  const offenders = jsFiles.filter((file) => file !== `${APP}/src/lib/ipc.js`
    && /\bbk\.on[A-Z]/.test(stripComments(code[file])));
  assert.deepStrictEqual(offenders, [],
    'only lib/ipc.js may subscribe to bk.on* — preload exposes no way to unsubscribe, so a '
    + 'subscription taken in a component is duplicated on every remount');
  assert.ok(/const ptySinks = new Set\(\)/.test(code[`${APP}/src/lib/ipc.js`]),
    'pty bytes fan out through a Set the terminal can leave, not through a second ipcRenderer handler');
  // Comments, not code: main.jsx explains at length why StrictMode is absent, and a check
  // that cannot tell prose from code would forbid documenting the reason for itself.
  assert.ok(!/StrictMode/.test(stripComments(code[`${APP}/src/main.jsx`])),
    'StrictMode double-invokes effects; the xterm instance and the pty behind it are real');
}

// ---- model output is escaped before it is marked up ------------------------
{
  const raw = jsFiles.filter((file) => /dangerouslySetInnerHTML/.test(stripComments(code[file])));
  assert.deepStrictEqual(raw, [`${APP}/src/components/AssistantMarkdown.jsx`],
    'exactly one file may assign HTML, and it must be the one that runs BKMarkdown first');
  assert.ok(/renderMarkdown/.test(code[`${APP}/src/components/AssistantMarkdown.jsx`]),
    'assistant replies go through the escaping renderer');
  assert.ok(/import '\.\.\/\.\.\/markdown\.js'/.test(code[`${APP}/src/main.jsx`]),
    'markdown.js is imported for its side effect and never forked — tools/markdown-selftest.js '
    + 'require()s the same file, so it must stay CommonJS-loadable');
}

// ---- house rules ------------------------------------------------------------
{
  const css = cssFiles.map((file) => stripComments(code[file])).join('\n');
  // Matches the declaration, not the word. backdrop-filter and vibrancy destroy each other
  // (electron#39529, measured in glass-lab); this window is opaque and sets no vibrancy.
  assert.ok(!/(?:^|[;{\s])(?:-webkit-)?backdrop-filter\s*:/im.test(css),
    'the console stylesheet must not use backdrop-filter');
  assert.ok(!/(?:^|[;{\s])(?:-webkit-)?backdrop-filter\s*:/im.test(stripComments(read(`${DIST}/index.html`))),
    'nor may it reach the built output');
  assert.ok(/prefers-reduced-motion/.test(css), 'the OS reduced-motion setting is honoured');
  assert.ok(/reduce-motion/.test(css), "and so is the app's own appearance.reduceMotion");
  assert.ok(jsFiles.some((file) => /reduce-motion/.test(code[file])),
    'which something has to actually set on the body');
  assert.ok(/button:active\s*\{\s*transform:\s*scale\(\.97\)/.test(css), 'buttons acknowledge the press');

  // The window is a column of flex children and every one of them has to agree to shrink,
  // or the transcript stops filling the space and the composer floats mid-screen above a
  // band of empty background.
  //
  // This is here because it actually happened: inserting .shell between body and .body
  // broke the chain, and `npm test` and SMOKE both stayed green while the bottom half of
  // the window was blank. Neither can see layout. A screenshot caught it, and this keeps
  // it caught.
  const rule = (selector) => {
    const match = css.match(new RegExp(`(?:^|[},])\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm'));
    return match ? match[1] : '';
  };
  // #root is in this list because it is where the chain actually broke: React mounts into
  // <div id="root">, so body's flex column has exactly one child, and giving .shell flex:1
  // does nothing while #root is still a plain block. The symptom was a window whose bottom
  // half was empty; the cause was one box nobody had styled.
  for (const selector of ['#root', '.shell', '.body']) {
    const body = rule(selector);
    assert.ok(body, `${selector} must be styled — it is a load-bearing box in the window's flex column`);
    assert.ok(/min-height:\s*0/.test(body),
      `${selector} needs min-height:0 or it refuses to shrink and its children overflow instead of scrolling`);
  }
  assert.ok(/position:\s*relative/.test(rule('.body')),
    '.body is the positioning context the results panel slides in against');

  // Opening the drawer must not animate a layout property. transform and opacity are the
  // only two the compositor can do without a reflow, and this window's rule is both.
  const shell = rule('.shell');
  assert.ok(/transition:\s*transform/.test(shell) && !/transition:[^;]*\b(width|margin|left|padding)\b/.test(shell),
    'the session drawer opens by transform — animating width would reflow the transcript every frame');

  const consoleWindow = main.slice(main.indexOf('function createConsoleWindow'),
    main.indexOf('function createConsoleWindow') + 1600);
  assert.ok(!/vibrancy/.test(consoleWindow),
    'the console window is opaque on purpose — adding vibrancy would break its stylesheet');
}

// ---- the built page, which is what actually ships ---------------------------
// The dev server needs 'unsafe-eval' and a websocket back to a loopback port. That
// relaxation lives in an apply:'serve' plugin so it cannot reach a build — and this is
// where that claim gets checked rather than assumed.
{
  const html = read(`${DIST}/index.html`);
  const shipped = stripComments(html);
  const csp = (shipped.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1];
  assert.ok(csp, 'the window that renders model output needs a CSP');
  assert.ok(!/unsafe-eval/.test(csp), "the dev server's unsafe-eval must never ship");
  assert.ok(!/127\.0\.0\.1|localhost/.test(shipped), 'nor may a dev server address');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp),
    'the built page has no inline script, so script-src stays at self — stricter than the window it replaced');
  assert.deepStrictEqual([...shipped.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((m) => m[0]), [],
    'and therefore carries no inline script at all');

  // base:'./' in vite.console.config.js. With Vite's default of '/', every asset resolves
  // to the filesystem root under file:// and the window renders an empty body.
  const assets = [...shipped.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length >= 2, 'the built page should reference its bundle and stylesheet');
  for (const asset of assets) {
    assert.ok(asset.startsWith('./'),
      `built asset ${asset} must be a relative reference — the window is opened with loadFile()`);
    assert.ok(fs.existsSync(path.join(root, DIST, asset)), `built page references a missing asset: ${asset}`);
  }
}

// ---- main process wiring ----------------------------------------------------
assert.ok(/function createConsoleWindow\(\)/.test(main), 'main.js creates the console window');
assert.ok(/consoleWin\.loadFile\(path\.join\(UI_ROOT, 'console-dist', 'index\.html'\)\)/.test(main),
  'and loads the built renderer');
assert.ok(/BKU_CONSOLE_DEV_URL/.test(main), 'with a dev-server escape hatch for hot reload');
assert.ok(/for \(const w of \[trayWin, mainWin, consoleWin\]\)/.test(main),
  'the console window must receive broadcasts, or it shows a frozen snapshot of a live system');
assert.ok(/ipcMain\.on\('open-console'/.test(main), 'something has to be able to open it');
assert.ok(/openConsole: \(\) => ipcRenderer\.send\('open-console'\)/.test(preload), 'and the renderer needs the door');

// ---- retirement --------------------------------------------------------------
// The console is retired (docs/v3/design-decisions.md #1): the Canvas carries the
// approval gate, the per-agent work steps, the changed-file list and the terminal, and
// two windows that both talk is what made the app confusing.
//
// This used to assert `Open Console` appeared in main.js — "the tray menu offers it".
// That assertion is now inverted rather than deleted, because the risk changed direction:
// what needs guarding is that nothing the owner can click reaches the retired window, and
// that the escape hatch back to it still exists so the retirement costs an env var to
// undo instead of a revert.
{
  assert.ok(!/label: 'Open Console'/.test(main), 'no menu item may offer the retired console');
  assert.ok(/const CONSOLE_LEGACY = /.test(main), 'the escape hatch that brings it back must stay named');
  assert.ok(/BIGKIJI_CONSOLE/.test(main), 'and it is BIGKIJI_CONSOLE=1');
  assert.ok(/function openWorkspace\(\)/.test(main), 'one function decides which window is the app');
  assert.ok(/if \(CONSOLE_LEGACY\) return createConsoleWindow\(\)/.test(main),
    'and it is the only place that can still choose the console');
  // Every owner-facing door goes through openWorkspace(). A stray createConsoleWindow()
  // in a handler would reopen the window the owner was told is gone.
  const doors = ['open-console', 'openConsole:', 'Alt+Shift+Space', 'openSettings:'];
  for (const door of doors) {
    const at = main.indexOf(door);
    assert.ok(at > 0, `${door} vanished — this list is what makes the check above mean anything`);
    assert.ok(/openWorkspace\(\)/.test(main.slice(at, at + 400)),
      `${door} must open the workspace, not a specific window`);
  }
}
{
  // Closing hides rather than destroys, matching the other windows: a destroyed window
  // would drop the broadcast target and take the terminal mirror with it.
  const block = main.slice(main.indexOf('function createConsoleWindow'));
  assert.ok(/consoleWin\.on\('close'.*e\.preventDefault\(\); consoleWin\.hide\(\)/s.test(block.slice(0, 1700)),
    'close hides the console window instead of destroying it');
}

// ---- the switch the owner asked for ----------------------------------------
{
  const { KEYMAP, matches } = await import(`../${APP}/src/lib/keymap.mjs`);
  assert.equal(KEYMAP.viewChat.key, '1', 'the conversation is one keystroke away');
  assert.equal(KEYMAP.viewTerminal.key, '2', 'and so is the terminal');
  assert.ok(KEYMAP.viewChat.meta && KEYMAP.viewTerminal.meta, 'both are accelerators, not bare digits');
  assert.ok(matches({ key: '1', metaKey: true }, KEYMAP.viewChat), 'and the matcher agrees');
  assert.ok(!matches({ key: '1' }, KEYMAP.viewChat), 'a bare 1 typed into the composer is not a view switch');
  // ⌘N is taken by the app menu (New Console Window). A menu accelerator fires before any
  // renderer keydown, so binding it here would produce a control that silently never runs.
  assert.ok(!Object.values(KEYMAP).some((b) => b.key === 'n'),
    '⌘N belongs to the application menu and cannot be rebound in the renderer');

  const app = stripComments(code[`${APP}/src/App.jsx`]);
  assert.ok(/setView\('terminal'\)/.test(app) && /setView\('chat'\)/.test(app), 'both views are reachable');

  // ---- shift+tab cycles the execution mode ----------------------------------
  //
  // The owner pressed it and nothing happened, in this window and in the REPL, because
  // neither had ever bound it (2026-08-10). Here the browser is the obstacle: Tab is
  // focus navigation, so without preventDefault the key never reaches the handler at all.
  const { EXECUTION_MODE_CYCLE, nextExecutionMode } = await import(`../${APP}/src/lib/keymap.mjs`);
  assert.equal(KEYMAP.cycleMode.key, 'tab');
  assert.ok(KEYMAP.cycleMode.shift, 'it is shift+tab, not tab');
  assert.ok(!KEYMAP.cycleMode.meta, 'and not an accelerator — no ⌘ in it');
  assert.ok(matches({ key: 'Tab', shiftKey: true }, KEYMAP.cycleMode), 'the matcher accepts the real event shape');
  assert.ok(!matches({ key: 'Tab' }, KEYMAP.cycleMode), 'a bare Tab still moves focus between fields');
  assert.ok(!matches({ key: '1', metaKey: true, shiftKey: true }, KEYMAP.viewChat),
    '⇧⌘1 is not ⌘1 — shift is checked in both directions');
  assert.ok(/matches\(event, KEYMAP\.cycleMode\)[\s\S]{0,220}event\.preventDefault\(\)/.test(app),
    'the handler must preventDefault or the browser moves focus and the mode never changes');
  assert.ok(/executionMode: nextExecutionMode\(/.test(app), 'and it writes the next mode through the settings store');
  assert.ok(/getState\(\)\.settings/.test(app),
    'read the mode at press time — this effect has an empty dep list, so a captured value is the one from mount');

  // Two spellings of one list, held together by this assertion rather than by a comment.
  // settings.json says `auto`; the terminal says `auto-edit`; transportMode is the bridge.
  const { MODE_CYCLE, transportMode } = createRequire(import.meta.url)('../src/domain/terminal/cli-theme.js');
  assert.deepEqual([...EXECUTION_MODE_CYCLE], MODE_CYCLE.map(transportMode),
    'the console and the terminal must cycle the same modes in the same order');
  assert.equal(nextExecutionMode('ask'), 'plan');
  assert.equal(nextExecutionMode('demo'), 'ask', 'the wrap lands on the tightest mode, not the loosest');
  assert.equal(nextExecutionMode('manual'), 'ask',
    'a mode retired from the list still advances rather than sticking');

  // A select the keystroke can reach. Cycling to a value the dropdown cannot show would
  // leave the owner looking at a blank control wondering what mode they are in.
  const composer = stripComments(code[`${APP}/src/components/Composer.jsx`]);
  for (const mode of EXECUTION_MODE_CYCLE) {
    assert.ok(composer.includes(`value="${mode}"`), `the composer's mode select offers ${mode}`);
  }
  const terminal = stripComments(code[`${APP}/src/components/TerminalView.jsx`]);
  assert.ok(/api\.ptyInput/.test(terminal) && /onPtyData/.test(terminal), 'the terminal is wired to the real pty');
  assert.ok(/openMain\(\)/.test(app), 'the 3D scene is one button away rather than underneath');
}

// ---- specialist panes and the approval gate ---------------------------------
// A pane per assignment is only worth having if it shows the real process. These pin that
// it is fed by the live run/task channels rather than a mock, and that the approval echoes
// the exact hashes the coordinator demands — approve() throws STALE_RUN_REVISION /
// STALE_PLAN_HASH / STALE_DISCLOSURE_HASH otherwise, and an approval button that always
// fails is worse than none.
{
  const ipc = stripComments(code[`${APP}/src/lib/ipc.js`]);
  assert.ok(/onRunEvent/.test(ipc) && /onTaskLog/.test(ipc) && /onTaskEvent/.test(ipc),
    'panes are driven by the live run and task channels');
  assert.ok(/listRuns/.test(stripComments(code[`${APP}/src/App.jsx`])),
    'a run already waiting when the window opens is picked up');

  // Run the real payload builder rather than grepping the component for field names.
  const { buildApprovalPayload, approvalSummary, isAwaitingDecision, isBlocked } =
    await import(`../${APP}/src/lib/approval-payload.mjs`);

  const run = {
    id: 'run-7', revision: 3, planHash: 'plan0123456789abcdef',
    disclosureHash: 'disc0123456789abcdef', status: 'AWAITING_APPROVAL',
    assignments: [{ taskId: 't1' }],
  };
  const payload = buildApprovalPayload(run);
  assert.equal(payload.id, 'run-7');
  assert.equal(payload.revision, 3, 'approval echoes the revision');
  assert.equal(payload.planHash, 'plan0123456789abcdef', 'and the plan hash');
  assert.equal(payload.disclosureHash, 'disc0123456789abcdef', 'and the disclosure hash');
  assert.equal(payload.idempotencyKey, 'console-run-7-3',
    'and carries an idempotency key so a double click is not a double start');
  assert.notEqual(buildApprovalPayload({ ...run, revision: 4 }).idempotencyKey, payload.idempotencyKey,
    'a new revision is a different thing to approve, so it gets a different key');

  // Both waiting states are surfaced — a blocked run must not look approvable.
  assert.ok(isAwaitingDecision({ ...run, status: 'SECURITY_BLOCKED' }), 'a sandbox refusal is still shown');
  assert.ok(isBlocked({ ...run, status: 'SECURITY_BLOCKED' }));
  assert.equal(buildApprovalPayload({ ...run, status: 'SECURITY_BLOCKED' }), null,
    'but it can never produce an approval payload');
  assert.equal(buildApprovalPayload({ ...run, status: 'EXECUTING' }), null,
    'and neither can a run that is already going');
  assert.ok(/refused/.test(approvalSummary({ ...run, status: 'SECURITY_BLOCKED' }).title),
    'the copy says the sandbox refused it rather than inviting a click');
  assert.ok(/rev 3/.test(approvalSummary(run).detail), 'the owner is shown what they are agreeing to');

  const bar = stripComments(code[`${APP}/src/components/ApprovalBar.jsx`]);
  assert.ok(/disabled=\{blocked/.test(bar), 'a sandbox refusal disables the button rather than failing on click');

  // What the owner is agreeing to, not just that they are agreeing.
  //
  // This bar showed a count of specialists and a row of hash prefixes. Everything below
  // already travelled inside the same run object and was dropped by the render: which
  // agent, on which model, allowed to write or not, and — the one that can invalidate
  // the whole plan — a question the plan asked the owner and nobody answered.
  const { approvalPlan } = await import(`../${APP}/src/lib/approval-payload.mjs`);
  const full = approvalPlan({
    ...run,
    stage: 'execution',
    promptSpec: { goal: 'Rebuild the conversation UI', constraints: ['keep the hashes'], questions: ['Current version or a snapshot?'] },
    assignments: [
      { taskId: 't1', role: 'leader', agent: 'builder', provider: 'claude-code', model: 'claude-opus-5', title: 'Implement', write: true },
      { taskId: 't2', role: 'debug', agent: 'checker', provider: 'glm', model: 'glm-5.2', title: 'Verify', write: false },
      { taskId: 't3', role: 'ui', provider: 'codex', title: 'Polish' },
    ],
    disclosures: [{ provider: 'glm', files: [{ path: 'src/a.js' }, { path: 'src/b.js' }] }],
  });
  assert.equal(full.goal, 'Rebuild the conversation UI');
  assert.deepEqual(full.questions, ['Current version or a snapshot?'], 'an unanswered question has to reach a screen');
  assert.equal(full.writes, true, 'a run containing a writer says so before it is approved');
  assert.equal(full.rows[0].access, 'write');
  assert.equal(full.rows[1].access, 'read');
  assert.equal(full.rows[2].access, '', 'an assignment the coordinator never marked gets no badge, not a guessed one');
  assert.equal(full.rows[1].engine, 'glm-5.2', 'the vendor is dropped when the model id already opens with it');
  assert.equal(full.rows[0].engine, 'claude-code claude-opus-5', 'and kept when it does not');
  assert.equal(full.reads[0].files.length, 2, 'the files come from the disclosure the hash is sealed against');
  assert.equal(approvalPlan({ ...run, status: 'EXECUTING' }), null, 'nothing to approve, nothing to describe');
  // Read-only runs exist now: the deliberation lenses never write, and the coordinator
  // releases them without a gate. If one ever does reach this bar it must not be
  // labelled as writing.
  assert.equal(approvalPlan({ ...run, assignments: [{ taskId: 't1', write: false }] }).writes, false);

  // One line per provider, not one per assignment. Disclosures are per assignment, so a
  // run whose leader and ui roles both landed on codex printed `codex reads: …` twice
  // with the same files — the owner saw it. A duplicated list in an approval prompt
  // teaches the eye to skim the one thing it must not skim.
  const doubled = approvalPlan({
    ...run,
    disclosures: [
      { provider: 'codex', files: [{ path: 'src/a.js' }, { path: 'src/b.js' }] },
      { provider: 'codex', files: [{ path: 'src/b.js' }, { path: 'src/c.js' }] },
      { provider: 'glm', files: [{ path: 'src/d.js' }] },
    ],
  });
  assert.equal(doubled.reads.length, 2, 'two codex assignments are one codex line');
  const codex = doubled.reads.find((entry) => entry.provider === 'codex');
  assert.deepEqual(codex.files, ['src/a.js', 'src/b.js', 'src/c.js'],
    'the union, in first-seen order, with the file named twice named once');
  assert.ok(doubled.reads.every((entry) => !('seen' in entry)),
    'the dedupe Set is an implementation detail and must not cross into the payload');

  // Groundwork that did not happen has to reach the bar. A run that never had a
  // deliberation stage stays null rather than warning about an absence nobody planned.
  assert.equal(approvalPlan(run).groundwork, null, 'no deliberation, no warning');
  const blind = approvalPlan({
    ...run,
    groundwork: { lenses: 2, completed: 0, steps: 0,
      failures: [{ lens: 'risk', title: '危険点', provider: 'glm', model: 'glm-4.7-flash', status: 'failed', reason: '429 rate-limit' }] },
  });
  assert.equal(blind.groundwork.completed, 0);
  assert.equal(blind.groundwork.failures[0].reason, '429 rate-limit',
    'the reason survives to the screen — a rate limit and a missing model are different problems');
}

// ---- raw provider output ----------------------------------------------------
{
  const { stripAnsi, appendBounded, LOG_LINES } = await import(`../${APP}/src/lib/ansi.mjs`);
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red',
    'provider output is stripped of escape sequences before it reaches the DOM');
  assert.equal(stripAnsi('\x1b[2Kplain'), 'plain', 'including cursor control, not just colour');

  // The log is bounded; a long run must not grow the DOM without limit.
  let lines = [];
  for (let i = 0; i < LOG_LINES + 50; i += 1) lines = appendBounded(lines, `line ${i}`);
  assert.equal(lines.length, LOG_LINES, 'the log is capped');
  assert.equal(lines[lines.length - 1], `line ${LOG_LINES + 49}`, 'and keeps the newest, not the oldest');

  const panes = stripComments(code[`${APP}/src/components/SpecialistPanes.jsx`]);
  assert.ok(!/dangerouslySetInnerHTML/.test(panes), 'raw CLI output is set as text, never parsed');
}

// ---- the change counter ------------------------------------------------------
// #diffStat sat empty from the day this window was built while the CLI rendered real
// diffs, so the surface the owner approves from showed less than the one they do not. It
// is a counter, not a diff view, and these pin the two properties that make the number
// trustworthy rather than decorative.
//
// They now run against stream-steps.js countPatch(), which is the code that actually
// produces the numbers this window shows. The window used to run its own copy over
// task:log, and that copy could never work: task-runner.js flattens every chunk through
// cleanText() before it is emitted, so the counter was handed a single line with no
// newlines in it and reported 0/0 for the entire life of the window. The module is
// deleted; two of these six cases failed against countPatch when they were moved, which
// is exactly why they were worth moving rather than deleting with it.
{
  const { countPatch } = await import('../src/domain/pi-agent/stream-steps.js');

  assert.deepEqual(countPatch('+ this is prose\n- and so is this'), { added: 0, removed: 0 },
    'text before any hunk header is not a patch');
  assert.deepEqual(countPatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n ctx\n+one\n+two\n-gone'),
    { added: 2, removed: 1 }, 'file headers between diff --git and the first @@ are not content');
  assert.deepEqual(countPatch('@@ -1,0 +1,2 @@\n+++i;\n+count++;'), { added: 2, removed: 0 },
    'inside a hunk, +++i; is a line somebody added — not a file header');
  assert.deepEqual(countPatch('@@ -1,1 +0,0 @@\n----'), { added: 0, removed: 1 },
    'and a removed markdown rule is a removed line');
  assert.deepEqual(countPatch('@@ -1,0 +1,1 @@\n+real\nsummary:\n- updated x\n- ran tests\n- all green'),
    { added: 1, removed: 0 },
    'a hunk ends at the first line that is not diff-shaped; what the provider narrates afterwards is prose');
  assert.deepEqual(countPatch('@@ -1,0 +1,1 @@\n+real\n\nFAIL x\n- Expected\n+ Received'), { added: 1, removed: 0 },
    'including jest output, which is full of leading + and -');

  // And the window sums them from the steps it already holds, rather than re-parsing a
  // string that no longer has the newlines the parse depends on.
  const ipc = read(`${APP}/src/lib/ipc.js`);
  assert.ok(!/diff-count/.test(ipc), 'the window must not re-parse task:log for a diff count');
  assert.ok(/progressOf\(steps\)/.test(ipc), 'the change counter is a fold over task:step');
}

// ---- session history ---------------------------------------------------------
// The drawer replaced a strip that showed at most eight of 53 sessions and could not
// search. These pin the two things that make it a history rather than a prefix.
{
  const { groupSessions, filterSessions, sessionLabel } = await import(`../${APP}/src/lib/sessions.mjs`);

  // A fixed clock, so the day boundaries are checked rather than hoped for.
  //
  // Offsets are built from local midnight rather than written as UTC literals: the buckets
  // are defined in the owner's own day, so a UTC fixture would pass in London and fail here
  // in JST, where 23:50Z is already the following morning.
  const now = new Date('2026-08-03T12:00:00Z').getTime();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const MIN = 60000;
  const at = (offsetMs, tag) => {
    const iso = new Date(midnight.getTime() + offsetMs).toISOString();
    return { id: tag, updatedAt: iso, promptSummary: tag };
  };
  const groups = groupSessions([
    at(9 * 60 * MIN, 'today'),        // 09:00 this morning
    at(-10 * MIN, 'yesterday'),       // ten minutes before midnight
    at(-4 * 1440 * MIN, 'week'),
    at(-20 * 1440 * MIN, 'month'),
    at(-200 * 1440 * MIN, 'older'),
  ], now);
  assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'week', 'month', 'older'],
    'sessions are bucketed by day, and empty buckets do not appear');
  // Ten minutes before midnight is yesterday's work, not "within the last 24 hours".
  assert.equal(groups[1].items[0].id, 'yesterday', 'the boundary is local midnight, not a rolling day');

  assert.equal(filterSessions([{ promptSummary: 'Fix the CSP' }, { promptSummary: 'other' }], 'csp').length, 1,
    'search is case-insensitive over what the owner actually typed');
  assert.equal(filterSessions([{ id: 'a' }, { id: 'b' }], '').length, 2, 'an empty query hides nothing');

  // Falling back to the generated id produced a list of "session-msb1cu3c-e744b1", which
  // tells the owner nothing about which one to click.
  assert.equal(sessionLabel({ promptSummary: 'Rebuild the console  window' }), 'Rebuild the console window',
    'the label is what was asked, whitespace-collapsed');
  assert.ok(sessionLabel({ promptSummary: 'x'.repeat(80) }).length <= 34, 'and it is capped');
  assert.ok(!/^session-/.test(sessionLabel({ id: 'session-abc', updatedAt: '2026-08-03T09:00:00Z' })),
    'with a time rather than an id when there is no summary');

  // The drawer is only honest if it asks for more than the route's default of 40.
  const client = read('src/domain/server/daemon-client.js');
  assert.ok(/\/api\/sessions\?limit=/.test(client),
    'the console asks for the full history — the route defaults to 40 and there are more than that on disk');
}

// ---- the work timeline --------------------------------------------------------
{
  const { foldSteps, progressOf, changedFiles } = await import(`../${APP}/src/lib/steps.mjs`);

  const events = [
    { taskId: 't1', toolUseId: 'a', phase: 'start', tool: 'Read', target: '/r/x.js', at: '2026-08-03T00:00:00Z' },
    { taskId: 't1', toolUseId: 'a', phase: 'end', ok: true, at: '2026-08-03T00:00:01Z' },
    { taskId: 't1', toolUseId: 'b', phase: 'start', tool: 'Edit', target: '/r/y.css', added: 12, removed: 3, at: '2026-08-03T00:00:02Z' },
    { taskId: 't1', toolUseId: 'b', phase: 'end', ok: true, at: '2026-08-03T00:00:03Z' },
    { taskId: 't1', toolUseId: 'c', phase: 'start', tool: 'Bash', target: 'npm test', at: '2026-08-03T00:00:04Z' },
  ];
  const steps = foldSteps([], events);
  assert.equal(steps.length, 3, 'an end updates its start rather than adding a row');
  assert.deepEqual(steps.map((s) => s.status), ['ok', 'ok', 'running'],
    'a step that has started and not returned is the running one');
  assert.equal(steps[0].durationMs, 1000, 'and a returned one knows how long it took');

  // An end with no matching start is dropped rather than invented.
  assert.equal(foldSteps([], [{ taskId: 't1', toolUseId: 'zz', phase: 'end', ok: true }]).length, 0,
    'a step nobody watched begin is not drawn');

  const progress = progressOf(steps);
  assert.equal(progress.done, 2);
  assert.equal(progress.total, 3, 'the denominator is work actually seen — the provider never announces a total');
  assert.equal(progress.added, 12, 'only completed steps count toward the change totals');
  assert.ok(progress.running, 'and the running step is identified');

  // Failures are visible, not swallowed.
  const failed = foldSteps(steps, [{ taskId: 't1', toolUseId: 'c', phase: 'end', ok: false, errorText: 'exit 1' }]);
  assert.equal(progressOf(failed).failed, 1, 'a failed tool is counted as failed');
  assert.equal(failed[2].errorText, 'exit 1', 'with the reason kept');

  // Only successful writes become results — proposing a file that was never written, or
  // one an Edit failed on, would be a claim the run did not earn.
  const files = changedFiles(failed);
  assert.deepEqual(files.map((f) => f.path), ['/r/y.css'], 'reads and failed steps are not results');
  assert.equal(files[0].added, 12);

  const timeline = stripComments(code[`${APP}/src/components/WorkTimeline.jsx`]);
  assert.ok(!/dangerouslySetInnerHTML/.test(timeline), 'tool output reaches the timeline as text');
  const panes = stripComments(code[`${APP}/src/components/SpecialistPanes.jsx`]);
  assert.ok(/pane-log/.test(panes),
    'the raw log panes survive alongside the timeline — if the parser goes quiet the owner '
    + 'must still be able to see what a run is doing before approving it');
}

console.log('console window selftest: PASS · every bk.* the window calls exists in preload · only lib/ipc.js '
  + 'subscribes · one file may assign HTML · opaque with no backdrop-filter · the built page ships no inline '
  + 'script, no unsafe-eval and only relative assets · broadcasts reach it · chat and terminal both reachable · '
  + 'one pane per real assignment · approval echoes the exact hashes and refuses to build one for a blocked run · '
  + 'the change counter counts patches, not prose');
