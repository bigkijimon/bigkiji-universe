'use strict';

// Cut at the function, not at a line count.
//
// symbol-index.js has been in this repository with zero importers, and it did not
// work anyway: maskJs treated a *closing* backtick as an opening one, so `templates`
// never emptied and everything after the first template literal in a file was
// blanked as if it were string content. Measured on footer.js, 1 of 9 top-level
// declarations survived and symbolsOf returned nothing — for every file in this
// codebase that uses a template string, which is most of them.
//
// With it fixed, the pruner can send a whole definition instead of fifty lines
// through the middle of two. That matters more than the token count: a window that
// opens mid-body and closes mid-body gives a model a fragment with no signature
// above it and no closing brace below.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { symbolsOf, maskJs, enclosing, mergeRanges } = require('../src/domain/pi-agent/symbol-index');
const { ContextPruner } = require('../src/domain/pi-agent/context-pruner');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

const survives = (source) => /function after/.test(maskJs(`${source}\nfunction after() {}`));

ok('a template literal no longer eats the rest of the file', () => {
  assert.ok(survives('const a = `${x}`;'), 'the closing backtick was pushing a second template instead of popping the first');
  assert.ok(survives('const a = `${x}h ${y}m`;'));
  assert.ok(survives('const a = `${b ? `${c}` : ``}`;'), 'a template inside an interpolation is real nesting and must still work');
  assert.ok(survives('const a = `${f({ k: 1 })}`;'), 'braces inside an interpolation are code, not template body');
  assert.ok(survives('const a = `line\\`escaped`;'));
});

ok('and comments, strings and regexes are still masked', () => {
  // The point of masking is that a declaration mentioned in prose is not a
  // declaration. Breaking that while fixing the backtick would be a trade, not a fix.
  const masked = maskJs([
    '// function commented(){}',
    "const s = 'function inString(){}';",
    '/* function inBlock(){} */',
    'const re = /function inRegex/;',
    'function real() {}',
  ].join('\n'));
  assert.deepEqual(symbolsOf(masked, 'x.js').map((symbol) => symbol.name), ['real'],
    `only the declarations are declarations: ${JSON.stringify(masked)}`);
});

ok('every source file in this repo now yields symbols', () => {
  // The measurement that showed it was broken, kept as the one that shows it is not.
  const files = ['src/cli/tui/footer.js', 'src/cli/tui/transcript.js', 'src/domain/server/daemon.js',
    'src/domain/pi-agent/core-execution-coordinator.js', 'src/domain/pi-agent/critique.js'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const symbols = symbolsOf(source, file);
    assert.ok(symbols.length >= 5, `${file}: ${symbols.length} symbols`);
    assert.equal(maskJs(source).length, source.length, `${file}: masking must preserve offsets`);
    for (const symbol of symbols) {
      assert.ok(Number.isInteger(symbol.startLine) && Number.isInteger(symbol.endLine), `${file}: ${symbol.name} has no line range`);
      assert.ok(symbol.endLine >= symbol.startLine, `${file}: ${symbol.name} ends before it starts`);
    }
  }
});

ok('two hits in one function are one slice', () => {
  assert.deepEqual(mergeRanges([[0, 10], [5, 20], [40, 50]]), [[0, 20], [40, 50]],
    'sending the same body twice is the duplication this module exists to remove');
});

ok('the pruner sends whole definitions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-slice-'));
  for (const file of ['src/cli/tui/footer.js', 'src/cli/tui/transcript.js']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, path.basename(file)));
  }
  const policy = { vaultRoot: root, taskRoot: root, allowRead: [root], allowWrite: [], sandboxPath: root };
  const result = new ContextPruner({}).prepare({ prompt: 'fix the workSegment calculation', policy });
  assert.ok(result.slices.length, 'something relevant was found');
  const slice = result.slices.find((item) => item.path.includes('footer'));
  assert.ok(slice, `footer.js should match a prompt about workSegment: ${JSON.stringify(result.slices)}`);
  // Every range has to start at a definition, not at a line count centred on a hit.
  const source = fs.readFileSync(path.join(root, 'footer.js'), 'utf8').split('\n');
  const bodies = slice.ranges.map((range) => {
    const [start, end] = range.match(/L(\d+)-L(\d+)/).slice(1).map(Number);
    return { range, first: source[start - 1], body: source.slice(start - 1, end).join('\n') };
  });
  for (const { range, first } of bodies) {
    assert.match(first, /^(?:function|class|const|let|var|async|export)\b|^\s*\/\*\*/,
      `${range} opens mid-body: ${JSON.stringify(first)}`);
  }
  const owning = bodies.find((item) => /function workSegment/.test(item.body));
  // This used to pass by a margin of one slot, and that is worth remembering.
  //
  // `prepare()` keeps `indexes.slice(0, 4)` — the first four lines matching ANY search
  // term — and the terms here include "fix", which also matches `toFixed` and the word
  // "fixed" in a comment. On 2026-08-04 adding one ordinary comment containing "fixed
  // width" to footer.js pushed `function workSegment` from the fourth match to the
  // fifth, and the function the prompt named became the one thing not sent. The pruner
  // now hoists definition lines ahead of mentions, so the budget is spent on what was
  // asked about rather than on wherever the words happened to fall. If this ever fails
  // again, check that hoist before blaming the fixture.
  assert.ok(owning, `the function the prompt named has to be one of them: ${slice.ranges.join(', ')}`);
  assert.ok(/^\}/m.test(owning.body), 'and its closing brace comes with it — a fragment is worse than a smaller whole');
  fs.rmSync(root, { recursive: true, force: true });
});

ok('a file with no symbols still gets context', () => {
  // Markdown, JSON, a language the scanner does not read: the line window is what
  // is left, so this is an improvement where it applies and never a regression.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-slice2-'));
  fs.writeFileSync(path.join(root, 'notes.md'), `${'reservation booking detail\n'.repeat(200)}`);
  const policy = { vaultRoot: root, taskRoot: root, allowRead: [root], allowWrite: [], sandboxPath: root };
  const result = new ContextPruner({}).prepare({ prompt: 'the reservation booking flow', policy });
  assert.ok(result.slices.length, 'prose still reaches the model');
  assert.ok(result.prompt.includes('reservation booking detail'));
  fs.rmSync(root, { recursive: true, force: true });
});

ok('it is actually wired in this time', () => {
  const pruner = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'context-pruner.js'), 'utf8');
  assert.match(pruner, /require\('\.\/symbol-index'\)/, 'zero importers is why nobody noticed it was broken');
  assert.match(pruner, /symbolRanges\(symbols,/);
});

if (failures) { console.error(`symbol slice selftest: ${failures} FAILED`); process.exit(1); }
console.log('symbol slice selftest: PASS · a template no longer eats the file · comments and strings still masked · whole definitions, merged · prose unaffected · wired');
