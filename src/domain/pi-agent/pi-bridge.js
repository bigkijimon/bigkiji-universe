'use strict';
// Pi RPCブリッジ — Coreオーブの頭脳。ローカルOllama（トークン消費ゼロ）のPiを
// JSONL RPCで子プロセスとして持ち、指示/応答/ツール実行/実測トークンを中継する。
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
// v13: 静的チェーン→動的チェーン（model-router.jsがキー実在を検知して可用ティアを構築。
// GLMは確定実行時のみ参戦。quota沈黙・429検知でOllamaへ即降格する。
const router = require('./model-router');
let CHAIN = router.buildChain();
const MODEL = CHAIN[0].id;
// v12言語規則（オーナー指示 2026-07-31）: システム/ログは英語のまま、
// オーナーへの返答は入力言語をミラーする（JA→JA / EN→EN / TH→TH・不明はEN）。
// system promptレベルで注入（AGENTS.mdだけでは入力言語追従が不安定＝v8実測）
const LANG_RULE = 'Mirror the owner\'s language: reply in Japanese to Japanese input, English to English, Thai to Thai; if unclear use English. Keep code, paths and system/log text in English.';

class PiBridge extends EventEmitter {
  constructor({ cwd = process.cwd(), piBin = process.env.PI_BIN || 'pi' } = {}) {
    super();
    this.cwd = cwd;
    this.piBin = piBin;
    this.proc = null;
    this.buf = '';
    this.isStreaming = false;
    this.reqSeq = 0;
    this.pending = new Map(); // id → resolve
    this.lastStats = null;    // 前回get_session_statsの実測値（差分=ターン消費）
    this.modelIdx = 0;        // フォールバックチェーンの現在位置
    this.fallbackPromise = null; // 同じstderrを複数経路で受けても1ティアだけ降格する
  }

  get running() { return !!this.proc; }
  get model() { return (CHAIN[this.modelIdx] || CHAIN[CHAIN.length - 1]).id; }
  get tier() { return CHAIN[this.modelIdx] || CHAIN[CHAIN.length - 1]; }
  get chainList() { return CHAIN; }

  // quota沈黙/429検知でモデルが死んだとき、次の可用ティアへ降格して再起動（末尾で打ち止め）
  // v13: Ollama切替前に実疎通を確認(5sタイムアウト)。429直後はクールダウン挿入。
  async fallback(cooldownMs = 2000) {
    if (this.fallbackPromise) return this.fallbackPromise;
    this.fallbackPromise = this._fallback(cooldownMs);
    try { return await this.fallbackPromise; } finally { this.fallbackPromise = null; }
  }

  async _fallback(cooldownMs) {
    if (this.modelIdx >= CHAIN.length - 1) return false;
    this.modelIdx++;
    const next = CHAIN[this.modelIdx];
    // Ollama以外: キー実在はbuildChainで担保済み→即再起動
    // Ollamaのみ: freeze(凍結解除待ち3s)-cool-downの計~5s必要
    if (next.need === 'ollama') {
      const healthy = await router.ollamaHealth(5000);
      if (!healthy) {
        router.ollamaKickstart();
        await new Promise((r) => setTimeout(r, cooldownMs + 3000));
      } else {
        await new Promise((r) => setTimeout(r, cooldownMs));
      }
    } else {
      await new Promise((r) => setTimeout(r, cooldownMs));
    }
    this.stop();
    return this.start();
  }

  // v13: stderr/ツールイベントから429/quota死を検知して fallback() を呼ぶゲート
  detectErrorAndFallback(stderrLine) {
    if (!stderrLine || !router.FALLBACK_ERROR_PATTERN.test(stderrLine)) return false;
    const isToolFail = /tool[_\s]|write|exec|bash|read_file/i.test(stderrLine);
    if (isToolFail && stderrLine.match(/\bError\b|\berror:\b/i)) return false; // Auto-Healへ委譲
    this.emit('degrade', { model: this.model, reason: stderrLine.slice(0, 120) });
    return true;
  }

  // タスク特性で開始ティアを切替（実行中は触らない＝ターンを壊さない）
  ensureTier(idx) {
    const target = Math.max(0, Math.min(idx, CHAIN.length - 1));
    if (target === this.modelIdx) return;
    if (this.isStreaming) return;
    const wasRunning = this.running;
    this.modelIdx = target;
    if (wasRunning) { this.stop(); this.start(); }
  }

  // キー投入後の再検知（アプリ再起動なしでGLM可用性を反映）
  refreshChain() {
    const cur = this.model;
    CHAIN = router.buildChain();
    const keep = CHAIN.findIndex((t) => t.id === cur);
    this.modelIdx = keep >= 0 ? keep : 0;
    return CHAIN;
  }

  start() {
    if (this.proc) return true;
    // No hidden shell lookup: only the approved GLM key in the process environment
    // may be used. Google/Kimi/OpenRouter credentials are never imported.
    try {
      this.proc = spawn(this.piBin, ['--mode', 'rpc', '--approve', '--model', this.model, '--append-system-prompt', LANG_RULE], {
        cwd: this.cwd, env: process.env,
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
      setTimeout(() => { if (this.pending.delete(id)) resolve(null); }, 300000);
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

module.exports = { PiBridge, MODEL };
