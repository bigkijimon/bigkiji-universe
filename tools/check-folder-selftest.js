'use strict';

// The failure this file exists to prevent: the owner sends five screenshots from the
// phone, the Mac reads the folder, and reports it empty. With "Optimize Mac Storage"
// on, an uploaded file arrives as a zero-byte stub named `.thing.jpg.icloud` and the
// bytes stay in iCloud. Every assertion below is about not lying to the owner in that
// situation — neither by hiding what was sent, nor by presenting an empty stub as if
// it were the file.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { kindOf, realName, ignored, inventory, materialise, layout, ensure, summarise, human } =
  require('../src/core/check-folder');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-check-'));
const inputDir = path.join(root, 'input');
fs.mkdirSync(inputDir, { recursive: true });
const write = (name, body = 'x') => fs.writeFileSync(path.join(inputDir, name), body);

// ---- a placeholder is the file, not a file of its own ------------------------
assert.deepStrictEqual(realName('.holiday.jpg.icloud'), { name: 'holiday.jpg', placeholder: true },
  'the stub has to be read back as the name the owner sent');
assert.deepStrictEqual(realName('holiday.jpg'), { name: 'holiday.jpg', placeholder: false });
assert.deepStrictEqual(realName('.hidden'), { name: '.hidden', placeholder: false },
  'a dotfile that is not a stub keeps its own name');

// ---- what kind of thing it is ------------------------------------------------
assert.equal(kindOf('shot.PNG'), 'image', 'the phone writes extensions in either case');
assert.equal(kindOf('clip.mov'), 'video');
assert.equal(kindOf('links.txt'), 'text');
assert.equal(kindOf('ref.webloc'), 'link');
assert.equal(kindOf('deck.pdf'), 'document');
assert.equal(kindOf('voice.m4a'), 'audio');
assert.equal(kindOf('mystery.xyz'), 'other',
  'an unknown kind is still reported — silently dropping what the owner sent is the one unacceptable outcome');

// ---- bookkeeping the owner did not put there ---------------------------------
assert.equal(ignored('.DS_Store'), true);
assert.equal(ignored('.holiday.jpg.icloud'), false, 'a stub is not noise; it is the whole point');
assert.equal(ignored('notes.txt'), false);

// ---- the inventory sees stubs and real files alike ---------------------------
write('notes.txt', 'https://example.com/watch\n');
write('.shot.png.icloud', '');           // what the phone actually leaves behind
write('.DS_Store', 'junk');
fs.mkdirSync(path.join(inputDir, 'subdir'));

const items = inventory(inputDir);
assert.deepStrictEqual(items.map((item) => item.name).sort(), ['notes.txt', 'shot.png'],
  'the stub is listed under its real name, the noise is not listed, and a directory is not an input');
const stub = items.find((item) => item.name === 'shot.png');
assert.equal(stub.placeholder, true, 'and it is marked as not yet downloaded');
assert.equal(stub.kind, 'image', 'its kind comes from the real name, not from ".icloud"');
assert.equal(items.find((item) => item.name === 'notes.txt').placeholder, false);

// ---- newest first ------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-order-'));
  fs.writeFileSync(path.join(dir, 'old.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'b');
  fs.utimesSync(path.join(dir, 'old.txt'), new Date(0), new Date('2020-01-01T00:00:00Z'));
  assert.deepStrictEqual(inventory(dir).map((item) => item.name), ['new.txt', 'old.txt'],
    'the thing just sent is the thing being asked about');
}

// ---- downloading: a stub that never arrives is reported, not faked ------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-dl-'));
  fs.writeFileSync(path.join(dir, '.late.png.icloud'), '');
  // `brctl` is replaced by something that always fails, which is what being offline
  // looks like. The answer must be "still waiting", never "here is your empty file".
  const result = materialise(dir, { brctl: '/nonexistent/brctl', timeoutMs: 900, pollMs: 100 });
  return result.then((outcome) => {
    assert.equal(outcome.requested, 1);
    assert.deepStrictEqual(outcome.arrived, [], 'nothing arrived, and nothing may claim to have');
    assert.deepStrictEqual(outcome.stillPending, ['late.png'], 'the owner is told it is still coming');
    rest();
  });
}

function rest() {
  // ---- nothing to download is not an error ------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-none-'));
  fs.writeFileSync(path.join(dir, 'here.txt'), 'a');
  materialise(dir, { brctl: '/nonexistent/brctl', timeoutMs: 300 }).then((outcome) => {
    assert.equal(outcome.requested, 0, 'a folder with no stubs must not shell out at all');

    // ---- the drawers -----------------------------------------------------------
    const dirs = layout('/tmp/check');
    assert.equal(dirs.input, path.join('/tmp/check', 'input'));
    assert.equal(dirs.deliverables, path.join('/tmp/check', 'deliverables'));
    assert.equal(dirs.reports, path.join('/tmp/check', 'reports'));

    const made = ensure(path.join(root, 'made'));
    for (const key of ['root', 'input', 'deliverables', 'reports']) {
      assert.ok(fs.existsSync(made[key]), `${key} has to exist after ensure()`);
    }
    assert.doesNotThrow(() => ensure(path.join(root, 'made')), 'ensure() runs twice without complaint');

    // ---- the summary says what is there ----------------------------------------
    assert.equal(summarise([]), 'input: 空');
    const text = summarise(items);
    assert.match(text, /input: 2件/);
    assert.match(text, /shot\.png/, 'the stub appears under its real name here too');
    assert.match(text, /☁️/, 'and is marked as not yet downloaded, so a 0B size is not read as an empty file');
    assert.equal(human(512), '512B');
    assert.equal(human(2048), '2KB');
    assert.equal(human(5 * 1024 * 1024), '5.0MB');

    // ---- the check root is resolved by the app, not hardcoded at the call site --
    const { createPathConfig } = require('../src/core/path-config');
    const paths = createPathConfig({ appRoot: path.join(__dirname, '..'), home: '/Users/test', env: {} });
    assert.equal(paths.checkRoot,
      '/Users/test/Library/Mobile Documents/com~apple~CloudDocs/BigkijiUniverse-Check',
      'iCloud Drive is the only place both the Mac and the phone can reach without a server');
    const overridden = createPathConfig({ appRoot: path.join(__dirname, '..'), home: '/Users/test',
      env: {}, saved: { checkRoot: '/Volumes/Share/check' } });
    assert.equal(overridden.checkRoot, '/Volumes/Share/check',
      'a machine on a different iCloud account must be able to point this somewhere real');
    // `~` expands against the running process's home, the same as every other saved
    // path here (uiRoot, knowledgeRoot). Pinned so the inconsistency is a choice.
    const tilde = createPathConfig({ appRoot: path.join(__dirname, '..'), home: '/Users/test',
      env: {}, saved: { checkRoot: '~/elsewhere' } });
    assert.equal(tilde.checkRoot, path.join(os.homedir(), 'elsewhere'));

    // ---- the standing rule is carried by PiAgent, not by a note somewhere ------
    //
    // The owner's rule — finished work is saved where the phone can run it — is only
    // real if it reaches the agent's prompt. Scoped to the app's own skills root so
    // this stays fast and does not depend on what is installed on the machine.
    {
      const { SkillRegistry, APP_SKILLS } = require('../src/domain/pi-agent/skill-registry');
      const registry = new SkillRegistry({ roots: [APP_SKILLS] });
      const skill = registry.scan().find((entry) => entry.id === 'bku-check');
      assert.ok(skill, 'skills/bku-check must be discoverable, or the rule is just a file nobody reads');
      assert.equal(skill.origin, 'app', 'it ships with the app rather than depending on ~/.claude');
      const brief = String(registry.brief('ゲームの完成品をiPhoneで動かせる形でBKU-Checkに保存して'));
      assert.match(brief, /Skill: bku-check/, 'and it has to be selected when the owner asks for exactly that');
      const body = fs.readFileSync(path.join(APP_SKILLS, 'bku-check', 'SKILL.md'), 'utf8');
      assert.match(body, /JavaScript disabled/,
        'the iOS Quick Look limitation is the one fact that stops us promising a bare HTML file is playable');
      assert.match(body, /faststart/, 'and the video recipe is what makes a deliverable checkable at all');
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log('check-folder selftest: PASS · an iCloud stub is listed under the name the owner sent'
      + ' · unknown kinds are reported rather than dropped · a download that never arrives says so'
      + ' · newest first · the drawers are created idempotently · the root is resolved, not hardcoded'
      + ' · the standing rule reaches the agent prompt');
  }).catch((error) => { console.error(error); process.exit(1); });
}
