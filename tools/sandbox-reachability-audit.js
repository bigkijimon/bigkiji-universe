'use strict';

// Which of BigKiji's own data can a pi agent actually reach?
//
// There are two boundaries and they do not agree. Checking only one is how a file gets
// written forever and never read — that is exactly what happened to the run ledger
// before it was moved into the repo (see run-ledger.js).
//
//   SandboxPolicyResolver (this app)  taskRoot is prepended to allowRead, so anything
//                                     under the run's cwd looks permitted.
//   pi-sandbox (OS-enforced)          ~/.pi/agent/sandbox.json denies wide and punches
//                                     holes. Arrays merge as a union with the project
//                                     file, so a project file can only ADD.
//
// The stricter of the two is what an agent actually experiences. This tool reports that.
//
// Run: node tools/sandbox-reachability-audit.js
// Exit 1 if something the app treats as agent-facing is unreachable.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const GLOBAL = path.join(HOME, '.pi', 'agent', 'sandbox.json');
const DATA = path.join(HOME, 'BigKijiUniverse');
const REPO = path.resolve(__dirname, '..', '..');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|[/\\])/, HOME));
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** What pi-sandbox permits, given the global plus the project file for this cwd. */
function piSandbox(cwd) {
  const g = (readJson(GLOBAL) || {}).filesystem || {};
  const local = (readJson(path.join(cwd, '.pi', 'sandbox.json')) || {}).filesystem || {};
  const merge = (key) => [...new Set([...(g[key] || []), ...(local[key] || [])])];
  const roots = (list) => list
    .filter((p) => !String(p).startsWith('*') && !String(p).startsWith('.env'))
    .map((p) => (String(p) === '.' ? path.resolve(cwd) : expand(p)));
  return {
    allowRead: roots(merge('allowRead')),
    allowWrite: roots(merge('allowWrite')),
    // denyRead is soft — allowRead overrides it — so it is not consulted for the verdict.
    denyRead: merge('denyRead'),
  };
}

const permitted = (roots, target) => roots.some((r) => inside(r, target));

// What the app produces, and who is supposed to read it. "agent" means a pi agent or an
// external coding agent is expected to open it; "daemon" means only the engine touches it.
const SURFACES = [
  { path: path.join(REPO, 'app', 'docs', 'v3', 'run-ledger.md'), audience: 'agent',
    why: 'the English record of what runs did — the whole point is that an agent reads it' },
  { path: path.join(REPO, 'app', 'docs', 'v3', 'prompt-improvements.md'), audience: 'agent',
    why: 'where an agent writes its proposals' },
  { path: path.join(REPO, 'app', 'docs'), audience: 'agent',
    why: 'architecture and design decisions an agent needs before changing anything' },
  { path: path.join(DATA, 'knowledge', 'skills.json'), audience: 'agent',
    why: 'which skills exist — an agent that cannot see this re-derives it every run' },
  { path: path.join(DATA, 'knowledge', 'failure_memory.json'), audience: 'agent',
    why: 'what already failed and what fixed it' },
  { path: path.join(DATA, 'knowledge', 'model_performance.json'), audience: 'daemon',
    why: 'routing input, consumed inside the engine' },
  { path: path.join(DATA, 'knowledge', 'knowledge_graph.json'), audience: 'daemon',
    why: 'engine-side index' },
  { path: path.join(DATA, 'knowledge', 'task_state.json'), audience: 'daemon',
    why: 'engine state, holds past prompt text' },
  { path: path.join(DATA, 'reports'), audience: 'daemon',
    why: 'the Electron report surface, read by the GUI' },
  { path: path.join(DATA, 'sessions'), audience: 'daemon', why: 'transcripts' },
  { path: path.join(DATA, 'ideas'), audience: 'daemon', why: 'idea drafts' },
  { path: path.join(DATA, 'logs'), audience: 'daemon', why: 'engine logs' },
  { path: path.join(DATA, 'Generated'), audience: 'daemon', why: 'model outputs and run scripts' },
  { path: path.join(DATA, 'state', 'remote.json'), audience: 'nobody',
    why: 'pairing token — must NOT be broadly readable' },
];

const CWDS = [
  { label: 'daemon run (BIGKIJI_WORKSPACE)', cwd: HOME },
  { label: 'department Pi (English_School)', cwd: path.join(HOME, 'Documents/CEOBigKiji/English_School') },
  { label: 'app Pi (repo)', cwd: path.join(REPO, 'app') },
];

let failures = 0;
console.log('sandbox reachability audit — what a pi agent can actually open\n');

for (const { label, cwd } of CWDS) {
  const box = piSandbox(cwd);
  console.log(`## ${label}`);
  console.log(`   cwd ${cwd}`);
  for (const s of SURFACES) {
    const r = permitted(box.allowRead, s.path);
    const w = permitted(box.allowWrite, s.path);
    const mark = s.audience === 'agent'
      ? (r ? 'ok  ' : 'FAIL')
      : s.audience === 'nobody'
        ? (r ? 'WARN' : 'ok  ')
        : '..  ';
    if (mark === 'FAIL') failures += 1;
    const rel = s.path.startsWith(DATA) ? '~/BigKijiUniverse/' + path.relative(DATA, s.path)
      : path.relative(path.dirname(REPO), s.path);
    console.log(`   ${mark} ${r ? 'r' : '-'}${w ? 'w' : '-'}  ${rel}`);
    if (mark === 'FAIL') console.log(`        ↳ needed because: ${s.why}`);
    if (mark === 'WARN') console.log(`        ↳ readable, and it should not be: ${s.why}`);
  }
  console.log('');
}

if (failures) {
  console.log(`✖ ${failures} agent-facing surface(s) unreachable.`);
  console.log('  Fix by moving the file to a granted root, or by adding the smallest');
  console.log('  possible allowRead entry to the project .pi/sandbox.json — never by');
  console.log('  granting a whole directory that also holds tokens or transcripts.');
  process.exit(1);
}
console.log('✓ every agent-facing surface is reachable, and the pairing token is not.');
