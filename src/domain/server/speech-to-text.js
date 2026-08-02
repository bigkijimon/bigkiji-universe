'use strict';
// Shared two-pass whisper.cpp transcription.
//
// Extracted from the Electron main process so the standalone daemon can use it too:
// the phone posts audio to the daemon, not to Electron, and before V2.5 the daemon had
// no /api/voice route at all, so every mobile microphone upload returned 404.
//
// Two passes on purpose: `-dl` detects the language first, then the real run is pinned
// to that language. A single `-l auto` run mis-detects English as Japanese often enough
// to matter, and anything outside en/ja/th is forced to English.

const { execFile } = require('child_process');
const fs = require('fs');

const SUPPORTED = ['en', 'ja', 'th'];

function detectLanguage({ wav, whisperBin, whisperModel, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    execFile(whisperBin, ['-m', whisperModel, '-f', wav, '-dl'], { timeout: timeoutMs }, (_err, stdout, stderr) => {
      const match = (String(stderr) + String(stdout)).match(/detected language:\s*([a-z]{2})/i);
      const lang = match ? match[1].toLowerCase() : 'en';
      resolve(SUPPORTED.includes(lang) ? lang : 'en');
    });
  });
}

function transcribeWav({ wav, whisperBin, whisperModel, timeoutMs = 90000 }) {
  return new Promise((resolve) => {
    if (!whisperModel || !fs.existsSync(whisperModel)) {
      resolve({ error: 'whisper is not set up yet (model download pending)' });
      return;
    }
    detectLanguage({ wav, whisperBin, whisperModel }).then((lang) => {
      execFile(whisperBin, ['-m', whisperModel, '-f', wav, '-l', lang, '-np', '-nt'],
        { timeout: timeoutMs }, (err, stdout) => {
          if (err) { resolve({ error: `whisper failed: ${err.message}` }); return; }
          resolve({ text: String(stdout).replace(/\s+/g, ' ').trim(), lang });
        });
    });
  });
}

// Whisper happily "transcribes" silence into punctuation. Treat anything with fewer
// than two meaningful characters as noise rather than sending it on as a prompt.
function isMeaningful(text) {
  return String(text || '').replace(/[\s.,!?。、…]/g, '').length >= 2;
}

module.exports = { transcribeWav, detectLanguage, isMeaningful, SUPPORTED };
