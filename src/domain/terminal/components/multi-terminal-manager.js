(() => {
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));

  const providerColor = (provider) => provider === 'claude-code'
    ? '#d97757' : provider === 'glm' ? '#8b5cf6' : '#34d399';

  class MultiTerminalManager {
    constructor({ dashboard, shell, livePane, previewPane, streamPane, streamTabs, neuralTab, shellTab, liveTab, sessionsTab, previewTab, actionPanel, actionList, fitShell }) {
      this.dashboard = dashboard;
      this.shell = shell;
      this.streamPane = streamPane;
      this.livePane = livePane;
      this.previewPane = previewPane;
      this.streamTabs = streamTabs;
      this.neuralTab = neuralTab;
      this.shellTab = shellTab;
      this.liveTab = liveTab;
      this.sessionsTab = sessionsTab;
      this.previewTab = previewTab;
      this.actionPanel = actionPanel;
      this.actionList = actionList;
      this.fitShell = fitShell;
      this.tasks = new Map();
      this.runs = new Map();
      this.sessions = new Map();
      this.active = 'neural';
      this.mode = 'stream';
      this.relay = [];
      this.dismissedTasks = new Set();
      this.dismissedRuns = new Set();
    }

    upsert(task) {
      if (!task?.id) return;
      const prior = this.tasks.get(task.id) || { output: '' };
      this.tasks.set(task.id, { ...prior, ...task, output: task.output ?? prior.output ?? '' });
      if (this.active === task.id) this.renderActiveStream();
      this.renderTabs();
      this.renderCards();
    }

    append(log) {
      if (!log?.taskId) return;
      const task = this.tasks.get(log.taskId) || { id: log.taskId, provider: 'task', status: 'running', output: '' };
      task.output = `${task.output || ''}${task.output ? '\n' : ''}${log.text || ''}`.slice(-24000);
      this.tasks.set(task.id, task);
      if (this.active === task.id) this.renderActiveStream(true);
      this.renderTabs();
    }

    upsertRun(run) {
      if (!run?.id) return;
      this.runs.set(run.id, { ...(this.runs.get(run.id) || {}), ...run });
      this.renderCards();
    }

    setSessions(sessions = []) {
      for (const session of sessions) if (session?.id) this.sessions.set(session.id, session);
      this.renderCards();
    }

    appendRelay(event = {}) {
      const row = { ts: event.ts || Date.now(), source: event.source || event.agent || 'SYSTEM',
        status: event.sev || event.kind || event.type || 'LIVE', text: event.text || '' };
      if (!row.text) return;
      this.relay.push(row); this.relay = this.relay.slice(-500);
      if (this.active === 'live') this.renderRelay(true);
    }

    setMode(mode) {
      this.mode = mode === 'card' ? 'card' : 'stream';
      if (this.mode === 'card') this.showBase('sessions');
      else {
        const running = [...this.tasks.values()].reverse().find((task) => ['running', 'queued'].includes(task.status));
        if (running) this.showTask(running.id); else this.showBase('neural');
      }
    }

    showBase(which) {
      this.active = which;
      this.dashboard.classList.toggle('paneOff', which !== 'neural');
      this.shell.classList.toggle('paneOff', which !== 'shell');
      this.streamPane.classList.add('paneOff');
      this.livePane?.classList.toggle('paneOff', which !== 'live');
      this.previewPane?.classList.toggle('paneOff', which !== 'preview');
      this.actionPanel?.classList.toggle('paneOff', which !== 'sessions');
      this.neuralTab.classList.toggle('on', which === 'neural');
      this.shellTab.classList.toggle('on', which === 'shell');
      this.liveTab?.classList.toggle('on', which === 'live');
      this.sessionsTab?.classList.toggle('on', which === 'sessions');
      this.previewTab?.classList.toggle('on', which === 'preview');
      this.renderTabs();
      if (which === 'shell') setTimeout(this.fitShell, 30);
      if (which === 'live') this.renderRelay();
      if (which === 'sessions') this.renderCards();
    }

    showTask(id) {
      if (!this.tasks.has(id)) return;
      this.active = id;
      this.mode = 'stream';
      this.actionPanel?.classList.add('paneOff');
      this.dashboard.classList.add('paneOff');
      this.shell.classList.add('paneOff');
      this.streamPane.classList.remove('paneOff');
      this.livePane?.classList.add('paneOff');
      this.previewPane?.classList.add('paneOff');
      this.neuralTab.classList.remove('on');
      this.shellTab.classList.remove('on');
      this.liveTab?.classList.remove('on');
      this.sessionsTab?.classList.remove('on');
      this.previewTab?.classList.remove('on');
      this.renderTabs();
      this.renderActiveStream();
    }

    renderTabs() {
      this.streamTabs.innerHTML = '';
      for (const task of this.tasks.values()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `tab task-tab${this.active === task.id ? ' on' : ''}`;
        button.style.setProperty('--em', providerColor(task.provider));
        button.dataset.state = task.status || 'queued';
        button.title = `${task.provider || 'task'} · ${task.id}`;
        button.innerHTML = `<i></i>${escapeHtml((task.provider || 'task').replace('-code', ''))}`;
        button.addEventListener('click', (event) => { event.stopPropagation(); this.showTask(task.id); });
        this.streamTabs.appendChild(button);
      }
    }

    renderActiveStream(stickToBottom = false) {
      const task = this.tasks.get(this.active);
      if (!task) return;
      const wasBottom = stickToBottom || this.streamPane.scrollHeight - this.streamPane.scrollTop - this.streamPane.clientHeight < 28;
      this.streamPane.innerHTML = `<div class="task-stream-head" style="--task-color:${providerColor(task.provider)}">
        <span>${escapeHtml(task.provider || 'TASK')}</span><b>${escapeHtml(task.status || 'queued')}</b><code>${escapeHtml(task.id)}</code>
      </div><pre>${escapeHtml(task.output || task.error || 'Awaiting task output…')}</pre>`;
      if (wasBottom) this.streamPane.scrollTop = this.streamPane.scrollHeight;
    }

    renderRelay(stickToBottom = false) {
      if (!this.livePane) return;
      const wasBottom = stickToBottom || this.livePane.scrollHeight - this.livePane.scrollTop - this.livePane.clientHeight < 30;
      this.livePane.innerHTML = `<div class="relay-head"><b>MISSION RELAY</b><span>owner-visible agent activity · live</span></div><div class="relay-lines">${this.relay.map((row) => {
        const time = new Date(row.ts).toLocaleTimeString([], { hour12: false });
        return `<div class="relay-line"><time>${escapeHtml(time)}</time><b>${escapeHtml(row.source)}</b><em>${escapeHtml(String(row.status).toUpperCase())}</em><span>${escapeHtml(row.text)}</span></div>`;
      }).join('') || '<div class="relay-empty">No agent transmissions yet. Start a task or open a terminal.</div>'}</div>`;
      if (wasBottom) this.livePane.scrollTop = this.livePane.scrollHeight;
    }

    renderCards() {
      this.actionList.innerHTML = '';
      const history = [...this.sessions.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 8);
      if (history.length) {
        const strip = document.createElement('section'); strip.className = 'session-history-strip';
        strip.innerHTML = `<div class="history-label"><b>SESSION HISTORY</b><span>${history.length} local JSONL sessions</span></div><div class="history-list">${history.map((session) => `<button type="button" data-session-id="${escapeHtml(session.id)}"><b>${escapeHtml(session.promptSummary || session.id)}</b><span>${escapeHtml(session.status || 'IDLE')} · ${escapeHtml(new Date(session.updatedAt).toLocaleString())}</span></button>`).join('')}</div>`;
        strip.querySelectorAll('[data-session-id]').forEach((button) => button.onclick = async () => {
          const session = await window.bigkiji.getSession(button.dataset.sessionId);
          for (const entry of session?.events || []) { if (entry.run) this.upsertRun(entry.run); if (entry.task) this.upsert(entry.task); }
        });
        this.actionList.appendChild(strip);
      }
      const runs = [...this.runs.values()].filter((run) => !this.dismissedRuns.has(run.id)).reverse().slice(0, 6);
      if (!history.length && !runs.length && !this.tasks.size) this.actionList.innerHTML = '<div class="session-empty">No sessions yet. Send a brief to let PiAgent choose the smallest useful model set.</div>';
      for (const run of runs) {
        const card = document.createElement('article'); card.className = 'task-card run-card'; card.style.setProperty('--task-color', '#86a995');
        const canApprove = run.status === 'AWAITING_APPROVAL'; const canCancel = ['AWAITING_APPROVAL', 'DISPATCHING', 'EXECUTING', 'REPAIRING'].includes(run.status);
        const progress = ({ PLANNING:8, AWAITING_APPROVAL:18, DISPATCHING:28, EXECUTING:58, REPAIRING:72, VERIFYING:88, COMPLETED:100, FAILED:100 })[run.status] || 0;
        card.innerHTML = `<div class="task-head"><span class="task-name">${escapeHtml(run.promptPreview || run.id)}</span><span class="task-state">${escapeHtml(run.status)}</span><button class="task-dismiss" data-run-dismiss aria-label="Dismiss session">×</button></div>
          <div class="task-meta">${escapeHtml(run.leader || 'auto leader')} · ${run.assignments?.length || 0} Pi-selected models · repair ${run.repairCycle || 0}/${run.maxRepairCycles || 0}</div>
          <div class="task-progress"><i style="width:${progress}%"></i></div><div class="assignment-chips">${(run.assignments || []).map((item) => `<span data-state="${escapeHtml(item.status)}"><i></i>${escapeHtml(item.provider)} · ${escapeHtml(item.status)}</span>`).join('')}</div>
          <div class="task-actions">${canApprove ? '<button data-run-act="approve">Start selected models</button>' : ''}${canCancel ? '<button class="quiet" data-run-act="abort">Cancel</button>' : ''}</div>`;
        card.querySelectorAll('[data-run-act]').forEach((button) => button.onclick = async () => {
          if (button.dataset.runAct === 'approve') await window.bigkiji.approveRun(run.id); else await window.bigkiji.abortRun(run.id);
        }); card.querySelector('[data-run-dismiss]').onclick = () => { this.dismissedRuns.add(run.id); this.renderCards(); }; this.actionList.appendChild(card);
      }
      for (const task of [...this.tasks.values()].filter((task) => !this.dismissedTasks.has(task.id)).reverse().slice(0, 12)) {
        const card = document.createElement('article');
        card.className = 'task-card';
        card.style.setProperty('--task-color', providerColor(task.provider));
        const canApprove = task.status === 'awaiting_approval';
        const canRetry = ['failed', 'blocked', 'aborted'].includes(task.status);
        const canCancel = ['running', 'queued'].includes(task.status);
        const progress = task.status === 'completed' ? 100 : ['failed','blocked'].includes(task.status) ? 100 : task.status === 'running' ? 55 : task.status === 'queued' ? 22 : 10;
        card.innerHTML = `<div class="task-head"><span class="task-name">${escapeHtml(task.metadata?.title || task.promptPreview || task.id)}</span><span class="task-state">${escapeHtml(task.status)}</span><button class="task-dismiss" data-dismiss aria-label="Dismiss task">×</button></div>
          <div class="task-meta">${escapeHtml(task.provider)} · ${escapeHtml(task.id)} · exit ${escapeHtml(task.exitCode ?? '—')}</div>
          <div class="task-progress"><i style="width:${progress}%"></i></div>${task.error ? `<details class="task-log"><summary>Failure details</summary>${escapeHtml(task.error)}</details>` : ''}
          <div class="task-actions">${canApprove ? '<button data-act="approve">Approve</button>' : ''}${canRetry ? '<button data-act="retry">Retry</button>' : ''}${canCancel ? '<button data-act="abort">Cancel</button>' : ''}<button data-act="view">Open Stream</button></div>`;
        card.querySelectorAll('[data-act]').forEach((button) => button.addEventListener('click', async () => {
          const action = button.dataset.act;
          if (action === 'view') { this.showTask(task.id); return; }
          try { await window.bigkiji[`${action}Task`](task.id); } catch (error) { console.warn(error); }
        }));
        card.querySelector('[data-dismiss]').onclick = () => { this.dismissedTasks.add(task.id); this.renderCards(); };
        this.actionList.appendChild(card);
      }
    }
  }

  window.MultiTerminalManager = MultiTerminalManager;
})();
