'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const exists = (file) => fs.existsSync(path.join(root, file));

const required = [
  'src/core/main.js', 'src/core/preload.js', 'src/core/orchestrator.js', 'src/core/tts-policy.js',
  'src/core/natural-tts-service.js', 'src/core/settings-store.js', 'src/core/path-config.js', 'src/core/cmux-bridge.js',
  'src/core/app-menu.js', 'src/domain/pi-agent/embedding-store.js', 'src/domain/pi-agent/gpu-scheduler.js', 'src/domain/pi-agent/text-index.js',
  'src/core/data-root.js', 'src/core/migration-plan.js', 'src/core/data-migrator.js', 'src/core/workspace-registry.js', 'src/core/project-store.js', 'src/core/watch-queue.js', 'src/domain/pi-agent/tool-registry.js', 'src/components/UI/setup.html',
  'src/domain/server/speech-to-text.js',
  'src/domain/3d-canvas/components/synapse.js', 'src/domain/3d-canvas/components/roadmap-3d.js',
  'src/domain/3d-canvas/shaders/core-accretion-field.js', 'src/domain/3d-canvas/shaders/viral-membrane.js',
  'src/domain/terminal/components/multi-terminal-manager.js', 'src/domain/terminal/components/cmux-terminal-mirror.js',
  'src/domain/telemetry/components/right-telemetry-panel.js',
  'src/domain/pi-agent/pi-bridge.js', 'src/domain/pi-agent/sandbox-policy.js', 'src/domain/pi-agent/skill-registry.js', '.pi/sandbox.json', 'src/domain/pi-agent/context-pruner.js', 'src/domain/pi-agent/pi-knowledge-orchestrator.js',
  'src/domain/pi-agent/components/pi-agents-fleet-box.js', 'src/components/UI/main.html',
  'src/components/UI/audio-engine.js', 'src/components/UI/settings-modal.js',
  // The console window is the one renderer built by Vite (vite.console.config.js). Its
  // entry and root component stand in for the old console.html + console.js pair; the
  // rest of the window is checked by tools/console-window-selftest.mjs.
  'src/components/UI/console-app/index.html', 'src/components/UI/console-app/src/main.jsx',
  'src/components/UI/console-app/src/App.jsx', 'src/components/UI/markdown.js',
  'src/domain/server/daemon.js', 'src/domain/server/daemon-client.js', 'src/domain/server/session-store.js',
  'src/domain/terminal/bigkiji-cli.js', 'src/domain/terminal/cli-theme.js', 'src/domain/terminal/cli-preferences.js',
  'src/cli/tui/monitor.js', 'src/cli/tui/renderer.js', 'src/core/tailscale-remote-access.js',
];
for (const file of required) assert.ok(exists(file), `missing physical target: ${file}`);

const forbidden = ['renderer', 'remote', 'main.js', 'preload.js', 'orchestrator.js', 'governance.js',
  'pi-bridge.js', 'task-runner.js', 'fast-api-router.js', 'multi-terminal-manager.js'];
for (const file of forbidden) assert.ok(!exists(file), `legacy path still exists: ${file}`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.strictEqual(pkg.main, 'src/core/main.js');
assert.strictEqual(pkg.license, 'Apache-2.0');
assert(pkg.build.files.includes('!**/.env'), 'release package must exclude private .env files');
assert(pkg.build.mac.forceCodeSigning, 'macOS release signing must never silently downgrade');
const html = fs.readFileSync(path.join(root, 'src/components/UI/main.html'), 'utf8');
assert.match(html, /\.\.\/\.\.\/domain\/3d-canvas\/components\/synapse\.js/);
assert.match(html, /\.\.\/\.\.\/domain\/terminal\/components\/multi-terminal-manager\.js/);
console.log('physical architecture selftest: PASS');
