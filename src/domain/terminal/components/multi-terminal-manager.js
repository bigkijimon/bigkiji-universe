(() => {
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));

  const providerColor = (provider) => provider === 'claude-code'
    ? '#d97757' : provider === 'glm' ? '#8b5cf6' : '#34d399';

  class MultiTerminalManager {
    constructor({ dashboard, shell, livePane, streamPane, streamTabs, neuralTab, shellTab, liveTab, actionPanel, actionList, fitShell }) {
      this.dashboard = dashboard;
      this.shell = shell;
      this.streamPane = streamPane;
      this.livePane = livePane;
      this.streamTabs = streamTabs;
      this.neuralTab = neuralTab;
      this.shellTab = shellTab;
      this.liveTab = liveTab;
      this.actionPanel = actionPanel;
      this.actionList = actionList;
      this.fitShell = fitShell;
      this.tasks = new Map();
      this.active = 'neural';
      this.mode = 'stream';
      this.relay = [];
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

    appendRelay(event = {}) {
      const row = { ts: event.ts || Date.now(), source: event.source || event.agent || 'SYSTEM',
        status: event.sev || event.kind || event.type || 'LIVE', text: event.text || '' };
      if (!row.text) return;
      this.relay.push(row); this.relay = this.relay.slice(-500);
      if (this.active === 'live') this.renderRelay(true);
    }

    setMode(mode) {
      this.mode = mode === 'card' ? 'card' : 'stream';
      const cards = this.mode === 'card';
      this.actionPanel.classList.toggle('on', cards);
      document.getElementById('actionMode')?.classList.toggle('on', cards);
      document.getElementById('streamMode')?.classList.toggle('on', !cards);
      if (!cards) {
        const running = [...this.tasks.values()].reverse().find((task) => ['running', 'queued'].includes(task.status));
        if (running) this.showTask(running.id);
      }
    }

    showBase(which) {
      this.active = which;
      this.dashboard.classList.toggle('paneOff', which !== 'neural');
      this.shell.classList.toggle('paneOff', which !== 'shell');
      this.streamPane.classList.add('paneOff');
      this.livePane?.classList.toggle('paneOff', which !== 'live');
      this.neuralTab.classList.toggle('on', which === 'neural');
      this.shellTab.classList.toggle('on', which === 'shell');
      this.liveTab?.classList.toggle('on', which === 'live');
      this.renderTabs();
      if (which === 'shell') setTimeout(this.fitShell, 30);
      if (which === 'live') this.renderRelay();
    }

    showTask(id) {
      if (!this.tasks.has(id)) return;
      this.active = id;
      this.mode = 'stream';
      this.actionPanel.classList.remove('on');
      document.getElementById('actionMode')?.classList.remove('on');
      document.getElementById('streamMode')?.classList.add('on');
      this.dashboard.classList.add('paneOff');
      this.shell.classList.add('paneOff');
      this.streamPane.classList.remove('paneOff');
      this.livePane?.classList.add('paneOff');
      this.neuralTab.classList.remove('on');
      this.shellTab.classList.remove('on');
      this.liveTab?.classList.remove('on');
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
      for (const task of this.tasks.values()) {
        const card = document.createElement('article');
        card.className = 'task-card';
        card.style.setProperty('--task-color', providerColor(task.provider));
        const canApprove = task.status === 'awaiting_approval';
        const canRetry = ['failed', 'blocked', 'aborted'].includes(task.status);
        const canCancel = ['running', 'queued'].includes(task.status);
        card.innerHTML = `<div class="task-head"><span class="task-name">${escapeHtml(task.promptPreview || task.id)}</span><span class="task-state">${escapeHtml(task.status)}</span></div>
          <div class="task-meta">${escapeHtml(task.provider)} · ${escapeHtml(task.id)} · exit ${escapeHtml(task.exitCode ?? '—')}</div>
          ${task.error ? `<div class="task-log">${escapeHtml(task.error)}</div>` : ''}
          <div class="task-actions">${canApprove ? '<button data-act="approve">Approve</button>' : ''}${canRetry ? '<button data-act="retry">Retry</button>' : ''}${canCancel ? '<button data-act="abort">Cancel</button>' : ''}<button data-act="view">Open Stream</button></div>`;
        card.querySelectorAll('button').forEach((button) => button.addEventListener('click', async () => {
          const action = button.dataset.act;
          if (action === 'view') { this.showTask(task.id); return; }
          try { await window.bigkiji[`${action}Task`](task.id); } catch (error) { console.warn(error); }
        }));
        this.actionList.appendChild(card);
      }
    }
  }

  window.MultiTerminalManager = MultiTerminalManager;
})();
