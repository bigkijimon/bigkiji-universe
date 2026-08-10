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
// Run: node tools/sandbox-reachability-audit.js   (npm run test:sandbox-reach)
// Exit 1 if something the app treats as agent-facing is unreachable.
//
// Deliberately NOT in `npm test`, and it is the only `test:*` script that is not.
//
// This reads the machine it is standing on — the owner's live ~/.pi/agent/sandbox.json and
// ~/BigKijiUniverse — so its verdict is about this installation, not about the code. In
// the suite it would fail on any checkout that has no pi configured, and pass or fail
// depending on what the owner edited that morning. That is an audit, not a test, and this
// repository has already been bitten twice by suites whose answer depended on the state of
// the machine: paste-turn-selftest passed for months on the owner's private plan cache,
// and conversation-selftest went red whenever the GPU happened to be busy.
//
// Run it by hand after touching a sandbox policy, and before shipping a build.

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
// `from` names the cwds a surface MUST be reachable from. Absent means all of them,
// which is right for BigKiji's own files and wrong for the owner's.
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

  // The owner's actual work, which this audit did not look at.
  //
  // Every surface above belongs to BigKiji — its own docs, its own knowledge files, its
  // own state. The audit passed on 2026-08-10 while the request that prompted all of this
  // ran for an hour with `allowRead: [$HOME]` and `allowWrite:` a folder that had not
  // existed since the CEOBigKiji tree was dismantled. It was green about itself while the
  // owner's materials were unreachable, which is the most flattering kind of wrong.
  { path: path.join(HOME, 'Documents/.bku/INDEX.md'), audience: 'agent', from: ['department Pi (School)'],
    why: 'the entry point every department Pi is meant to read first' },
  { path: path.join(HOME, 'Documents/.bku/knowledge'), audience: 'agent', from: ['department Pi (School)'],
    why: 'the shared instruction layer — folder layout, BKU behaviour, the sandbox reference' },
  { path: path.join(HOME, 'Documents/Admin/経営企画室/会社憲法.md'), audience: 'agent', from: ['department Pi (School)'],
    why: 'the company rules every department is told to follow' },
  { path: path.join(HOME, 'Documents/School/HSAcademyWeb/content'), audience: 'agent', from: ['department Pi (School)'],
    why: 'the H&S teaching materials — the folder the owner asked to have listed' },
  { path: path.join(HOME, 'Documents/School/UpclassApp'), audience: 'agent', from: ['department Pi (School)'],
    why: 'UPCLASS — the other half of that request' },
];

const CWDS = [
  { label: 'daemon run (BIGKIJI_WORKSPACE)', cwd: HOME },
  // The departments left the one-folder vault on 2026-08-09 and now sit directly under
  // ~/Documents. Named rather than discovered because this audit asks "what can a Pi
  // started HERE open", and the answer has to be about a specific real cwd.
  { label: 'department Pi (School)', cwd: path.join(HOME, 'Documents/School') },
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
    // Who has to reach it, not just who may.
    //
    // Every surface used to be demanded from every cwd, which was fine while all of them
    // belonged to BigKiji itself. It stops being fine the moment the owner's own materials
    // are listed: a Pi started in the app repository cannot open the H&S teaching folder,
    // and that is the boundary working, not a defect. Reporting it as FAIL would train
    // whoever runs this to ignore the word.
    const wanted = !s.from || s.from.includes(label);
    const mark = s.audience === 'agent'
      ? (wanted ? (r ? 'ok  ' : 'FAIL') : (r ? '?!  ' : '--  '))
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
