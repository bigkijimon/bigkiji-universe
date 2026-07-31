'use strict';
// BigKiji EventBus — 全プロセスの動きを1本のイベント列に正規化する司令塔。
// 正直なコックピット原則（VoiceOrb DESIGN §0-3）: 流れるのは実イベント・実測値のみ。
// イベント源: ①pty出力のパース ②レンダラIPC ③SystemPulse（OS実測値・5秒毎）
const { EventEmitter } = require('events');
const os = require('os');

const AGENTS = [
  { id: 'claude-code', label: 'Claude Code', color: '#d97757', match: /claude/i },
  { id: 'glm',          label: 'GLM',        color: '#8b5cf6', match: /glm|zai/i },
  { id: 'gemini',      label: 'Gemini',      color: '#4e8cff', match: /gemini/i },
  { id: 'codex',       label: 'Codex',       color: '#00a67d', match: /codex/i },
  { id: 'biglama',     label: 'LocalAI BigLama', color: '#a78bfa', match: /ollama|qwen|llama|biglama|localai/i },
  { id: 'marble',      label: 'CEO Marble',  color: '#34d399', match: /marble|upclass|hsacademy|english_school/i },
  { id: 'justin',      label: 'CEO Justin',  color: '#f472b6', match: /justin|creative_media|ace-step|ltx|wan2/i },
  { id: 'risa',        label: 'CEO Risa',    color: '#fbbf24', match: /risa|comfyui|flux|sdxl|design_studio/i },
  { id: 'coco',        label: 'Coco',        color: '#f87171', match: /coco|influencer|pulid/i },
];
const MARKER = /\[\[AGENT:([a-z0-9-]+)\]\]/i;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\r\x00-\x08\x0b-\x1f]/g;

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.seq = 0;
    this.startTs = Date.now();
    this.lineBuf = '';
    this.tokens = 30;            // 秒間30イベントの流量制限（超過は正直に「N行省略」で報告）
    this.dropped = 0;
    this.counters = {};          // agentId → { count, last }（実カウント。ツールチップ用）
    for (const a of AGENTS) this.counters[a.id] = { count: 0, last: 0 };
    this.recent = [];            // 直近イベントのリングバッファ（後から開いた画面への再生用）
    this.lastStats = null;       // 直近のSystemPulse実測値
    this.refill = setInterval(() => {
      if (this.dropped > 0) {
        this.push({ source: 'pty', agent: null, type: 'info', text: `… ${this.dropped} high-volume output lines omitted` });
        this.dropped = 0;
      }
      this.tokens = 30;
    }, 1000);
    this.refill.unref();
  }

  detect(line) {
    const m = line.match(MARKER);
    if (m) {
      const hit = AGENTS.find((a) => a.id === m[1].toLowerCase());
      if (hit) return hit;
    }
    return AGENTS.find((a) => a.match.test(line)) || null;
  }

  push(partial) {
    const evt = Object.assign({ id: ++this.seq, ts: Date.now(), agent: null, type: 'log' }, partial);
    if (evt.agent && this.counters[evt.agent]) {
      this.counters[evt.agent].count++;
      this.counters[evt.agent].last = evt.ts;
    }
    this.recent.push(evt);
    if (this.recent.length > 40) this.recent.shift();
    if (evt.stats) this.lastStats = evt.stats;
    this.emit('event', evt);
    return evt;
  }

  // ptyのrawチャンクを行に割ってイベント化
  ingest(chunk) {
    this.lineBuf += chunk;
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(ANSI, '').trim();
      if (!line) continue;
      if (this.tokens <= 0) { this.dropped++; continue; }
      this.tokens--;
      const agent = this.detect(line);
      this.push({ source: 'pty', agent: agent ? agent.id : null, type: agent ? 'task' : 'log', text: line.slice(0, 180) });
    }
  }

  // SystemPulse: 5秒毎のOS実測値（フェイクなしの常時ライブ）。app=Electronのappモジュール
  startSystemPulse(app) {
    const emit = () => {
      try {
        const load = os.loadavg()[0];
        const totalGB = os.totalmem() / 1073741824;
        const freeGB = os.freemem() / 1073741824;
        const procs = app ? app.getAppMetrics().length : 0;
        this.push({
          source: 'system', agent: null, type: 'pulse',
          text: `load ${load.toFixed(2)} · mem ${(totalGB - freeGB).toFixed(1)}/${totalGB.toFixed(0)}GB · app procs ${procs}`,
          stats: { load: +load.toFixed(2), usedGB: +(totalGB - freeGB).toFixed(1), totalGB: Math.round(totalGB), procs },
        });
      } catch (_) { /* 計測失敗時は何も流さない（偽値は出さない） */ }
    };
    emit();
    this.pulse = setInterval(emit, 5000);
    this.pulse.unref();
  }

  snapshot() {
    return { startTs: this.startTs, seq: this.seq, counters: this.counters,
      recent: this.recent, lastStats: this.lastStats };
  }

  stop() { clearInterval(this.pulse); clearInterval(this.refill); }
}

module.exports = { Orchestrator, AGENTS };
