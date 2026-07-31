'use strict';
// Pi RPCブリッジ — Coreオーブの頭脳。ローカルOllama（トークン消費ゼロ）のPiを
// JSONL RPCで子プロセスとして持ち、指示/応答/ツール実行/実測トークンを中継する。
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const VAULT = '/Users/yuma/Documents/CEOBigKiji';
// Core=速度優先のクラウド＋無料枠フォールバックチェーン（オーナー指示 2026-07-31）。
// 無料枠はモデル別の日次別勘定（実測: 2.5-flash=20req/日・2.0-flash=枠0・3.1-flash-liteは大きい）。
// 品質枠→大容量枠→ローカル¥0 の順に、quota沈黙（空ターン）を検知して自動降格する。
const MODELS = [
  'google/gemini-3-flash-preview', // 品質・速度（無料枠は小さい・日次リセット）
  'google/gemini-3.1-flash-lite',  // 大きめ無料枠の主力
  'ollama/qwen3.5:35b-a3b',        // ローカル¥0＝最終防波堤（遅いが死なない）
];
const MODEL = MODELS[0];
// v12言語規則（オーナー指示 2026-07-31）: システム/ログは英語のまま、
// オーナーへの返答は入力言語をミラーする（JA→JA / EN→EN / TH→TH・不明はEN）。
// system promptレベルで注入（AGENTS.mdだけでは入力言語追従が不安定＝v8実測）
const LANG_RULE = 'Mirror the owner\'s language: reply in Japanese to Japanese input, English to English, Thai to Thai; if unclear use English. Keep code, paths and system/log text in English.';

class PiBridge extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.buf = '';
    this.isStreaming = false;
    this.reqSeq = 0;
    this.pending = new Map(); // id → resolve
    this.lastStats = null;    // 前回get_session_statsの実測値（差分=ターン消費）
    this.modelIdx = 0;        // フォールバックチェーンの現在位置
  }

  get running() { return !!this.proc; }
  get model() { return MODELS[this.modelIdx]; }

  // quota沈黙などでモデルが死んだとき、次のモデルへ降格して再起動する（末尾=ローカルで打ち止め）
  fallback() {
    if (this.modelIdx >= MODELS.length - 1) return false;
    this.modelIdx++;
    this.stop();
    return this.start();
  }

  start() {
    if (this.proc) return true;
    // Finder起動の.appはシェル環境を継がない → APIキーはログインシェルから補完、piは絶対パスも試す
    if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
      try {
        const key = require('child_process').execSync('/bin/zsh -lc "echo $GOOGLE_API_KEY"', { timeout: 8000 }).toString().trim();
        if (key) process.env.GOOGLE_API_KEY = key;
      } catch (_) {}
    }
    const PI_BIN = require('fs').existsSync('/Users/yuma/.npm-global/bin/pi') ? '/Users/yuma/.npm-global/bin/pi' : 'pi';
    try {
      this.proc = spawn(PI_BIN, ['--mode', 'rpc', '--approve', '--model', this.model, '--append-system-prompt', LANG_RULE], {
        cwd: VAULT, env: process.env,
      });
    } catch (err) {
      this.emit('status', { running: false, error: err.message });
      return false;
    }
    this.proc.stdout.on('data', (d) => this._ingest(d.toString()));
    this.proc.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    this.proc.on('exit', () => {
      this.proc = null;
      this.isStreaming = false;
      this.emit('status', { running: false });
    });
    this.emit('status', { running: true });
    return true;
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch (_) {} this.proc = null; }
    this.emit('status', { running: false });
  }

  _send(obj) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _ingest(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let evt;
      try { evt = JSON.parse(s); } catch (_) { continue; }
      if (evt.id && this.pending.has(evt.id)) {
        this.pending.get(evt.id)(evt);
        this.pending.delete(evt.id);
      }
      if (evt.type === 'message_update') this.isStreaming = true;
      if (evt.type === 'agent_end' || evt.type === 'idle') this.isStreaming = false;
      this.emit('event', evt);
    }
  }

  prompt(message) {
    if (!this.proc) return;
    // 実行中はsteer（現ツール完了後に割込み）、待機中は通常prompt
    this._send(this.isStreaming
      ? { type: 'prompt', message, streamingBehavior: 'steer' }
      : { type: 'prompt', message });
  }

  abort() { this._send({ type: 'abort' }); }

  request(type, extra = {}) {
    return new Promise((resolve) => {
      const id = `req-${++this.reqSeq}`;
      this.pending.set(id, resolve);
      this._send({ id, type, ...extra });
      setTimeout(() => { if (this.pending.delete(id)) resolve(null); }, 8000);
    });
  }

  // ターン消費の実測差分を返す（get_session_statsの生値ベース・見つからなければnull）
  async turnStats() {
    const res = await this.request('get_session_stats');
    const data = res && res.data;
    if (!data) return null;
    const flat = JSON.stringify(data);
    const pick = (re) => { const m = flat.match(re); return m ? +m[1] : 0; };
    const totals = {
      input: pick(/"input(?:Tokens)?":(\d+)/) || pick(/"promptTokens":(\d+)/),
      output: pick(/"output(?:Tokens)?":(\d+)/) || pick(/"completionTokens":(\d+)/),
    };
    const prev = this.lastStats || { input: 0, output: 0 };
    this.lastStats = totals;
    return { turn: { input: Math.max(0, totals.input - prev.input), output: Math.max(0, totals.output - prev.output) }, total: totals, raw: data };
  }
}

module.exports = { PiBridge, VAULT, MODEL };
