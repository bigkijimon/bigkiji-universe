'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StreamingSpeechFilter, detectSpeechLanguage, sanitizeAgentSpeech } = require('../src/core/tts-policy');
const { SettingsStore } = require('../src/core/settings-store');

const gate = new StreamingSpeechFilter();
assert.deepStrictEqual(gate.push('<think'), []);
assert.deepStrictEqual(gate.push('ing>secret draft.</thinking>Hello owner.'), ['Hello owner.']);
assert.deepStrictEqual(gate.push(' The system is ready'), []);
assert.deepStrictEqual(gate.push(' now!'), ['The system is ready now!']);
assert.deepStrictEqual(gate.flush(), []);
assert.equal(detectSpeechLanguage('This is the default voice.'), 'English');
assert.equal(detectSpeechLanguage('これは日本語の音声です。'), 'Japanese');
assert.equal(sanitizeAgentSpeech('Authorization: Bearer secret-token'), '');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-settings-'));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() };
const store = new SettingsStore({ userData: tmp, safeStorage });
const next = store.update({ audio: { ownerVolume: 4, ownerSpeedEnglish: 2 }, routing: { paidAllowlist: ['openrouter'] } });
assert.equal(next.audio.ownerVolume, 1);
assert.equal(next.audio.ownerSpeedEnglish, 1.4);
assert.deepStrictEqual(next.routing.paidAllowlist, ['claude', 'codex', 'gemini', 'glm']);
store.setSecret('gemini', 'secret-value');
assert.equal(store.getSecret('gemini'), 'secret-value');
assert.throws(() => store.setSecret('elevenlabs', 'blocked'), /not allowed/);

const audioUi = fs.readFileSync(path.join(__dirname, '../src/components/UI/audio-engine.js'), 'utf8');
const settingsUi = fs.readFileSync(path.join(__dirname, '../src/components/UI/settings-modal.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../src/core/main.js'), 'utf8');
const localServer = fs.readFileSync(path.join(__dirname, './qwen3-tts-server.py'), 'utf8');
const naturalTts = fs.readFileSync(path.join(__dirname, '../src/core/natural-tts-service.js'), 'utf8');
assert.match(audioUi, /ownerGain/); assert.match(audioUi, /agentGain/); assert.match(audioUi, /firstAudioMs/);
assert.match(settingsUi, /FIRST SPEECH SLA/); assert.match(settingsUi, /DEFAULT ENGLISH/); assert.doesNotMatch(settingsUi, /ElevenLabs|OpenAI TTS/);
assert.match(main, /spoken-progress-fallback/); assert.match(main, /speechFirstPlayed/);
assert.doesNotMatch(main, /ttsService\.start\(\);/); assert.match(naturalTts, /ensureReady/); assert.match(naturalTts, /BIGKIJI_TTS_IDLE_MS/);
assert.match(localServer, /devices = \["mps", "cpu"\]/); assert.match(localServer, /127\.0\.0\.1/);
console.log('voice engine selftest: PASS');
