// エージェント表示メタ（orchestrator.js の AGENTS と対応）
// icon = inline SVG（currentColorで着色・チップ/ツールチップ/凡例用）／glyph = canvasスプライト用
(() => {
  const svg = (body) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';

  // path = Path2D互換の単一dストリング（canvasスプライトへのSVG線画アイコン描画用）
  // role = キャンバスの題字（役割名表示）。label/short = 人名（チップ・ツールチップ）
  window.AGENT_META = {
    'claude-code': { label: 'Claude Code', short: 'Claude', role: 'Claude Code', color: '#d97757',
      path: 'M4 17l6-6-6-6M12 19h8',
      icon: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>') },
    'glm': { label: 'GLM', short: 'GLM', role: 'GLM approved executor', color: '#8b5cf6',
      path: 'M4 12h16M12 4v16M6 6l12 12M18 6L6 18',
      icon: svg('<path d="M4 12h16M12 4v16M6 6l12 12M18 6L6 18"/>') },
    'gemini': { label: 'Gemini', short: 'Gemini', role: 'Gemini', color: '#4e8cff',
      path: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z',
      icon: svg('<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>') },
    'codex': { label: 'Codex', short: 'Codex', role: 'Codex', color: '#00a67d',
      path: 'M8 5l-5 7 5 7M16 5l5 7-5 7',
      icon: svg('<path d="M8 5l-5 7 5 7"/><path d="M16 5l5 7-5 7"/>') },
    'biglama': { label: 'LocalAI BigLama', short: 'BigLama', role: 'LocalAI', color: '#a78bfa',
      path: 'M6 6h12v12H6zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3',
      icon: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>') },
    'marble': { label: 'CEO Marble', short: 'Marble', role: 'School', color: '#34d399',
      path: 'M22 9L12 4 2 9l10 5 10-5zM6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5',
      icon: svg('<path d="M22 9L12 4 2 9l10 5 10-5z"/><path d="M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"/>') },
    'justin': { label: 'CEO Justin', short: 'Justin', role: 'Media', color: '#f472b6',
      path: 'M3 5h18v14H3zM7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4',
      icon: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>') },
    'risa': { label: 'CEO Risa', short: 'Risa', role: 'Design', color: '#fbbf24',
      path: 'M20 4L8.5 15.5M7 16c-1.7 0-3 1.3-3 3 0 .6-.4 1-1 1 .8 1.2 2.1 2 3.5 2 1.9 0 3.5-1.6 3.5-3.5C10 16.8 8.7 16 7 16z',
      icon: svg('<path d="M20 4L8.5 15.5"/><path d="M7 16c-1.7 0-3 1.3-3 3 0 .6-.4 1-1 1 .8 1.2 2.1 2 3.5 2 1.9 0 3.5-1.6 3.5-3.5C10 16.8 8.7 16 7 16z"/>') },
    'coco': { label: 'Coco', short: 'Coco', role: 'Influencer', color: '#f87171',
      path: 'M12 4a4 4 0 100 8 4 4 0 000-8zM4 21c0-4 3.6-6 8-6s8 2 8 6',
      icon: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>') },
  };
  window.CORE_META = { label: 'BigKiji Core', color: '#10b981', glyph: '❖' };

  // BigKijiマーク（❖）: ストローク描画アニメつきロゴSVG（ヘッダ用）
  window.BIGKIJI_MARK =
    '<svg class="bkMark" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="1.6" stroke-linejoin="round">' +
    '<path class="bkP" d="M12 2.8l3.6 3.6L12 10 8.4 6.4 12 2.8z"/>' +
    '<path class="bkP" d="M12 14l3.6 3.6L12 21.2 8.4 17.6 12 14z"/>' +
    '<path class="bkP" d="M2.8 12l3.6-3.6L10 12l-3.6 3.6L2.8 12z"/>' +
    '<path class="bkP" d="M14 12l3.6-3.6L21.2 12l-3.6 3.6L14 12z"/></svg>';

  // ---- i18n（EN/JA表示切替・localStorageに保存・既定EN） ----
  window.I18N = {
    en: {
      hint: 'TAP THE ORB → TYPE COMMAND ｜ ⌥SPACE TO SUMMON',
      ph_ai: 'Ask BigKiji (Gemini · fast cloud)…  ⏎ to send',
      ph_shell: 'Shell command…  ⏎ runs in terminal',
      stream: 'LIVE PROCESS STREAM',
      eventlog: 'SYNAPSE EVENT LOG',
      idleLink: 'no transmissions — standing by',
      youCore: 'You ⇄ Core (Pi thinking)',
      mission: 'MISSION OUTPUT',
      missionSub: 'deliverables & agent results',
      missionEmpty: 'Deliverables from the last 30 days appear here',
      terminal: 'INTEGRATED TERMINAL',
      syncNote: 'synced with light pulses in real time',
      banner: '❖ BigKiji Universe — live zsh shell. You can also send from the command bar above',
      transcribing: '🎙 transcribing…',
      coreThink: 'CORE THINKING · π',
      canvasBtn: '⛶ CANVAS',
      aiBtn: 'π AI', shellBtn: '❯ SHELL',
    },
    ja: {
      hint: 'TAP THE ORB → 指示入力 ｜ ⌥SPACE で呼び出し',
      ph_ai: 'BigKiji（Gemini・高速クラウド）へ指示… ⏎で送信',
      ph_shell: 'シェルコマンド… ⏎でターミナル実行',
      stream: 'LIVE PROCESS STREAM',
      eventlog: 'SYNAPSE EVENT LOG',
      idleLink: '伝達なし — 待機中',
      youCore: 'You ⇄ Core（Pi思考中）',
      mission: 'MISSION OUTPUT',
      missionSub: '成果物 & AGENT RESULTS',
      missionEmpty: '直近30日の成果物がここに表示されます',
      terminal: 'INTEGRATED TERMINAL',
      syncNote: '光パルスとリアルタイム同期',
      banner: '❖ BigKiji Universe — 実シェル(zsh)稼働中。上の指示バー(⏎)からも送れます',
      transcribing: '🎙 文字起こし中…',
      coreThink: 'CORE THINKING · π',
      canvasBtn: '⛶ CANVAS',
      aiBtn: 'π AI', shellBtn: '❯ SHELL',
    },
  };
  // v12: システムUIは全英語固定（オーナー指示 2026-07-31・対話言語はPi側でミラー）
  window.BK_LANG = 'en';
  window.t = (k) => (window.I18N[window.BK_LANG] || {})[k] ?? window.I18N.ja[k] ?? k;
  window.applyI18n = () => {
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = window.t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = window.t(el.dataset.i18nPh); });
  };
  window.setLang = (l) => { window.BK_LANG = l; localStorage.setItem('bk-lang', l); window.applyI18n(); };

  // 相対時刻（ツールチップ用）
  window.relTime = (ts) => {
    if (!ts) return '—';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 10) return 'now';
    if (s < 60) return `${s | 0}s ago`;
    if (s < 3600) return `${(s / 60) | 0}m ago`;
    return `${(s / 3600) | 0}h ago`;
  };
})();
