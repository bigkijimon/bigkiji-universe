'use strict';

// Every inline <script> we ship has to parse.
//
// This test exists because of one line in tray.html:
//
//     function applyPiAgentName(name) { ... const name = card?.el?.querySelector('.an'); }
//
// A parameter and a `const` with the same name in the same scope is a SyntaxError, and
// a SyntaxError in an inline script is not a runtime error that damages one feature —
// the browser discards the ENTIRE <script> element before executing a single statement.
// Every listener registered in that block (CONSOLE, CANVAS, the composer, the session
// picker, the whole tray) was therefore never attached. The tray rendered perfectly,
// looked finished, and no button in it did anything. The owner reported it as
// "the window will not open".
//
// Nothing caught it. `npm test` does not parse HTML. `SMOKE=1` watches renderer console
// errors and its level check was comparing a string to a number (fixed alongside this,
// in main.js). A screenshot cannot see it, because the failure is invisible until you
// click. So the cheapest possible check — hand every inline script to the same parser
// that will run it — is worth having permanently.
//
// V8 is the parser here, via `new vm.Script`, which is exactly what Chromium uses. It
// only parses; nothing is executed, so a script that calls `document` is fine.

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const UI = path.join(__dirname, '..', 'src', 'components', 'UI');
let failures = 0;
const ok = (name, body) => {
  try { body(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
};

/** Every <script> element with a body, as { code, startLine, type }. */
function inlineScripts(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const [, attrs, code] = match;
    if (/\bsrc\s*=/i.test(attrs)) continue;            // external file, parsed where it lives
    if (!code.trim()) continue;
    const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i) || [, 'text/javascript'])[1];
    if (!/javascript|module|^\s*$/i.test(type)) continue; // JSON-LD, templates, importmaps
    out.push({ code, type, startLine: html.slice(0, match.index).split('\n').length });
  }
  return out;
}

// A classic script and a module are different grammars — `import` is legal in exactly
// one of them — so each is handed to the parser that matches how the browser will read
// it. `vm.Script` is V8 parsing a Script; `node --check` on a .mjs file is V8 parsing a
// Module. Neither executes anything, so code that touches `document` is fine.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bku-inline-'));
function parseOrThrow(script, filename) {
  if (script.type.includes('module')) {
    const file = path.join(TMP, `${filename.replace(/\W+/g, '_')}.mjs`);
    fs.writeFileSync(file, script.code);
    try { execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (error) { throw new Error(String(error.stderr || error.message).split('\n').filter(Boolean).slice(0, 3).join(' — ')); }
    return;
  }
  new vm.Script(script.code, { filename });
}

const htmlFiles = fs.readdirSync(UI).filter((f) => f.endsWith('.html')).sort();

ok('there are HTML files to check at all', () => {
  // A rename or a move that empties this list would make every assertion below pass
  // vacuously, which is the failure mode of every "for each file" test ever written.
  assert.ok(htmlFiles.length >= 3, `expected the shipped windows, found ${htmlFiles.join(', ') || 'nothing'}`);
  assert.ok(htmlFiles.includes('tray.html'), 'tray.html is the window this test was written for');
});

for (const file of htmlFiles) {
  const html = fs.readFileSync(path.join(UI, file), 'utf8');
  const scripts = inlineScripts(html);
  ok(`${file} — ${scripts.length} inline script${scripts.length === 1 ? '' : 's'} parse`, () => {
    assert.ok(scripts.length > 0, `no inline script found in ${file} — the extractor is probably broken, not the file`);
    for (const script of scripts) {
      try {
        parseOrThrow(script, `${file}:${script.startLine}`);
      } catch (error) {
        throw new Error(`${file} line ~${script.startLine}: ${error.message}`);
      }
    }
  });
}

// The external scripts those windows load, checked the same way.
//
// The inline blocks above are only half of what ships. settings-modal.js alone is 50 KB
// of nested template literals building HTML — one stray backtick and the settings window
// is as dead as the tray was, in exactly the same silent way, and nothing was parsing it.
// `check:imports` resolves relative imports; it does not parse.
{
  const external = fs.readdirSync(UI).filter((name) => name.endsWith('.js')).sort();
  ok(`the ${external.length} external UI scripts parse`, () => {
    assert.ok(external.length >= 5, `expected the shipped UI scripts, found ${external.join(', ') || 'none'}`);
    assert.ok(external.includes('settings-modal.js'), 'settings-modal.js is the biggest one and the reason for this check');
    for (const name of external) {
      const code = fs.readFileSync(path.join(UI, name), 'utf8');
      // Same split as the inline blocks: these files are a mix of classic scripts loaded
      // with <script src> and ES modules imported by other modules, and `export` is legal
      // in exactly one of the two grammars.
      const type = /^\s*(?:export|import)\b/m.test(code) ? 'module' : 'text/javascript';
      try { parseOrThrow({ code, type }, name); }
      catch (error) { throw new Error(`${name}: ${error.message}`); }
    }
  });
}

// The specific shape that shipped, as a guard on the extractor itself: if the regex
// above ever stops finding script bodies, every check turns into a no-op and this
// catches that rather than the next outage doing it.
ok('the extractor really does reject the bug that shipped', () => {
  const scripts = inlineScripts('<script>\nfunction f(name) { const name = 1; return name; }\n</script>');
  assert.strictEqual(scripts.length, 1, 'the extractor found no script in a file that is one script');
  assert.throws(() => new vm.Script(scripts[0].code), /already been declared/);
});

// Listeners are attached at the bottom of tray.html's one big script. Losing that
// script is the outage; this states which buttons depend on it, so the next person
// deleting "an unused id" can see what it costs.
ok('the tray buttons the owner clicks are still wired inside that script', () => {
  const html = fs.readFileSync(path.join(UI, 'tray.html'), 'utf8');
  for (const id of ['openConsole', 'openCanvas']) {
    assert.ok(html.includes(`getElementById('${id}')`), `${id} lost its listener`);
    assert.ok(new RegExp(`id="${id}"`).test(html), `${id} lost its element`);
  }
});

if (failures) { console.error(`inline script selftest: ${failures} FAILED`); process.exit(1); }
console.log(`inline script selftest: PASS · ${htmlFiles.length} windows · every inline script parses · a SyntaxError can no longer take a whole window's listeners down silently`);
