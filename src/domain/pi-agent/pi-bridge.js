'use strict';
// Pi RPCブリッジ — Coreオーブの頭脳。ローカルOllama（トークン消費ゼロ）のPiを
// JSONL RPCで子プロセスとして持ち、指示/応答/ツール実行/実測トークンを中継する。
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { EventEmitter } = require('events');
const fs = require('fs');
const { signalChild } = require('../../core/child-signal');
const { SecurityPolicy } = require('../pi-core/security/security-policy');
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
    this.ready = false;   // Pi は spawn 直後まだ RPC を読んでいない
    this.queued = [];     // 読み始めるまでの発言を順序どおり保持する
    this.security = new SecurityPolicy();
    // 'pi' lends Pi its own models.json and settings.json into the sandbox HOME.
    // Without them Pi cannot resolve any model id at all — see CREDENTIAL_FILES.
    this.runtime = this.security.createRuntime(`pi-bridge-${process.pid}`, 'pi');
    fs.writeFileSync(this.runtime.policyFile, JSON.stringify(this.security.normalize({ valid: true, vaultRoot: cwd,
      taskRoot: cwd, allowRead: [], allowWrite: [] }), null, 2), { mode: 0o600 });
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
      this.proc = spawn(this.piBin, ['--mode', 'rpc', '--no-approve', '--model', this.model, '--append-system-prompt', LANG_RULE,
        '--no-tools', '--no-context-files', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates'], {
        cwd: this.cwd, env: this.security.minimalEnv('qwen', { runtime: this.runtime }),
      });
    } catch (err) {
      this.emit('status', { running: false, error: err.message });
      return false;
    }
    // Decode across chunk boundaries.
    //
    // `d.toString()` on each chunk decodes a partial UTF-8 sequence as replacement
    // characters, and a 3-byte Japanese character split by a read boundary became
    // U+FFFD U+FFFD U+FFFD. The line still parses as JSON — replacement characters
    // are legal inside a JSON string — so nothing errored and the owner simply saw
    // 承 arrive as ���. Measured: splitting at byte 34 of a message_update line.
    this.decoder = new StringDecoder('utf8');
    this.proc.stdout.on('data', (d) => this._ingest(this.decoder.write(d)));
    this.proc.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    this.ready = false; this.queued = [];
    this._waitForReady();
    this.proc.on('exit', () => {
      // Flush whatever the decoder was still holding: a truncated final character
      // is better reported than silently dropped.
      if (this.decoder) { const tail = this.decoder.end(); if (tail) this._ingest(tail); this.decoder = null; }
      clearTimeout(this.readyTimer); this.readyTimer = null; this.ready = false; this.queued = [];
      this.proc = null;
      this.isStreaming = false;
      this.emit('status', { running: false });
    });
    this.emit('status', { running: true });
    return true;
  }

  stop() {
    // Pi is missing on any machine that has not installed it, and a failed spawn still
    // leaves a ChildProcess here — one whose kill() would signal our process group.
    if (this.proc) { signalChild(this.proc); this.proc = null; }
    this.emit('status', { running: false });
  }

  dispose() { this.stop(); try { fs.rmSync(this.runtime.root, { recursive: true, force: true }); } catch (_) {} }

  _send(obj) {
    if (!this.proc) return;
    // Pi is not ready the instant spawn() returns: it installs its packages first
    // (measured, `added 6 packages ... audited 7 packages in 3s` on stderr) and only
    // then starts reading RPC. A prompt written into that window is accepted by the
    // pipe and dropped by Pi, which is exactly what "I asked and nothing happened"
    // looked like. Queue until something has been answered.
    if (!this.ready) { this.queued.push(obj); return; }
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /**
   * Poll until Pi answers, then release whatever was said while it was starting.
   *
   * Pi emits nothing unprompted, so there is no event to wait for — waiting for one
   * deadlocks. get_session_stats is the cheapest question that must be answered, and
   * asking it repeatedly is safe because it changes nothing. The first reply of any
   * kind proves stdin is being read.
   */
  _waitForReady({ everyMs = 800, giveUpMs = 60000 } = {}) {
    const deadline = Date.now() + giveUpMs;
    const poke = () => {
      if (this.ready || !this.proc) return;
      if (Date.now() > deadline) { this.emit('status', { running: true, error: 'pi never answered' }); return; }
      try { this.proc.stdin.write(`${JSON.stringify({ id: `ready-${++this.reqSeq}`, type: 'get_session_stats' })}\n`); } catch (_) {}
      this.readyTimer = setTimeout(poke, everyMs); this.readyTimer.unref?.();
    };
    poke();
  }

  /** Flush whatever was said before Pi was listening, in the order it was said. */
  _drain() {
    if (!this.proc) return;
    const pending = this.queued; this.queued = [];
    for (const obj of pending) this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
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
      if (!this.ready) { this.ready = true; clearTimeout(this.readyTimer); this._drain(); }
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

  /**
   * Interrupt the turn in flight without discarding it.
   *
   * `steer` reaches the agent after the tool it is currently running finishes, so
   * the correction lands on work in progress rather than starting a new one.
   * prompt() picks this automatically mid-stream; this is the explicit form.
   */
  steer(message) { this._send({ type: 'prompt', message, streamingBehavior: 'steer' }); }

  /** Queue a message for after the current turn ends, rather than interrupting it. */
  followUp(message) { this._send({ type: 'prompt', message, streamingBehavior: 'queue' }); }

  /**
   * Ask Pi to compact its own context.
   *
   * Pi compacts automatically at its own threshold. Doing it at a known-quiet
   * moment — between runs, not mid-thought — is the difference between a pause the
   * owner chose and one that lands in the middle of an answer.
   */
  compact() { return this.request('compact'); }

  /**
   * Switch which model Pi is borrowing, without restarting it.
   *
   * Pi is a program, not a model: it has no brain of its own and borrows one from a
   * provider per call. Restarting the process to change that threw away the session
   * with it, which is why setModel existed only as a stop/start.
   */
  setModel(model) {
    if (!model) return null;
    this._send({ type: 'set_model', model: String(model) });
    return model;
  }

  request(type, extra = {}) {
    return new Promise((resolve) => {
      const id = `req-${++this.reqSeq}`;
      // The deadline is cleared when the answer arrives and never holds the loop
      // open on its own. It did both wrong: a five minute timer stayed armed after
      // every answered request, so the process could not exit for five minutes
      // after its last question — which is why this file could not be tested at all.
      const timer = setTimeout(() => { if (this.pending.delete(id)) resolve(null); }, 300000);
      timer.unref?.();
      this.pending.set(id, (event) => { clearTimeout(timer); resolve(event); });
      this._send({ id, type, ...extra });
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

/**
 * The answer text out of a Pi event, or ''.
 *
 * Shapes measured 2026-08-03 against pi 0.83: a delta arrives as
 * `assistantMessageEvent.delta`, the finished block as `.content`, and the whole
 * message as `message.content[].text`. Reading only `evt.text` — which is what a
 * caller would reasonably try — finds nothing in any of them.
 * @returns {string}
 */
function answerText(evt = {}) {
  const inner = evt.assistantMessageEvent;
  if (inner) {
    if (inner.type === 'text_delta' && typeof inner.delta === 'string') return inner.delta;
    if (inner.type === 'text_end' && typeof inner.content === 'string') return inner.content;
    return '';
  }
  if (evt.type === 'message_end' && evt.message?.role === 'assistant') {
    return (evt.message.content || []).filter((part) => part?.type === 'text').map((part) => part.text).join('');
  }
  return '';
}

module.exports = { PiBridge, MODEL, answerText };
