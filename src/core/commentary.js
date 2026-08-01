'use strict';
// Live Commentary — English one-liner generator. Single source of truth for the
// desktop crawl bar, the mobile PWA and the bigkiji CLI (all consume bk:commentary).
// System-facing text is always English; owner replies mirror the owner's language
// (LANG_RULE in pi-bridge.js).
const NAME = {
  'claude-code': 'Claude', gemini: 'Gemini', codex: 'Codex', biglama: 'BigLama',
  marble: 'Marble', justin: 'Justin', risa: 'Risa', coco: 'Coco',
};
const agentName = (id) => NAME[id] || 'Core';
const short = (m) => String(m || '').split('/').pop();

const C = {
  turnStart: (model, via) => `🧠 Core accepted a directive${via ? ` via ${via}` : ''} — routing on ${short(model)}`,
  toolStart: (agent, tool) => `⚙️ @${agentName(agent)} initiated ${tool}`,
  toolEnd: (tool, ms, isError) => isError
    ? `⚠️ ${tool} failed after ${ms ?? '—'} ms — Auto-Heal is watching`
    : `✅ ${tool} completed in ${ms ?? '—'} ms`,
  fsWrite: (agent, file) => `📁 @${agentName(agent)} touched ${file}`,
  turnDone: (tokIn, tokOut, ms, model) =>
    `⚡ Turn complete — ${tokIn ?? '?'} in / ${tokOut ?? '?'} out tok · ${ms ? (ms / 1000).toFixed(1) : '?'}s (${short(model)})`,
  fallback: (model) => `🛰 Quota silence detected — degrading to ${short(model)} and retrying`,
  bloat: (tok) => `⚠️ Context bloat: ${tok} tok/turn input (>25k) — fresh session recommended`,
  heal: (tool, file) => `⚕️ Auto-Heal: ${tool} failed 3× — repair task queued (${file})`,
  cacheHit: (desc, saved) => `⚡ [CACHE HIT] Known pattern "${desc}" — zero-discussion execution (≈${saved} tok saved)`,
  cacheStore: (desc) => `🧠 [KNOWLEDGE] Pattern "${desc}" stored — next run skips discussion`,
  swarmStart: () => '🐝 [SWARM CONSENSUS] Designing workflow for unknown task…',
  swarmPhase: (phase, detail) => `🐝 [SWARM] ${phase}${detail ? ` — ${detail}` : ''}`,
  voice: (state) => ({
    LISTEN: '🎙 Live voice — listening', CAPTURE: '🎙 Hearing you…',
    THINK: '🧠 Transcribing & thinking…', SPEAK: '🔊 Speaking — interrupt anytime',
    OFF: '🎙 Live voice session ended',
  })[state] || null,
  stt: (text, lang) => `🎙 Heard (${lang}): "${String(text).slice(0, 60)}"`,
};

module.exports = { C, agentName };
