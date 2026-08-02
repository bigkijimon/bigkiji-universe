'use strict';
// Console window behaviour.
//
// Two surfaces share one window: the conversation and the terminal. They are siblings
// rather than a split, because the owner asked to switch between them — a split would
// halve both on a laptop screen and neither would be comfortable.
//
// Everything shown here is bound to something real. Where the reference interface shows
// a "reasoning effort" control, this shows execution mode and deliberation lenses,
// because those are the settings BigKiji actually has. Inventing a control that changes
// nothing is worse than not having one.

(() => {
  const bk = window.bigkiji;
  const $ = (id) => document.getElementById(id);
  const md = window.BKMarkdown;

  const els = {
    tabs: $('tabs'), thread: $('thread'), empty: $('empty'), scroll: $('scroll'),
    input: $('input'), send: $('send'), elapsed: $('elapsed'), ring: $('ctxRing'), pct: $('ctxPct'),
    modelName: $('modelName'), execMode: $('execMode'), lenses: $('lenses'),
    workspace: $('workspace'), diff: $('diffStat'), toBottom: $('toBottom'),
    segChat: $('segChat'), segTerm: $('segTerm'),
    viewChat: $('viewChatPane'), viewTerm: $('viewTermPane'),
    title: $('winTitle'), sub: $('winSub'), agentMark: $('agentMark'), emptyTitle: $('emptyTitle'),
    quick: $('quickActions'), termHost: $('termHost'), panes: $('panes'),
    approval: $('approval'), approvalTitle: $('approvalTitle'), approvalDetail: $('approvalDetail'),
    approvalGo: $('approvalGo'), approvalAbort: $('approvalAbort'),
  };

  const state = { busy: false, startedAt: 0, ticker: null, agentName: 'PiAgent', view: 'chat',
    sessions: [], activeSession: null, run: null };

  // ---------- helpers ---------------------------------------------------------
  const atBottom = () => els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 40;
  const scrollDown = (smooth = true) => {
    els.scroll.scrollTo({ top: els.scroll.scrollHeight, behavior: smooth && !document.body.classList.contains('reduce-motion') ? 'smooth' : 'auto' });
  };
  const clock = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const timeOf = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function hideEmpty() { if (els.empty) { els.empty.remove(); els.empty = null; } }

  // ---------- rendering -------------------------------------------------------
  function addOwner(text) {
    hideEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'turn owner';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text; // never parsed: this is the owner's literal text
    wrap.appendChild(bubble);
    els.thread.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function addPending() {
    const wrap = document.createElement('div');
    wrap.className = 'turn agent';
    wrap.innerHTML = `<div class="who">${md.escapeHtml(state.agentName)}</div>`
      + '<div class="thinking"><span class="pulse"></span><span>Thinking…</span></div>';
    els.thread.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function fillAgent(wrap, turn, ms) {
    const who = [state.agentName, turn.model].filter(Boolean).join(' · ');
    wrap.className = `turn agent${turn.degraded ? ' degraded' : ''}`;
    wrap.innerHTML = `<div class="who">${md.escapeHtml(who)}</div>`
      + `<div class="md">${md.renderMarkdown(turn.reply || '')}</div>`
      + '<div class="meta"><span class="stamp"></span><span class="rule"></span>'
      + '<button class="redo" type="button" data-redo aria-label="Ask again">↻</button></div>';
    const parts = [timeOf(new Date()), clock(ms)];
    if (turn.ttftMs != null) parts.push(`first token ${clock(turn.ttftMs)}`);
    if (turn.degraded && turn.error) parts.push(turn.error);
    wrap.querySelector('.stamp').textContent = parts.join(' · ');
    wrap.dataset.prompt = wrap.dataset.prompt || '';
  }

  // Links open in the real browser; a renderer holding the IPC surface must not
  // navigate. Code blocks copy from the DOM, not from a cached string.
  els.thread.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-external]');
    if (link) { event.preventDefault(); bk.openExternal(link.getAttribute('href')); return; }
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      const code = copy.closest('figure.code')?.querySelector('code');
      if (code) navigator.clipboard.writeText(code.textContent).then(() => {
        copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      }).catch(() => { copy.textContent = 'Copy failed'; });
      return;
    }
    const redo = event.target.closest('[data-redo]');
    if (redo) {
      const prompt = redo.closest('.turn')?.previousElementSibling?.querySelector('.bubble')?.textContent;
      if (prompt) send(prompt);
    }
  });

  // ---------- sending ---------------------------------------------------------
  function setBusy(busy) {
    state.busy = busy;
    els.send.classList.toggle('stop', busy);
    els.send.textContent = busy ? '■' : '↑';
    els.send.disabled = !busy && !els.input.value.trim();
    els.send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    clearInterval(state.ticker);
    if (busy) {
      state.startedAt = Date.now();
      state.ticker = setInterval(() => { els.elapsed.textContent = clock(Date.now() - state.startedAt); }, 100);
    } else {
      els.elapsed.textContent = '';
    }
  }

  async function send(text) {
    const value = String(text ?? els.input.value).trim();
    if (!value || state.busy) return;
    if (text == null) { els.input.value = ''; autoGrow(); }
    addOwner(value);
    const pending = addPending();
    setBusy(true);
    const began = Date.now();
    try {
      const turn = await bk.conversationTurn(value, {});
      fillAgent(pending, turn || {}, Date.now() - began);
      const used = turn?.context?.estimatedTokens || 0;
      const limit = turn?.context?.limit || 0;
      if (limit) {
        const pct = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
        els.ring.style.setProperty('--pct', String(pct));
        els.pct.textContent = `${pct}%`;
        els.ring.title = `Context used in the last turn: ${used} of ${limit} estimated tokens`;
      }
    } catch (error) {
      pending.className = 'turn agent degraded';
      pending.innerHTML = `<div class="who">${md.escapeHtml(state.agentName)}</div>`
        + `<div class="md"><p>${md.escapeHtml(String(error?.message || error))}</p></div>`;
    } finally {
      setBusy(false);
      if (atBottom()) scrollDown();
    }
  }

  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(210, els.input.scrollHeight)}px`;
    if (!state.busy) els.send.disabled = !els.input.value.trim();
  }

  els.input.addEventListener('input', autoGrow);
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
  });
  els.send.addEventListener('click', () => { if (state.busy) bk.piAbort(); else send(); });
  els.scroll.addEventListener('scroll', () => els.toBottom.classList.toggle('on', !atBottom()));
  els.toBottom.addEventListener('click', () => scrollDown());

  // ---------- quick actions ---------------------------------------------------
  // Phrased as work this app can actually do, so nothing here dead-ends.
  const QUICK = [
    { label: 'Review changes', icon: '◇', prompt: 'Review the changes in this workspace and tell me what looks wrong.' },
    { label: 'Explain this repo', icon: '◈', prompt: 'Explain how this workspace is structured and where the entry points are.' },
    { label: 'Run the tests', icon: '▷', prompt: 'Run the test suite and report what failed, with the actual output.' },
    { label: 'Simplify', icon: '⌁', prompt: 'Find the most over-complicated part of this workspace and propose a simpler shape.' },
  ];
  els.quick.innerHTML = QUICK.map((item, i) =>
    `<button class="chip" data-quick="${i}"><span class="g">${item.icon}</span>${md.escapeHtml(item.label)}</button>`).join('');
  els.quick.addEventListener('click', (event) => {
    const button = event.target.closest('[data-quick]');
    if (button) send(QUICK[Number(button.dataset.quick)].prompt);
  });

  // ---------- view switching --------------------------------------------------
  function setView(view) {
    state.view = view;
    const chat = view === 'chat';
    els.viewChat.classList.toggle('on', chat);
    els.viewTerm.classList.toggle('on', !chat);
    els.segChat.setAttribute('aria-pressed', String(chat));
    els.segTerm.setAttribute('aria-pressed', String(!chat));
    if (chat) els.input.focus();
    else { fitTerm(); term?.focus(); }
  }
  els.segChat.addEventListener('click', () => setView('chat'));
  els.segTerm.addEventListener('click', () => setView('terminal'));

  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key === '1') { event.preventDefault(); setView('chat'); }
    else if (event.key === '2') { event.preventDefault(); setView('terminal'); }
    else if (event.key.toLowerCase() === 'l') { event.preventDefault(); setView('chat'); els.input.focus(); }
  });

  // ---------- terminal --------------------------------------------------------
  // The pty is the one BigKiji already runs; this window mirrors it rather than
  // starting a second shell, so what the owner sees here is the same session the
  // Synapse Canvas shows.
  let term = null; let fit = null;
  function fitTerm() { try { fit?.fit(); bk.ptyResize(term.cols, term.rows); } catch (_) {} }
  function bootTerminal() {
    if (term || typeof window.Terminal !== 'function') return;
    term = new window.Terminal({
      fontFamily: '"SF Mono", Menlo, monospace', fontSize: 12.5, cursorBlink: true,
      theme: { background: '#0b0a08', foreground: '#f3e8d8', cursor: '#f28c28',
        selectionBackground: 'rgba(242,140,40,.28)' },
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(els.termHost);
    fitTerm();
    term.onData((data) => bk.ptyInput(data));
    bk.onPtyData((data) => term.write(data));
    window.addEventListener('resize', () => { if (state.view === 'terminal') fitTerm(); });
  }

  // ---------- sessions --------------------------------------------------------
  // A session is named after what the owner actually asked for. The store keeps that as
  // promptSummary; falling back to the generated id produced a tab strip of
  // "session-msb1cu3c-e744b1", which tells the owner nothing about which one to click.
  function sessionLabel(session) {
    const summary = String(session.promptSummary || '').replace(/\s+/g, ' ').trim();
    if (summary) return summary.length > 34 ? `${summary.slice(0, 33)}…` : summary;
    const when = session.updatedAt || session.createdAt;
    return when ? new Date(when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Session';
  }

  const RUNNING = new Set(['running', 'EXECUTING', 'PREFLIGHT', 'REPAIRING']);
  function renderTabs() {
    const items = state.sessions.slice(0, 8);
    els.tabs.innerHTML = items.map((session) => {
      const id = String(session.id || '');
      return `<button class="tab" role="tab" data-session="${md.escapeHtml(id)}" title="${md.escapeHtml(id)}"`
        + ` aria-selected="${String(id === state.activeSession)}">`
        + `<span class="dot">${md.escapeHtml(state.agentName.slice(0, 1).toUpperCase())}</span>`
        + `<span class="label">${md.escapeHtml(sessionLabel(session))}</span>`
        + (RUNNING.has(session.status) ? '<span class="spin"></span>' : '') + '</button>';
    }).join('') + '<span class="grow"></span>';
  }
  els.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-session]');
    if (!tab) return;
    state.activeSession = tab.dataset.session;
    renderTabs();
  });

  async function loadSessions() {
    try {
      const list = await bk.listSessions();
      // The store returns newest first (session-store.js sorts by updatedAt descending),
      // so the current session is the head. Taking the tail selected the oldest one,
      // which then sat off the end of the strip with nothing appearing selected.
      state.sessions = Array.isArray(list) ? list : (list?.items || []);
      // Follow the session the daemon says is current, so a turn started anywhere —
      // this window, the tray, the phone — highlights the tab the owner is watching.
      // Falling back to the head keeps it sane before the daemon answers.
      if (!state.sessions.some((session) => session.id === state.activeSession)) state.activeSession = null;
      if (!state.activeSession && state.sessions.length) state.activeSession = state.sessions[0].id;
      renderTabs();
    } catch (_) { /* the daemon may not be up yet; the tab strip stays empty */ }
  }

  // ---------- specialist panes ------------------------------------------------
  // When the coordinator plans a run it assigns roles to separate provider processes —
  // leader to Claude Code, ui to Codex, debug to GLM, and so on. Each of those is a real
  // process with its own model and its own output, so each gets a pane. This is the one
  // place in the app where "several models are working at once" stops being a claim in a
  // status line and becomes something the owner can watch.
  const LOG_LINES = 400;
  const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

  function paneFor(taskId) { return document.querySelector(`[data-task="${CSS.escape(taskId)}"]`); }

  function renderPanes(run) {
    const assignments = Array.isArray(run?.assignments) ? run.assignments : [];
    const wanted = new Set(assignments.map((item) => item.taskId));
    for (const pane of els.panes.querySelectorAll('.pane-agent')) {
      if (!wanted.has(pane.dataset.task)) pane.remove();
    }
    for (const item of assignments) {
      let pane = paneFor(item.taskId);
      if (!pane) {
        pane = document.createElement('div');
        pane.className = 'pane pane-agent';
        pane.dataset.task = item.taskId;
        pane.innerHTML = '<div class="pane-head"><span class="role"></span><span class="who"></span>'
          + '<span class="grow"></span><span class="state"></span></div>'
          + '<div class="pane-log"><span class="idle">Waiting for approval…</span></div>';
        els.panes.appendChild(pane);
      }
      pane.querySelector('.role').textContent = item.role || 'agent';
      // Provider and model together: "which brain" is part of what was approved, and a
      // fallback can move the work to a different provider mid-run.
      pane.querySelector('.who').textContent = [item.provider, item.model].filter(Boolean).join(' · ');
      const state = pane.querySelector('.state');
      state.textContent = String(item.status || '').replace(/_/g, ' ') || '—';
      state.dataset.state = item.status || '';
      pane.title = item.title || '';
    }
  }

  // How much of the workspace this run has actually changed.
  //
  // The status bar has carried an empty `#diffStat` since this window was built.
  // The CLI has rendered real diffs the whole time (transcript.js formatDiff),
  // so the owner could see the shape of a change in the terminal and nothing at
  // all in the window they approve from — which is the wrong way round.
  //
  // This is a counter, not a second diff renderer: one number for added lines
  // and one for removed, so "approve" is not a blind yes. A provider only starts
  // being counted once it emits a hunk header, because a bare '+' at the start
  // of a line is ordinary prose far more often than it is a patch.
  const diffs = new Map(); // taskId -> { patching, added, removed }
  const HUNK = /^(@@ |diff --git |Index: )/;

  function countDiff(taskId, text) {
    let seen = diffs.get(taskId);
    for (const line of String(text).split('\n')) {
      if (HUNK.test(line)) { seen = seen || { added: 0, removed: 0 }; seen.patching = true; continue; }
      if (!seen?.patching) continue;
      if (line.startsWith('+++') || line.startsWith('---')) continue; // file headers, not content
      if (line.startsWith('+')) seen.added += 1;
      else if (line.startsWith('-')) seen.removed += 1;
    }
    if (seen) diffs.set(taskId, seen);
    renderDiffStat();
  }

  function renderDiffStat() {
    let added = 0; let removed = 0;
    for (const entry of diffs.values()) { added += entry.added; removed += entry.removed; }
    els.diff.textContent = '';
    if (!added && !removed) return;
    const plus = document.createElement('span'); plus.className = 'plus'; plus.textContent = `+${added}`;
    const minus = document.createElement('span'); minus.className = 'minus'; minus.textContent = `−${removed}`;
    els.diff.append(plus, minus);
    els.diff.title = `${added} line${added === 1 ? '' : 's'} added, ${removed} removed across this run`;
  }

  function appendLog(taskId, text, isError) {
    const pane = paneFor(taskId);
    if (!pane) return;
    if (!isError) countDiff(taskId, text);
    const log = pane.querySelector('.pane-log');
    const idle = log.querySelector('.idle');
    if (idle) idle.remove();
    const line = document.createElement('span');
    if (isError) line.className = 'err';
    line.textContent = `${String(text).replace(ANSI, '')}\n`;
    const stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    log.appendChild(line);
    while (log.childNodes.length > LOG_LINES) log.removeChild(log.firstChild);
    if (stuck) log.scrollTop = log.scrollHeight;
  }

  // The approval gate. Nothing that can mutate anything starts without passing through
  // here, and the hashes have to be echoed back exactly — the coordinator rejects a
  // stale revision, plan or disclosure rather than running something the owner did not
  // see (core-execution-coordinator.js approve()).
  function showApproval(run) {
    const waiting = run && (run.status === 'AWAITING_APPROVAL' || run.status === 'SECURITY_BLOCKED');
    els.approval.hidden = !waiting;
    if (!waiting) return;
    const blocked = run.status === 'SECURITY_BLOCKED';
    els.approvalTitle.textContent = blocked
      ? 'The sandbox refused part of this run'
      : `${run.assignments?.length || 0} specialist${run.assignments?.length === 1 ? '' : 's'} ready · your approval starts them`;
    els.approvalDetail.textContent = `plan ${String(run.planHash || '').slice(0, 12)} · disclosure ${String(run.disclosureHash || '').slice(0, 12)} · rev ${run.revision}`;
    els.approvalGo.disabled = blocked;
    els.approvalGo.textContent = blocked ? 'Blocked' : 'Approve';
  }

  function ingestRun(run) {
    if (!run || !run.id) return;
    // A new run starts a new count. Carrying the previous run's tally forward
    // would make the number the owner approves against wrong in the one
    // direction that matters — larger than what is about to happen.
    if (state.run?.id !== run.id) { diffs.clear(); renderDiffStat(); }
    state.run = run;
    renderPanes(run);
    showApproval(run);
  }

  els.approvalGo.addEventListener('click', async () => {
    const run = state.run;
    if (!run || els.approvalGo.disabled) return;
    els.approvalGo.disabled = true;
    try {
      await bk.approveRun({ id: run.id, revision: run.revision, planHash: run.planHash,
        disclosureHash: run.disclosureHash, idempotencyKey: `console-${run.id}-${run.revision}` });
    } catch (error) {
      els.approvalDetail.textContent = String(error?.message || error);
      els.approvalGo.disabled = false;
    }
  });
  els.approvalAbort.addEventListener('click', () => {
    if (state.run) bk.abortRun(state.run.id).catch(() => {});
  });

  bk.onRunEvent?.((event) => ingestRun(event));
  bk.onTaskLog?.((log) => appendLog(log?.taskId, log?.text || '', log?.stream === 'stderr'));
  bk.onTaskEvent?.((task) => {
    const pane = paneFor(task?.id);
    if (!pane) return;
    const state_ = pane.querySelector('.state');
    state_.textContent = String(task.status || '').replace(/_/g, ' ');
    state_.dataset.state = task.status || '';
    if (task.error) appendLog(task.id, task.error, true);
  });

  // ---------- settings + status ----------------------------------------------
  function applySettings(settings) {
    if (!settings) return;
    const name = String(settings.piAgent?.displayName || '').trim() || 'PiAgent';
    state.agentName = name;
    els.emptyTitle.textContent = `Chat with ${name}`;
    els.agentMark.textContent = name.slice(0, 1).toUpperCase();
    els.modelName.textContent = settings.conversation?.model || '—';
    els.execMode.value = settings.routing?.executionMode || 'plan';
    els.lenses.value = String(settings.routing?.deliberationLenses ?? 2);
    document.body.classList.toggle('reduce-motion', !!settings.appearance?.reduceMotion);
  }
  els.execMode.addEventListener('change', () => bk.settingsUpdate({ routing: { executionMode: els.execMode.value } }));
  els.lenses.addEventListener('change', () => bk.settingsUpdate({ routing: { deliberationLenses: Number(els.lenses.value) } }));

  // The Synapse Canvas is the 3D scene. It lives in its own window so it is never
  // underneath the text the owner is reading — the whole reason this window exists.
  $('btnSynapse').addEventListener('click', () => bk.openMain());
  $('btnCanvas').addEventListener('click', () => bk.openMain());
  // The gear is wired by BKSettings.init() in console.html, against the same settings
  // surface the Synapse Canvas uses.

  // ---------- live events -----------------------------------------------------
  bk.onSettingsChanged?.(applySettings);
  // A new turn opens a new session; follow it rather than leaving the old tab selected.
  bk.onSessionUpdate?.((session) => { if (session?.id) state.activeSession = session.id; loadSessions(); });
  bk.onConversation?.(() => loadSessions());
  bk.onComposerFocus?.(() => { setView('chat'); els.input.focus(); });
  // The application menu's Settings… item lands here; the modal lives in the renderer.
  bk.onOpenSettings?.(() => window.BKSettings?.open?.());

  // ---------- boot ------------------------------------------------------------
  (async () => {
    bootTerminal();
    try { applySettings(await bk.settingsGet()); } catch (_) {}
    // Registered workspaces first. With none registered the vault BigKiji is actually
    // reading is still the honest answer — saying "no workspace" while the app is
    // happily indexing one would be worse than saying nothing.
    let info = null;
    try { info = await bk.getInfo(); } catch (_) {}
    try {
      const workspace = await bk.workspaceState();
      const roots = (workspace?.roots || []).filter((root) => root.status === 'ok');
      if (roots.length) {
        els.workspace.innerHTML = `<b>${md.escapeHtml(roots[0].label || roots[0].path)}</b>`
          + (roots.length > 1 ? ` +${roots.length - 1}` : '');
        els.workspace.title = roots.map((root) => root.path).join('\n');
      } else {
        const vault = info?.paths?.vaultRoot || '';
        els.workspace.innerHTML = vault
          ? `<b>${md.escapeHtml(vault.split('/').pop())}</b> · not registered`
          : 'No workspace';
        els.workspace.title = vault;
      }
    } catch (_) { els.workspace.textContent = '—'; }
    els.sub.textContent = info?.buildId ? String(info.buildId) : '';
    await loadSessions();
    // A run may already be in flight, or already waiting for an approval the owner never
    // saw because this window was not open yet.
    try {
      const runs = await bk.listRuns();
      const live = (Array.isArray(runs) ? runs : [])
        .filter((run) => !['COMPLETED', 'FAILED'].includes(run.status)).pop();
      if (live) ingestRun(live);
    } catch (_) {}
    els.input.focus();
  })();
})();
