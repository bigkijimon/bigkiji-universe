'use strict';
// v12 フルデュプレックス・ライブ音声（デスクトップ）
// 1タップ→常時リスニング(VAD)→自動区切り→二段STT→Pi→文単位TTS(WebAudio再生=AEC有効)→Barge-in。
// マイク所有権は main が調停（voice:live-own が自窓宛に届いた窓だけがキャプチャする）。
(() => {
  const SR = 16000;
  const RING_SEC = 30;
  // VADパラメタ（プラン確定値）
  const START_HOLD = 90;   // ms: 閾値超えの持続で発話開始
  const END_HOLD = 700;    // ms: 無音の持続で発話終了
  const MIN_UTTER = 300;   // ms: これ未満は破棄（ノイズ）
  const PRE_ROLL = 300;    // ms: 発話開始前を遡って含める
  const MAX_UTTER = 20000; // ms: 強制区切り

  const st = {
    live: false, capturing: false, phase: 'IDLE', btn: null,
    ctx: null, stream: null, node: null,
    ring: new Float32Array(SR * RING_SEC), w: 0,
    floor: 0.008, speech: false, speechStart: 0, silenceStart: 0, utterStart: 0, utterFrom: 0,
    playSrc: null, playing: false,
  };
  const playQ = [];

  const BTN_LABEL = { LISTEN: '🎙 LIVE', CAPTURE: '🎙 HEARING', THINK: '🧠 THINK', SPEAK: '🔊 SPEAK' };
  function setPhase(p, report = true) {
    st.phase = p;
    if (st.btn) {
      st.btn.classList.remove('listen', 'capture', 'think', 'speak');
      const cls = { LISTEN: 'listen', CAPTURE: 'capture', THINK: 'think', SPEAK: 'speak' }[p];
      if (cls && st.live) st.btn.classList.add(cls);
      // アイコンボタン（トレイのSVGマイク等）はラベル差し替えをしない
      if (st.btn.dataset.liveIcon !== '1') st.btn.textContent = st.live ? (BTN_LABEL[p] || '🎙 LIVE') : '🎙 LIVE';
    }
    if (report && st.capturing) { try { window.bigkiji.voiceState({ state: p }); } catch (_) {} }
  }

  function pushRing(pcm) {
    for (let i = 0; i < pcm.length; i++) {
      st.ring[st.w] = pcm[i];
      st.w = (st.w + 1) % st.ring.length;
    }
  }
  function sliceRing(from) {
    const len = (st.w - from + st.ring.length) % st.ring.length;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = st.ring[(from + i) % st.ring.length];
    return out;
  }
  function wavEncode(f32) { // RIFF/WAVE PCM16LE mono 16k
    const n = f32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  function onFrame({ pcm, rms }) {
    if (!st.capturing) return;
    pushRing(pcm);
    const now = performance.now();
    if (!st.speech) st.floor = st.floor * 0.98 + rms * 0.02; // 適応ノイズ床（非発話時のみ）
    const speaking = st.playing; // TTS再生中はBarge-in判定＝閾値と持続を厳しく（AECの上の防御層）
    const thresh = Math.max(st.floor * (speaking ? 4 : 3), 0.010);
    if (!st.speech) {
      if (rms > thresh) {
        if (!st.speechStart) st.speechStart = now;
        if (now - st.speechStart >= (speaking ? 250 : START_HOLD)) {
          st.speech = true;
          st.utterStart = now;
          const back = Math.round(((now - st.speechStart) + PRE_ROLL) / 1000 * SR);
          st.utterFrom = (st.w - Math.min(back, st.ring.length - 1) + st.ring.length) % st.ring.length;
          if (speaking) bargeIn();
          setPhase('CAPTURE');
        }
      } else st.speechStart = 0;
    } else {
      if (rms < Math.max(st.floor * 1.8, 0.006)) {
        if (!st.silenceStart) st.silenceStart = now;
        if (now - st.silenceStart >= END_HOLD) { endUtterance(now); return; }
      } else st.silenceStart = 0;
      if (now - st.utterStart > MAX_UTTER) endUtterance(now);
    }
  }

  async function endUtterance(now) {
    st.speech = false; st.silenceStart = 0; st.speechStart = 0;
    const dur = now - st.utterStart;
    if (dur < MIN_UTTER) { setPhase(st.playing ? 'SPEAK' : 'LISTEN'); return; }
    const pcm = sliceRing(st.utterFrom);
    setPhase('THINK');
    try {
      const r = await window.bigkiji.liveUtterance(wavEncode(pcm));
      if (!r || !r.text) setPhase(st.playing ? 'SPEAK' : 'LISTEN'); // 空認識→即リスニングへ
      // テキスト認識時: 返答はvoice:tts-chunkで届き、再生開始でSPEAKへ遷移する
    } catch (_) { setPhase('LISTEN'); }
  }

  async function playNext() {
    if (st.playSrc || !playQ.length || !st.ctx) return;
    const buf = playQ.shift();
    try {
      const audio = await st.ctx.decodeAudioData(buf.slice(0));
      const src = st.ctx.createBufferSource();
      src.buffer = audio;
      src.connect(st.ctx.destination); // 自ページ再生＝ChromiumのAECがループバック参照を持てる
      st.playSrc = src;
      st.playing = true;
      if (st.phase !== 'CAPTURE') setPhase('SPEAK');
      src.onended = () => {
        st.playSrc = null;
        if (!playQ.length) { st.playing = false; if (st.phase === 'SPEAK') setPhase('LISTEN'); }
        playNext();
      };
      src.start();
    } catch (_) { st.playSrc = null; playNext(); }
  }
  function stopPlayback() {
    playQ.length = 0;
    if (window.BKAudio) window.BKAudio.stop('owner');
    if (st.playSrc) { try { st.playSrc.stop(); } catch (_) {} st.playSrc = null; }
    st.playing = false;
  }
  function bargeIn() { // ローカル停止=0ms → mainの合成キューも破棄
    stopPlayback();
    try { window.bigkiji.voiceInterrupt(); } catch (_) {}
  }

  async function startCapture() {
    if (st.capturing) return;
    try { await window.bigkiji.micPermission(); } catch (_) {}
    st.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    st.ctx = new AudioContext(); // 48k既定→worklet内で3:1間引き（16k直生成は環境依存のため回避）
    await st.ctx.resume().catch(() => {});
    await st.ctx.audioWorklet.addModule('./voice-worklet.js');
    const src = st.ctx.createMediaStreamSource(st.stream);
    st.node = new AudioWorkletNode(st.ctx, 'bk-voice');
    const mute = st.ctx.createGain();
    mute.gain.value = 0; // workletをレンダリンググラフに繋ぎ止める（無音）
    src.connect(st.node).connect(mute).connect(st.ctx.destination);
    st.node.port.onmessage = (e) => onFrame(e.data);
    st.capturing = true;
    st.speech = false; st.speechStart = 0; st.silenceStart = 0;
    setPhase('LISTEN');
  }
  function teardown() {
    st.capturing = false;
    stopPlayback();
    try { if (st.node) st.node.disconnect(); } catch (_) {}
    try { if (st.stream) st.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (st.ctx) st.ctx.close(); } catch (_) {}
    st.node = null; st.stream = null; st.ctx = null;
    setPhase('IDLE', false);
  }

  window.BKLive = {
    init({ button }) {
      st.btn = button;
      if (!button || !window.bigkiji) return;
      button.addEventListener('click', async () => {
        try { await window.bigkiji.liveToggle(); } catch (_) {}
      });
      window.bigkiji.onLiveState((s) => { // 全窓の表示同期（キャプチャ有無に関わらず）
        st.live = !!s.live;
        if (!st.live && st.capturing) teardown();
        if (!st.capturing) setPhase(st.live ? (s.state || 'LISTEN') : 'IDLE', false);
      });
      window.bigkiji.onLiveOwn(async (s) => { // 自窓がマイク所有者に指名された/解除された
        if (s.live) {
          st.live = true;
          try { await startCapture(); } catch (_) {
            teardown();
            try { await window.bigkiji.liveToggle(); } catch (_) {} // マイク不可→ライブ解除
          }
        } else teardown();
      });
      window.addEventListener('bk-audio-state', (event) => {
        const detail = event.detail || {};
        if (detail.track !== 'owner') return;
        st.playing = detail.state === 'playing';
        if (st.playing && st.phase !== 'CAPTURE') setPhase('SPEAK');
        else if (detail.state === 'ended' && st.phase === 'SPEAK') setPhase('LISTEN');
        if (detail.state === 'playing') window.bigkiji.voicePlaybackState({
          state: 'playing', track: detail.track, firstAudioMs: detail.firstAudioMs,
          engine: detail.chunk?.engine, utteranceId: detail.chunk?.utteranceId,
        });
      });
      window.bigkiji.onTtsChunk((c) => { // main sends only to the selected owner window
        if (!c?.buf) return;
        if (window.BKAudio) window.BKAudio.enqueue(c);
        else if (st.capturing) { playQ.push(c.buf); playNext(); }
      });
      window.bigkiji.onVoiceStop((c) => { if (!c?.track || c.track === 'owner') stopPlayback(); });
      window.bigkiji.onSettingsChanged((settings) => window.BKAudio?.apply(settings.audio));
    },
  };
})();
