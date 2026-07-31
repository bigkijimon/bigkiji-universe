'use strict';
// v12 ライブ音声ワークレット: 48kHz入力を3:1で16kHzへ間引き（整数比・キャリー付きで
// ブロック境界のサンプル落ちなし）、フレームPCMとRMSをメインスレッドへ送る。
class BKVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._carry = new Float32Array(2);
    this._carryLen = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    const total = this._carryLen + ch.length;
    const outLen = Math.floor(total / 3);
    if (!outLen) { // 珍しいが小ブロックはキャリーへ
      for (let i = 0; i < ch.length; i++) this._carry[this._carryLen++] = ch[i];
      return true;
    }
    const out = new Float32Array(outLen);
    let sum = 0;
    let idx = 0; // total列上の読み位置
    const at = (i) => (i < this._carryLen ? this._carry[i] : ch[i - this._carryLen]);
    for (let o = 0; o < outLen; o++) {
      const v = (at(idx) + at(idx + 1) + at(idx + 2)) / 3;
      out[o] = v;
      sum += v * v;
      idx += 3;
    }
    const rest = total - idx;
    for (let i = 0; i < rest; i++) this._carry[i] = at(idx + i);
    this._carryLen = rest;
    this.port.postMessage({ pcm: out, rms: Math.sqrt(sum / outLen) }, [out.buffer]);
    return true;
  }
}
registerProcessor('bk-voice', BKVoiceProcessor);
