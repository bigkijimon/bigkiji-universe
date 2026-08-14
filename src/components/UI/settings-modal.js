'use strict';

(() => {
  const speakers = ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'];
  const providerLabels = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', glm: 'GLM' };
  const PI_AGENT_NAME_MAX = 32;          // keep in sync with PI_AGENT_NAME_MAX in src/core/settings-store.js
  const PI_AGENT_NAME_FALLBACK = 'PiAgent';
  // Path-aware <output> formatting. Anything not listed renders as a plain number,
  // which is correct for the integer sliders (max agents, context tokens, cycles, tabs).
  const RATIO_OUTPUTS = new Set(['audio.ownerSpeedEnglish', 'audio.ownerSpeedJapanese', 'appearance.textScale']);
  const PERCENT_OUTPUTS = new Set(['audio.pauseNaturalness', 'audio.ownerVolume', 'audio.agentVolume',
    'audio.sfx.ui', 'audio.sfx.alert', 'audio.sfx.ambient']);
  let state = null; let root = null; let saveTimer = null;
  // Detected local tools, filled once before the modal renders so every row exists by the
  // time bind() attaches the standard [data-setting] listeners.
  let tools = []; let toolsProbed = false;
  let workspaces = { roots: [], candidates: [], defaultExclude: [], documentsRoot: '' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (value) => `${Math.round(Number(value) * 100)}%`;
  const speakerOptions = (current) => speakers.map((v) => `<option ${v === current ? 'selected' : ''}>${v}</option>`).join('');
  const piAgentName = () => String(state?.piAgent?.displayName || PI_AGENT_NAME_FALLBACK);
  function formatOutput(path, value) {
    if (RATIO_OUTPUTS.has(path)) return `${Number(value).toFixed(2)}×`;
    if (PERCENT_OUTPUTS.has(path)) return pct(value);
    return String(value);
  }
  function set(obj, path, value) { const keys = path.split('.'); let at = obj; keys.slice(0, -1).forEach((k) => { at[k] ||= {}; at = at[k]; }); at[keys.at(-1)] = value; }
  function get(obj, path) { return path.split('.').reduce((at, key) => (at == null ? at : at[key]), obj); }
  // Push `state` back into the rendered controls. Without this the modal keeps showing the
  // values it was built with, so a change made elsewhere (or a value the store clamped)
  // would be displayed incorrectly — a control that lies about what is actually saved.
  function syncControls() {
    if (!root) return;
    root.querySelectorAll('[data-setting]').forEach((input) => {
      if (input === document.activeElement) return; // never fight the owner's cursor
      const path = input.dataset.setting;
      const value = get(state, path);
      if (value === undefined) return;
      if (input.type === 'checkbox') input.checked = !!value; else input.value = value;
      const rail = input.closest('.voice-rail');
      if (rail) { rail.style.setProperty('--level', pct(value)); rail.querySelector('strong').textContent = pct(value); }
      const output = input.parentElement.querySelector('output');
      if (output) output.textContent = formatOutput(path, value);
    });
  }
  // Broadcast the owner's PiAgent name to every label that shows it, without a reload.
  function applyPiAgentName(name) {
    const label = String(name || '').trim() || PI_AGENT_NAME_FALLBACK;
    window.BKPiAgentName = label;
    document.querySelectorAll('[data-piagent-name]').forEach((el) => { el.textContent = label; });
    window.dispatchEvent(new CustomEvent('bk-piagent-name', { detail: { displayName: label } }));
  }
  function scheduleSave() {
    clearTimeout(saveTimer); saveTimer = setTimeout(async () => {
      saveTimer = null; // cleared first so an incoming settings:changed knows no edit is pending
      state = await window.bigkiji.settingsUpdate(state);
      window.BKAudio?.apply(state.audio);
      document.documentElement.style.fontSize = `${state.appearance.textScale * 100}%`;
      document.body.classList.toggle('reduce-motion', !!state.appearance.reduceMotion);
      applyPiAgentName(piAgentName()); // the store trims and caps, so reflect the stored value back
      // A few keys (the vault, the graph file, the ComfyUI root) are editable from two
      // tabs. Pushing the stored value back keeps the other copy from lying.
      syncControls();
    }, 120);
  }
  // `path` is the full dotted settings path, so a rail can drive any 0-1 value.
  function rail(path, label, color, value) {
    return `<div class="voice-rail" data-rail="${path}" style="--rail:${color};--level:${pct(value)}"><label>${label}<strong>${pct(value)}</strong></label><input data-setting="${path}" type="range" min="0" max="1" step="0.01" value="${value}"></div>`;
  }
  function profileRow(id) {
    const profile = state.audio.profiles[id];
    const label = id === 'pi' ? `<span data-piagent-name>${esc(piAgentName())}</span>` : esc(providerLabels[id] || id);
    return `<div class="setting-row"><label>${label}<small style="display:block;color:#61736e">${esc(profile.label)}</small></label><select data-setting="audio.profiles.${id}.speaker">${speakerOptions(profile.speaker)}</select><button data-preview="${id}">🔊 Test</button></div>`;
  }
  // ---- local tool connections ----------------------------------------------
  // Three states, never a boolean: `connected` means a health check answered, `found`
  // means it is installed but unverified, `missing` means nothing is there. A check that
  // has not run says so — an unchecked tool is never painted green.
  function badgeClass(tool) {
    if (tool.checking) return '';
    if (tool.status === 'connected') return 'ok';
    if (tool.status === 'missing') return tool.optional ? '' : 'bad';
    return '';
  }
  function badgeText(tool) {
    if (tool.checking) return 'Checking…';
    if (tool.status === 'connected') return 'Connected';
    if (tool.status === 'missing') return tool.optional ? 'Not present · optional' : 'Not found';
    if (!tool.probe) return 'Installed';
    return tool.checked ? 'Installed · not answering' : 'Installed · not checked';
  }
  // The placeholder carries what detection resolved, so emptying the field visibly hands
  // the row back to detection instead of pinning a blank path.
  function toolPlaceholder(tool) {
    if (tool.status === 'missing') return tool.optional ? 'Optional · not present on this machine' : 'Not found — choose it if it is installed';
    return tool.path || '';
  }
  function toolRow(tool) {
    const setting = `paths.${tool.settingKey}`;
    const saved = get(state, setting);
    const choose = tool.kind === 'directory' ? 'Choose folder…' : tool.kind === 'http' ? '' : 'Choose file…';
    return `<div class="setting-row"><label>${esc(tool.label)}<small style="display:block;color:#61736e">${esc(tool.purpose)}</small></label>`
      + `<input data-setting="${setting}" data-tool-input="${esc(tool.id)}" spellcheck="false" autocomplete="off" placeholder="${esc(toolPlaceholder(tool))}" value="${esc(typeof saved === 'string' ? saved : '')}">`
      // Each .setting-row is its own grid, so the status column is pinned to a fixed
      // width: without it the longest badge ("Installed · not answering") would push one
      // row's path field narrower than its neighbours and the column would read ragged.
      + `<span style="display:flex;align-items:center;gap:7px;justify-self:end">`
      + `<b class="connection ${badgeClass(tool)}" style="min-width:146px" data-tool-status="${esc(tool.id)}" title="${esc(tool.detail || '')}"><i></i>${esc(badgeText(tool))}</b>`
      + (choose ? `<button data-tool-choose="${esc(tool.id)}" style="min-width:94px">${choose}</button>` : '')
      + `<button data-tool-test="${esc(tool.id)}">Test</button>`
      + (tool.custom ? `<button data-tool-remove="${esc(tool.id)}" title="Remove this connection">Remove</button>` : '')
      + `</span></div>`;
  }
  // ---- workspaces ------------------------------------------------------------
  // A registered folder is one BigKiji may read and edit. Candidates are proposed from
  // ~/Documents because that is where the owner keeps their working folders, but a
  // proposal is never a registration: a directory becoming readable because it happened
  // to sit in the right place is not something anyone asked for.
  const WORKSPACE_STATUS = { ok: ['ok', 'Connected'], unreadable: ['warn', 'Permission needed'], missing: ['bad', 'Folder is gone'] };
  function workspaceRow(root_) {
    const [tone, label] = WORKSPACE_STATUS[root_.status] || ['warn', 'Unknown'];
    const excluded = (root_.exclude || []).length;
    return `<div class="setting-row"><label>${esc(root_.label)}<small style="display:block;color:#61736e">${esc(root_.path)}</small></label>`
      + `<span style="justify-self:end;color:#61736e;font-size:11px">${excluded} excluded</span>`
      + `<span style="display:flex;align-items:center;gap:7px;justify-self:end">`
      + `<b class="connection ${tone}" style="min-width:132px"><i></i>${esc(label)}</b>`
      + (root_.overridden ? '<b style="color:#61736e;font-size:11px">env</b>'
        : `<button data-workspace-remove="${esc(root_.id)}">Remove</button>`) + '</span></div>';
  }
  function workspacesCard() {
    const rows = workspaces.roots.length ? workspaces.roots.map(workspaceRow).join('')
      : '<p class="settings-copy">No folders added yet. BigKiji can read and edit nothing until you add one.</p>';
    const proposals = (workspaces.candidates || []).slice(0, 8).map((item) =>
      `<button data-workspace-add="${esc(item.path)}" title="${esc(item.path)}">${esc(item.label)}${item.isObsidianVault ? ' · vault' : ''}</button>`).join('');
    const overridden = workspaces.roots.some((root_) => root_.overridden);
    return `<div class="settings-card wide"><h3>WORKSPACE FOLDERS</h3>${rows}
      <div class="cmux-controls" style="margin-top:12px;flex-wrap:wrap">${proposals}<button data-workspace="choose">Add another folder…</button></div>
      <p class="settings-copy" style="margin-top:9px">${overridden
        ? 'BIGKIJI_WORKSPACES is set, so this list comes from the environment and edits here are ignored until it is unset.'
        : `Suggestions come from ${esc(workspaces.documentsRoot || '~/Documents')}. Adding one is what grants access — nothing is scanned before you do.`}</p>
      <p class="settings-copy" style="margin-top:8px">A folder inside one you have already added is refused rather than counted twice, and a folder that disappears is reported here instead of being quietly re-pointed somewhere else. Every root skips ${esc((workspaces.defaultExclude || []).slice(0, 4).join(', '))} and the rest of the usual build output.</p></div>`;
  }
  async function refreshWorkspaces({ rerender = true } = {}) {
    try { workspaces = await window.bigkiji.workspaceState(); } catch (_) { return; }
    const host = root?.querySelector('[data-workspace-host]');
    if (rerender && host) { host.innerHTML = workspacesCard(); bindWorkspaces(); }
  }
  function bindWorkspaces() {
    root.querySelectorAll('[data-workspace-add]').forEach((button) => button.onclick = async () => {
      button.disabled = true;
      try { workspaces = await window.bigkiji.workspaceRegister({ path: button.dataset.workspaceAdd }); await refreshWorkspaces(); }
      catch (error) { button.textContent = error.message.slice(0, 40); button.disabled = false; }
    });
    root.querySelectorAll('[data-workspace-remove]').forEach((button) => button.onclick = async () => {
      workspaces = await window.bigkiji.workspaceRemove(button.dataset.workspaceRemove); await refreshWorkspaces();
    });
    const choose = root.querySelector('[data-workspace="choose"]');
    if (choose) choose.onclick = async () => {
      choose.disabled = true;
      try { workspaces = await window.bigkiji.workspaceChoose(); await refreshWorkspaces(); }
      catch (error) { choose.textContent = error.message.slice(0, 40); }
      finally { choose.disabled = false; }
    };
  }
  function toolsPage() {
    const rows = tools.map(toolRow).join('')
      || '<p class="settings-copy">Tool detection is not available in this window.</p>';
    return `<section class="settings-page" data-page-panel="tools"><div class="settings-grid">
      <div data-workspace-host class="wide">${workspacesCard()}</div>
      <div class="settings-card wide"><h3>LOCAL TOOL CONNECTIONS</h3>${rows}
        <div class="setting-row" style="margin-top:14px;border-top:1px solid var(--border-100, rgba(0,0,0,.08));padding-top:12px">
          <label>Add a tool<small style="display:block;color:#61736e">A folder, an executable, or an endpoint. It joins the list above and is detected and tested the same way.</small></label>
          <input data-newtool="label" spellcheck="false" autocomplete="off" placeholder="Name — e.g. Hunyuan3D">
          <span style="display:flex;align-items:center;gap:7px;justify-self:end">
            <input data-newtool="target" spellcheck="false" autocomplete="off" placeholder="/path/to/it or http://127.0.0.1:PORT" style="min-width:260px">
            <button data-newtool-choose>Choose folder…</button>
            <button data-newtool-add>Add</button></span></div>
        <p class="settings-copy" style="margin-top:6px" data-newtool-note></p>
        <div class="cmux-controls" style="margin-top:12px"><button data-tools="detect">Re-detect</button><button data-tools="test">Test all connections</button></div>
        <p class="settings-copy" style="margin-top:9px" data-tools-note>Nothing has been checked yet.</p></div>
      <div class="settings-card wide"><h3>HOW THESE CONNECTIONS WORK</h3>
        <p class="settings-copy">BigKiji never bundles, copies or installs these tools. It remembers a path and nothing else, so the model weights, virtual environments and checkouts stay exactly where you already keep them and the app stays small. Emptying a field returns that row to automatic detection.</p>
        <p class="settings-copy" style="margin-top:8px"><b>Installed is not connected.</b> A row turns Connected only after a health check answered. A tool that is installed but not running stays Installed, and a check that has not run says “not checked”. BigKiji does not guess a status it has not measured.</p>
        <p class="settings-copy" style="margin-top:8px">The Obsidian vault is read only: BigKiji reads it and never writes into it or moves it. The GPU arbitration script belongs to your own workspace and is optional — without it BigKiji simply does not serialise GPU jobs, rather than pretending it can.</p></div>
    </div></section>`;
  }
  function toolsSummary() {
    const count = (status) => tools.filter((tool) => tool.status === status).length;
    return `Checked ${new Date().toLocaleTimeString()} · ${count('connected')} connected · ${count('found')} installed · ${count('missing')} not found.`;
  }
  function applyTool(update) {
    if (!update || !update.id || !root) return;
    const index = tools.findIndex((tool) => tool.id === update.id);
    const merged = index >= 0 ? Object.assign(tools[index], update) : update;
    const badge = root.querySelector(`[data-tool-status="${merged.id}"]`);
    if (badge) {
      badge.className = `connection ${badgeClass(merged)}`;
      badge.title = merged.detail || '';
      badge.innerHTML = `<i></i>${esc(badgeText(merged))}`;
    }
    const input = root.querySelector(`[data-tool-input="${merged.id}"]`);
    if (input) input.placeholder = toolPlaceholder(merged);
  }
  async function refreshTools() {
    try { (await window.bigkiji.toolsDetect()).forEach((tool) => applyTool({ ...tool, checking: false })); }
    catch (_) { /* detection is best-effort; the rows keep their last honest state */ }
  }
  async function testTool(id) {
    applyTool({ id, checking: true });
    try { applyTool({ ...(await window.bigkiji.toolsProbe(id)), checking: false }); }
    catch (error) { applyTool({ id, checking: false, detail: `Check could not run: ${error.message}` }); }
  }
  async function testAllTools() {
    const note = root.querySelector('[data-tools-note]');
    tools.forEach((tool) => { if (tool.probe) applyTool({ id: tool.id, checking: true }); });
    if (note) note.textContent = 'Checking every connection…';
    try {
      (await window.bigkiji.toolsProbeAll()).forEach((tool) => applyTool({ ...tool, checking: false }));
      toolsProbed = true;
      if (note) note.textContent = toolsSummary();
    } catch (error) {
      tools.forEach((tool) => applyTool({ id: tool.id, checking: false }));
      if (note) note.textContent = `Connection check could not run: ${error.message}`;
    }
  }
  // Detection reads the stored value and saving is debounced, so wait out the debounce
  // before re-detecting — otherwise the row would report on the previous path.
  async function afterToolPathChange(id) {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await refreshTools();
    const tool = tools.find((row) => row.id === id);
    if (tool && tool.probe) await testTool(id);
  }
  // Probes are deliberately not part of opening Settings: they run once the owner looks
  // at this tab, so a sleeping port can never delay the modal.
  function ensureToolProbes() { if (!toolsProbed && tools.length) testAllTools(); }
  function render() {
    const sfx = { ui: 0.5, alert: 0.6, ambient: 0.3, ...(state.audio.sfx || {}) };
    const renderPriority = state.appearance.renderPriority || 'auto';
    root = document.createElement('div'); root.className = 'settings-shell'; root.id = 'settingsModal'; root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `<div class="settings-deck" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
      <div class="settings-head"><span class="sigil"><i></i></span><div class="settings-title"><b id="settingsTitle">BIGKIJI SETTINGS</b><span>Voice, specialist routing, quality and local workspace</span></div><button class="settings-close" aria-label="Close settings">×</button></div>
      <nav class="settings-tabs"><button class="on" data-page="audio">Audio</button><button data-page="models">AI & Routing</button><button data-page="security">Security</button><button data-page="quality">Quality & Repair</button><button data-page="preview">Preview</button><button data-page="mobile">Mobile</button><button data-page="cmux">Terminal & cmux</button><button data-page="tools">Environment</button></nav>
      <div class="settings-body">
        <section class="settings-page on" data-page-panel="audio">
          <div class="sla-strip"><b>FIRST SPEECH SLA</b><i></i><span>meaningful answer ≤ ${Math.round(state.audio.firstSpeechDeadlineMs / 1000)}s</span></div>
          <div class="voice-rails">${rail('audio.ownerVolume', 'OWNER / PRIMARY', '#00f3ff', state.audio.ownerVolume)}${rail('audio.agentVolume', 'AGENT / BACKGROUND', '#a78bfa', state.audio.agentVolume)}</div>
          <div class="settings-grid">
            <div class="settings-card"><h3>ATTENTION & PACING</h3>
              <div class="setting-row"><label>Attention chime</label><input data-setting="audio.attentionChime" type="checkbox" ${state.audio.attentionChime ? 'checked' : ''}><span></span></div>
              <div class="setting-row"><label>Vintage telephone filter</label><input data-setting="audio.telephonyEnabled" type="checkbox" ${state.audio.telephonyEnabled ? 'checked' : ''}><span>300–3,400 Hz</span></div>
              <div class="setting-row"><label>Handset pickup cue</label><input data-setting="audio.handsetCue" type="checkbox" ${state.audio.handsetCue ? 'checked' : ''}><span></span></div>
              <div class="setting-row"><label>Chime tone</label><select data-setting="audio.chimeTone"><option>arrival</option><option>soft</option><option>pulse</option></select><span></span></div>
              <div class="setting-row"><label>English speed</label><input data-setting="audio.ownerSpeedEnglish" type="range" min="0.85" max="1.4" step="0.01" value="${state.audio.ownerSpeedEnglish}"><output>${state.audio.ownerSpeedEnglish.toFixed(2)}×</output></div>
              <div class="setting-row"><label>Japanese speed</label><input data-setting="audio.ownerSpeedJapanese" type="range" min="0.85" max="1.4" step="0.01" value="${state.audio.ownerSpeedJapanese}"><output>${state.audio.ownerSpeedJapanese.toFixed(2)}×</output></div>
              <div class="setting-row"><label>Pause naturalness</label><input data-setting="audio.pauseNaturalness" type="range" min="0" max="1" step="0.01" value="${state.audio.pauseNaturalness}"><output>${Math.round(state.audio.pauseNaturalness * 100)}%</output></div>
            </div>
            <div class="settings-card"><h3>VOICE PERSONALITIES · DEFAULT ENGLISH</h3>${profileRow('claude')}${profileRow('codex')}${profileRow('glm')}${profileRow('pi')}${profileRow('gemini')}</div>
            <div class="settings-card wide"><h3>SOUND EFFECTS</h3>
              <div class="setting-row"><label>Enable sound effects</label><input data-setting="audio.sfxEnabled" type="checkbox" ${state.audio.sfxEnabled !== false ? 'checked' : ''}><span>Interface · alert · ambient buses</span></div>
              <div class="voice-rails" style="grid-template-columns:repeat(3,minmax(0,1fr));margin:11px 0 0">${rail('audio.sfx.ui', 'INTERFACE', '#5eead4', sfx.ui)}${rail('audio.sfx.alert', 'ALERT', '#fbbf24', sfx.alert)}${rail('audio.sfx.ambient', 'AMBIENT', '#818cf8', sfx.ambient)}</div>
              <p class="settings-copy">Each bus is an independent gain stage feeding the shared playback analyser. Effect samples arrive with the next update; until then these levels are stored and applied silently.</p>
            </div>
            <div class="settings-card wide"><h3>LOCAL NEURAL ENGINE</h3><div class="setting-row"><label>Qwen3-TTS endpoint</label><input data-setting="audio.ttsEndpoint" value="${esc(state.audio.ttsEndpoint)}"><span id="ttsStatus" class="connection"><i></i>Checking</span></div><div class="setting-row"><label>Model</label><select data-setting="audio.ttsModel"><option value="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice">0.6B · Fast balanced</option><option value="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" ${state.audio.ttsModel.includes('1.7B') ? 'selected' : ''}>1.7B · High quality</option></select><span></span></div></div>
          </div>
        </section>
        <section class="settings-page" data-page-panel="models"><div class="settings-grid"><div class="settings-card wide"><h3>PIAGENT IDENTITY</h3><div class="setting-row"><label>PiAgent name</label><input data-setting="piAgent.displayName" maxlength="${PI_AGENT_NAME_MAX}" placeholder="${PI_AGENT_NAME_FALLBACK}" value="${esc(piAgentName())}"><span>Now: <b data-piagent-name>${esc(piAgentName())}</b></span></div><p class="settings-copy">Your PiAgent answers to this name across the fleet HUD, the voice profile list and the security log. Up to ${PI_AGENT_NAME_MAX} characters; leaving it blank restores “${PI_AGENT_NAME_FALLBACK}”.</p></div><div class="settings-card wide"><h3>AUTHORIZED PAID MODELS · OS ENCRYPTED STORAGE</h3>${Object.entries(providerLabels).map(([id,label]) => `<div class="setting-row"><label>${label}</label><input data-secret="${id}" type="password" autocomplete="off" placeholder="Leave blank to keep saved credential"><span class="connection" data-secret-status="${id}"><i></i>Not saved</span></div>`).join('')}</div><div class="settings-card"><h3>EXECUTION</h3><div class="setting-row"><label>Default mode</label><select data-setting="routing.executionMode"><option value="ask" ${state.routing.executionMode === 'ask' ? 'selected' : ''}>Ask · questions on screen</option><option value="plan" ${state.routing.executionMode === 'plan' ? 'selected' : ''}>Plan</option><option value="auto" ${state.routing.executionMode === 'auto' ? 'selected' : ''}>Auto-plan · approval required</option><option value="demo" ${state.routing.executionMode === 'demo' ? 'selected' : ''}>Demo · hands-off, nothing waits</option></select><span></span></div><div class="setting-row"><label>Maximum active models</label><input data-setting="routing.maxAgents" type="range" min="1" max="5" step="1" value="${state.routing.maxAgents}"><output>${state.routing.maxAgents}</output></div><div class="setting-row"><label>Deliberation before work</label><select data-setting="routing.deliberationLenses"><option value="2" ${Number(state.routing.deliberationLenses ?? 2) === 2 ? 'selected' : ''}>2 independent lenses</option><option value="3" ${Number(state.routing.deliberationLenses) === 3 ? 'selected' : ''}>3 independent lenses</option><option value="0" ${Number(state.routing.deliberationLenses) === 0 ? 'selected' : ''}>Off · go straight to work</option></select><span>Read-only · still approved</span></div><div class="setting-row"><label>Activation</label><b class="connection ok"><i></i>PiAgent on demand</b><span></span></div><div class="setting-row"><label>Session leader</label><select data-setting="routing.sessionLeader"><option value="auto" ${!state.routing.sessionLeader || state.routing.sessionLeader === 'auto' ? 'selected' : ''}>Auto · Lead-Pi on the best measured provider</option><option value="claude-code" ${state.routing.sessionLeader === 'claude-code' ? 'selected' : ''}>Claude Code</option><option value="codex" ${state.routing.sessionLeader === 'codex' ? 'selected' : ''}>Codex</option><option value="gemini" ${state.routing.sessionLeader === 'gemini' ? 'selected' : ''}>Gemini</option><option value="glm" ${state.routing.sessionLeader === 'glm' ? 'selected' : ''}>GLM</option></select><span></span></div></div><div class="settings-card"><h3>NATURAL CONVERSATION</h3><div class="setting-row"><label>Local chat model</label><input data-setting="conversation.model" value="${esc(state.conversation.model)}"><span>Ollama</span></div><div class="setting-row"><label>Sliding context</label><input data-setting="conversation.contextTokens" type="range" min="1024" max="8192" step="512" value="${state.conversation.contextTokens}"><output>${state.conversation.contextTokens}</output></div><div class="setting-row"><label>Save ideas locally</label><input data-setting="conversation.autoIdeas" type="checkbox" ${state.conversation.autoIdeas ? 'checked' : ''}><span>~/.bigkiji/ideas</span></div><div class="setting-row"><label>Cloud polish</label><b>Approval every time</b><span></span></div></div><div class="settings-card wide"><h3>LOCAL MODEL TIERS · FIXED BY THE ROUTER</h3><div class="setting-row"><label>Resident chat tier</label><b>qwen3.5:latest</b><span>keep-alive · natural conversation</span></div><div class="setting-row"><label>Fast acknowledgement</label><b>qwen2.5:0.5b</b><span>keep-alive · instant, not conversational</span></div><div class="setting-row"><label>On-demand thinking tier</label><b>qwen3.5:35b-a3b</b><span>started per assignment, then released</span></div><p class="settings-copy">The two local tiers are defined by the router in src/domain/pi-agent/model-router.js and are not owner-configurable. The editable local chat model above is the one used for natural conversation.</p></div><div class="settings-card"><h3>BUDGET POLICY</h3><p class="settings-copy">Paid allowlist: Claude Code · Codex · Gemini · GLM.<br>Models stay closed until PiAgent assigns a necessary role, then exit after completion. Every mutation-capable run waits for Owner approval on desktop or a paired phone.</p></div><div class="settings-card wide"><h3>PORTABLE DATA PATHS · RESTART TO APPLY</h3><div class="setting-row"><label>BigKiji Vault</label><input data-setting="paths.vaultRoot" placeholder="~/Documents/BigKiji" value="${esc(state.paths?.vaultRoot || '')}"><span></span></div><div class="setting-row"><label>Knowledge cache</label><input data-setting="paths.knowledgeRoot" placeholder="OS app data" value="${esc(state.paths?.knowledgeRoot || '')}"><span></span></div><div class="setting-row"><label>Graphify graph.json</label><input data-setting="paths.graphifyGraphPath" placeholder="Vault/graphify-out/graph.json" value="${esc(state.paths?.graphifyGraphPath || '')}"><span></span></div></div></div></section>
        <section class="settings-page" data-page-panel="security"><div class="settings-grid security-grid">
          <div class="settings-card security-posture"><h3>EGRESS POSTURE</h3><div class="security-seal"><span>◈</span><div><b id="securityState">Checking</b><small>Fail-closed direct sandbox</small></div></div><div class="setting-row"><label>Model web search</label><b>Broker only</b><span></span></div><div class="setting-row"><label>Child environment</label><b>Minimal</b><span></span></div><div class="setting-row"><label>Owner approval</label><b>Plan + disclosure hash</b><span></span></div></div>
          <div class="settings-card"><h3>SESSION COUNTERS</h3><div class="security-counts"><div><b id="securityManifests">0</b><span>sealed disclosures</span></div><div><b id="securityBlocked">0</b><span>blocked actions</span></div></div><p class="settings-copy">A changed file, policy or provider invalidates the current approval before execution.</p></div>
          <div class="settings-card wide"><h3>RECENT SECURITY DECISIONS</h3><div id="securityRecent" class="security-recent"><p class="settings-copy">No blocked actions in this daemon session.</p></div></div>
          <div class="settings-card wide"><h3>GUARANTEE BOUNDARY</h3><p class="settings-copy">BigKiji blocks sensitive paths, strips credentials and PII, disables model-native web tools, and launches providers with isolated configuration. If a required hook or sandbox cannot be verified, the external model is not started. OS or provider vulnerabilities are reported as a degraded posture rather than hidden.</p><code id="securityPolicyHash"></code></div>
        </div></section>
        <section class="settings-page" data-page-panel="quality"><div class="settings-grid"><div class="settings-card"><h3>QUALITY GATE</h3><div class="setting-row"><label>Verification</label><select data-setting="quality.gate"><option value="strict" ${state.quality.gate === 'strict' ? 'selected' : ''}>Strict</option><option value="standard" ${state.quality.gate === 'standard' ? 'selected' : ''}>Standard</option></select><span></span></div><div class="setting-row"><label>Maker / Checker</label><input type="checkbox" checked disabled><span>Required</span></div></div><div class="settings-card"><h3>SELF REPAIR</h3><div class="setting-row"><label>Maximum cycles</label><input data-setting="quality.maxRepairCycles" type="range" min="0" max="5" step="1" value="${state.quality.maxRepairCycles}"><output>${state.quality.maxRepairCycles}</output></div></div><div class="settings-card wide"><h3>RESEARCH & LEARNING</h3><p class="settings-copy">Learning records performance and role fit only. Secrets and internal reasoning are never stored.</p></div></div></section>
        <section class="settings-page" data-page-panel="preview"><div class="settings-grid"><div class="settings-card"><h3>LIVE WORKSPACE</h3><div class="setting-row"><label>Enable preview</label><input data-setting="preview.enabled" type="checkbox" ${state.preview.enabled ? 'checked' : ''}><span></span></div><div class="setting-row"><label>Preferred port</label><input data-setting="preview.preferredPort" type="number" min="1024" max="65500" value="${state.preview.preferredPort}"><span>localhost</span></div><div class="setting-row"><label>Live reload</label><input data-setting="preview.liveReload" type="checkbox" ${state.preview.liveReload ? 'checked' : ''}><span></span></div><div class="setting-row"><label>Default viewport</label><select data-setting="preview.viewport"><option value="desktop">Desktop</option><option value="tablet" ${state.preview.viewport === 'tablet' ? 'selected' : ''}>Tablet</option><option value="mobile" ${state.preview.viewport === 'mobile' ? 'selected' : ''}>Mobile</option></select><span></span></div></div><div class="settings-card"><h3>APPEARANCE</h3><div class="setting-row"><label>Theme</label><select data-setting="appearance.theme"><option value="paper" ${(state.appearance.theme || "paper") === "paper" ? "selected" : ""}>Paper · quiet, like a notebook</option><option value="studio" ${state.appearance.theme === "studio" ? "selected" : ""}>Quiet Studio · the 3D scene</option></select><span>Light or dark is the row below</span></div><div class="setting-row"><label>Color scheme</label><select data-setting="appearance.colorScheme"><option value="auto" ${(state.appearance.colorScheme || "auto") === "auto" ? "selected" : ""}>Auto · follows the system</option><option value="light" ${state.appearance.colorScheme === "light" ? "selected" : ""}>Light</option><option value="dark" ${state.appearance.colorScheme === "dark" ? "selected" : ""}>Dark</option></select><span>Windows and terminals</span></div><div class="setting-row"><label>Render priority</label><select data-setting="appearance.renderPriority"><option value="auto" ${renderPriority === 'auto' ? 'selected' : ''}>Auto · follows frame rate</option><option value="performance" ${renderPriority === 'performance' ? 'selected' : ''}>Performance first</option><option value="graphics" ${renderPriority === 'graphics' ? 'selected' : ''}>Graphics first</option></select><span>Live</span></div><div class="setting-row"><label>Text scale</label><input data-setting="appearance.textScale" type="range" min="0.85" max="1.25" step="0.05" value="${state.appearance.textScale}"><output>${state.appearance.textScale.toFixed(2)}×</output></div><div class="setting-row"><label>Reduced glow</label><input data-setting="appearance.reducedGlow" type="checkbox" ${state.appearance.reducedGlow ? 'checked' : ''}><span></span></div><div class="setting-row"><label>Reduce motion</label><input data-setting="appearance.reduceMotion" type="checkbox" ${state.appearance.reduceMotion ? 'checked' : ''}><span></span></div></div><div class="settings-card wide"><h3>TERMINAL</h3><div class="setting-row"><label>BigKiji session</label><input type="checkbox" checked disabled><span>Pinned</span></div><p class="settings-copy">Use the + button in the terminal tab row. Added cmux terminals can be renamed, colored, split or closed; the BigKiji session remains pinned.</p></div></div></section>
        <section class="settings-page" data-page-panel="mobile"><div class="mobile-connect-layout">
          <div class="settings-card mobile-ticket"><div><h3>OWNER PHONE PAIRING</h3><h2>Carry the approval desk.</h2><p>BigKiji sends compact state only. The phone renders its own 3D universe and can accept, edit, reject or stop the current run.</p><div id="mobileState" class="mobile-state"><i></i><span>Checking Mac, daemon and Tailscale…</span></div><div class="mobile-actions"><button data-mobile="pair">Create 5-minute QR</button><button data-mobile="refresh">Check connection</button><button data-mobile="copy" disabled>Copy link</button><button data-mobile="open" disabled>Open here</button></div><code id="mobileURL"></code></div><div class="mobile-qr-wrap"><img id="mobileQR" alt="One-time BigKiji mobile pairing QR code"><span id="mobileQRHint">Generate a one-time pairing ticket</span></div></div>
          <div class="settings-card mobile-steps"><h3>SETUP · SAME TAILNET REQUIRED</h3><ol><li><b>1</b><span>Install Tailscale on this Mac and your iPhone or Android device.</span></li><li><b>2</b><span>Sign in to the same tailnet. BigKiji enables a private HTTPS route—never a public port.</span></li><li><b>3</b><span>Scan the QR, pair the device, then add BigKiji Universe Mobile to the Home Screen.</span></li></ol><div id="mobileSetupLink"></div></div>
          <div class="settings-card mobile-devices"><h3>PAIRED OWNER DEVICES</h3><div id="mobileDeviceList"><p class="settings-copy">No paired device data loaded.</p></div><div class="mobile-actions"><button data-mobile="revoke-all" class="quiet-danger">Revoke all phones</button></div></div>
          <div class="settings-card mobile-note"><h3>MOBILE AUTHORITY</h3><p class="settings-copy">A paired phone may send directives and approve only the exact current revision, plan hash and disclosure hash. Changed or already-processed plans are rejected. Code mutation still never starts without an explicit Owner action.</p></div>
        </div></section>
        <section class="settings-page" data-page-panel="cmux"><div class="settings-grid"><div class="settings-card wide"><h3>CMUX CONTROL PLANE · MACOS EXTENSION</h3><div class="setting-row"><label>CLI</label><input data-setting="cmux.cliPath" value="${esc(state.cmux.cliPath)}"><span id="cmuxStatus" class="connection"><i></i>Checking</span></div><div class="setting-row"><label>Socket password</label><input data-secret="cmux" type="password" autocomplete="off" placeholder="OS encrypted storage"><span class="connection" data-secret-status="cmux"><i></i>Not saved</span></div><div class="setting-row"><label>Theme</label><select id="cmuxTheme"><option value="">Load themes…</option></select><button data-cmux="theme">Apply</button></div><div class="setting-row"><label>Workspace</label><select id="cmuxWorkspace"><option value="">Current workspace</option></select><select id="cmuxColor"><option>Aqua</option><option>Green</option><option>Amber</option><option>Indigo</option><option>Purple</option><option>Rose</option><option>Charcoal</option></select></div><div class="cmux-controls"><button data-cmux="color">Set color</button><button data-cmux="terminal">New terminal</button><button data-cmux="split">Split right</button><button data-cmux="workspace">New workspace</button><button data-cmux="palette">All commands</button><button data-cmux="native">Open native</button></div></div><div class="settings-card wide"><h3>SAFETY</h3><div class="setting-row"><label>Confirm destructive commands</label><input type="checkbox" checked disabled><span>Required</span></div><p style="font-size:10px;line-height:1.55;color:#78938a">All cmux commands are available through the Operations Index. Commands run as argv without a shell. Close, remove, logout, hook and VM deletion operations show their exact target before execution.</p></div></div></section>
        ${toolsPage()}
      </div></div>`;
    document.body.appendChild(root); bind(); refreshStatus();
  }
  function bind() {
    root.querySelector('.settings-close').onclick = close;
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    root.querySelectorAll('[data-page]').forEach((button) => button.onclick = () => {
      root.querySelectorAll('[data-page]').forEach((b) => b.classList.toggle('on', b === button));
      root.querySelectorAll('[data-page-panel]').forEach((p) => p.classList.toggle('on', p.dataset.pagePanel === button.dataset.page));
      if (button.dataset.page === 'tools') ensureToolProbes();
    });
    root.querySelectorAll('[data-setting]').forEach((input) => input.addEventListener('input', () => {
      const key = input.dataset.setting;
      const value = input.type === 'checkbox' ? input.checked : (input.type === 'range' || input.type === 'number' ? Number(input.value) : input.value);
      set(state, key, value);
      const rail = input.closest('.voice-rail'); if (rail) { rail.style.setProperty('--level', pct(value)); rail.querySelector('strong').textContent = pct(value); }
      const output = input.parentElement.querySelector('output'); if (output) output.textContent = formatOutput(key, value);
      if (key === 'piAgent.displayName') applyPiAgentName(value);
      scheduleSave();
    }));
    root.querySelectorAll('[data-preview]').forEach((button) => button.onclick = () => window.bigkiji.ttsPreview({ agent: button.dataset.preview, text: button.dataset.preview === 'pi' ? 'Systems are synchronized. I am ready for the next operation.' : 'BigKiji Universe is ready. This is my English voice profile.' }));
    root.querySelectorAll('[data-secret]').forEach((input) => input.addEventListener('change', async () => { if (input.value) { await window.bigkiji.settingsSecret(input.dataset.secret, input.value); input.value = ''; refreshStatus(); } }));
    // The path field itself already saves through the shared [data-setting] listener;
    // `change` (blur or Enter, never per keystroke) is where re-detection belongs.
    root.querySelectorAll('[data-tool-input]').forEach((input) => input.addEventListener('change', () => afterToolPathChange(input.dataset.toolInput)));
    root.querySelectorAll('[data-tool-choose]').forEach((button) => button.onclick = async () => {
      const id = button.dataset.toolChoose;
      const tool = tools.find((row) => row.id === id);
      if (!tool) return;
      button.disabled = true;
      try {
        const chosen = await window.bigkiji.toolsChoose(id);
        if (!chosen) return;
        set(state, `paths.${tool.settingKey}`, chosen);
        syncControls(); // the same key can be shown on two tabs
        scheduleSave();
        await afterToolPathChange(id);
      } catch (error) { applyTool({ id, checking: false, detail: `Could not open the chooser: ${error.message}` }); }
      finally { button.disabled = false; }
    });
    root.querySelectorAll('[data-tool-test]').forEach((button) => button.onclick = () => testTool(button.dataset.toolTest));
    // ---- tools the owner adds themselves ------------------------------------
    // The id is derived from the name rather than asked for. A second field the owner
    // has to invent, whose only job is to be unique and URL-safe, is a field they will
    // get wrong; the store normalises it anyway and refuses anything unsafe.
    const newToolNote = (text) => { const note = root.querySelector('[data-newtool-note]'); if (note) note.textContent = text || ''; };
    const newToolField = (name) => root.querySelector(`[data-newtool="${name}"]`);
    root.querySelectorAll('[data-newtool-choose]').forEach((button) => button.onclick = async () => {
      button.disabled = true;
      try {
        const chosen = await window.bigkiji.toolsChoose('');
        if (chosen) newToolField('target').value = chosen;
      } catch (error) { newToolNote(`Could not open the chooser: ${error.message}`); }
      finally { button.disabled = false; }
    });
    root.querySelectorAll('[data-newtool-add]').forEach((button) => button.onclick = async () => {
      const label = String(newToolField('label')?.value || '').trim();
      const target = String(newToolField('target')?.value || '').trim();
      if (!label || !target) { newToolNote('A name and a location are both needed.'); return; }
      const endpoint = /^https?:\/\//i.test(target);
      const id = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      if (!id) { newToolNote('That name has no letters or digits in it, so there is nothing to key it by.'); return; }
      const existing = Array.isArray(get(state, 'paths.customTools')) ? get(state, 'paths.customTools') : [];
      if (existing.some((entry) => entry && entry.id === id) || tools.some((tool) => tool.id === id)) {
        newToolNote(`${label} is already connected — edit its row above instead.`); return;
      }
      set(state, 'paths.customTools', [...existing,
        { id, label, kind: endpoint ? 'http' : 'directory', path: endpoint ? '' : target, url: endpoint ? target : '' }]);
      scheduleSave();
      newToolField('label').value = ''; newToolField('target').value = '';
      newToolNote(`${label} added. Detecting…`);
      await refreshTools();
    });
    root.querySelectorAll('[data-tool-remove]').forEach((button) => button.onclick = async () => {
      const id = button.dataset.toolRemove;
      const existing = Array.isArray(get(state, 'paths.customTools')) ? get(state, 'paths.customTools') : [];
      set(state, 'paths.customTools', existing.filter((entry) => entry && entry.id !== id));
      scheduleSave();
      await refreshTools();
    });
    bindWorkspaces();
    root.querySelectorAll('[data-tools]').forEach((button) => button.onclick = () => {
      if (button.dataset.tools === 'detect') refreshTools();
      if (button.dataset.tools === 'test') testAllTools();
    });
    root.querySelectorAll('[data-cmux]').forEach((button) => button.onclick = async () => {
      const a = button.dataset.cmux;
      if (a === 'refresh') await window.bigkiji.cmuxRefresh();
      if (a === 'terminal') await window.bigkiji.cmuxAction('new-terminal', {});
      if (a === 'split') await window.bigkiji.cmuxAction('split', { direction: 'right' });
      if (a === 'workspace') await window.bigkiji.cmuxAction('new-workspace', { name: 'BigKiji Task' });
      if (a === 'theme') await window.bigkiji.cmuxAction('theme-set', { theme: root.querySelector('#cmuxTheme').value });
      if (a === 'color') await window.bigkiji.cmuxAction('workspace-color', { workspace: root.querySelector('#cmuxWorkspace').value, color: root.querySelector('#cmuxColor').value });
      if (a === 'palette') { close(); document.querySelector('[data-cmux-palette]')?.click(); }
      if (a === 'native') await window.bigkiji.cmuxOpenNative();
      refreshStatus();
    });
    root.querySelectorAll('[data-mobile]').forEach((button) => button.onclick = async () => {
      const action = button.dataset.mobile; button.disabled = true;
      try {
        if (action === 'pair') renderMobile(await window.bigkiji.remoteAccess({ ensure: true, action: 'pair' }));
        else if (action === 'refresh') await refreshMobile();
        else if (action === 'copy') await navigator.clipboard.writeText(root.querySelector('#mobileURL').textContent || '');
        else if (action === 'open') await window.bigkiji.openExternal(root.querySelector('#mobileURL').textContent || '');
        else if (action === 'revoke-all') { if (confirm('Revoke every paired Owner phone?')) renderMobile(await window.bigkiji.remoteAccess({ action: 'revoke' })); }
        else if (action === 'revoke') renderMobile(await window.bigkiji.remoteAccess({ action: 'revoke', deviceId: button.dataset.deviceId }));
      } catch (error) { renderMobile({ state: 'error', ready: false, requirement: error.message }); }
      finally { button.disabled = false; }
    });
  }
  async function refreshStatus() {
    const [secrets, tts, cmux, security] = await Promise.all([window.bigkiji.settingsSecretStatus(), window.bigkiji.ttsStatus(), window.bigkiji.cmuxSnapshot(), window.bigkiji.securitySnapshot()]);
    root.querySelectorAll('[data-secret-status]').forEach((el) => { const ok = !!secrets[el.dataset.secretStatus]; el.classList.toggle('ok', ok); el.innerHTML = `<i></i>${ok ? 'Keychain saved' : 'Not saved'}`; });
    const ts = root.querySelector('#ttsStatus'); ts.className = `connection ${tts.ready ? 'ok' : (tts.state === 'loading' ? '' : 'bad')}`; ts.innerHTML = `<i></i>${esc(tts.state)} · ${esc(tts.engine)}`;
    const cs = root.querySelector('#cmuxStatus'); cs.className = `connection ${cmux.connected ? 'ok' : 'bad'}`; cs.innerHTML = `<i></i>${cmux.connected ? `${cmux.surfaces?.length || 0} surfaces` : 'Offline'}`;
    if (cmux.connected) {
      const themeResult = await window.bigkiji.cmuxAction('theme-list', {}).catch(() => ({ themes: [] }));
      const theme = root.querySelector('#cmuxTheme'); if (theme) theme.innerHTML = (themeResult.themes || []).map((row) => `<option ${row.current ? 'selected' : ''}>${esc(row.name)}</option>`).join('');
      const workspace = root.querySelector('#cmuxWorkspace'); if (workspace) workspace.innerHTML = (cmux.workspaces || []).map((row) => `<option value="${esc(row.ref || row.id)}">${esc(row.title || row.ref || row.id)}</option>`).join('') || '<option value="">Current workspace</option>';
    }
    renderSecurity(security);
    refreshMobile();
  }
  function renderSecurity(security = {}) {
    const status = root.querySelector('#securityState'); if (!status) return;
    status.textContent = security.status || 'DEGRADED'; status.className = security.status === 'ENFORCED' ? 'ok' : 'bad';
    root.querySelector('#securityManifests').textContent = String(security.manifests || 0);
    root.querySelector('#securityBlocked').textContent = String(security.blocked || 0);
    root.querySelector('#securityPolicyHash').textContent = security.policyHash ? `policy ${security.policyHash.slice(0, 24)}` : 'policy hash appears after the first sealed plan';
    const recent = security.recent || []; root.querySelector('#securityRecent').innerHTML = recent.length ? recent.map((item) =>
      `<div class="security-row"><time>${esc(new Date(item.at).toLocaleTimeString())}</time><b>${esc(item.decision)}</b><span>${esc(item.provider || piAgentName())}</span><em>${esc(item.reason || 'Disclosure sealed')}</em></div>`).join('') : '<p class="settings-copy">No blocked actions in this daemon session.</p>';
  }
  async function refreshMobile() {
    const [access, devices] = await Promise.all([
      window.bigkiji.remoteAccess({ action: 'status' }).catch((error) => ({ state: 'error', requirement: error.message })),
      window.bigkiji.remoteAccess({ action: 'devices' }).catch(() => ({ devices: [] })),
    ]);
    renderMobile({ ...access, devices: devices.devices || access.devices || [] });
  }
  function renderMobile(access = {}) {
    const stateEl = root.querySelector('#mobileState'); if (!stateEl) return;
    stateEl.className = `mobile-state ${access.ready ? 'ok' : access.state === 'error' || access.state === 'offline' ? 'bad' : ''}`;
    stateEl.innerHTML = `<i></i><span>${esc(access.requirement || (access.ready ? 'Private mobile route is ready.' : 'Tailscale setup is required.'))}</span>`;
    const qr = root.querySelector('#mobileQR'); qr.classList.toggle('on', !!access.qrDataUrl); if (access.qrDataUrl) qr.src = access.qrDataUrl;
    root.querySelector('#mobileQRHint').textContent = access.pairingExpiresAt ? `Valid until ${new Date(access.pairingExpiresAt).toLocaleTimeString()}` : 'Generate a one-time pairing ticket';
    const url = root.querySelector('#mobileURL'); if (access.url) url.textContent = access.url;
    root.querySelector('[data-mobile="copy"]').disabled = !url.textContent; root.querySelector('[data-mobile="open"]').disabled = !url.textContent;
    const setup = root.querySelector('#mobileSetupLink'); setup.innerHTML = access.setupUrl ? `<button data-setup-url="${esc(access.setupUrl)}">Approve Tailscale Serve</button>` : '';
    setup.querySelector('button')?.addEventListener('click', () => window.bigkiji.openExternal(access.setupUrl));
    const devices = access.devices || []; root.querySelector('#mobileDeviceList').innerHTML = devices.length ? devices.map((device) => `<div class="mobile-device ${device.revokedAt ? 'revoked' : ''}"><span><b>${esc(device.name)}</b><small>${device.revokedAt ? 'Revoked' : `Last active ${new Date(device.lastActiveAt).toLocaleString()}`}</small></span>${device.revokedAt ? '' : `<button data-mobile="revoke" data-device-id="${esc(device.id)}">Revoke</button>`}</div>`).join('') : '<p class="settings-copy">No paired Owner phones.</p>';
    root.querySelectorAll('#mobileDeviceList [data-mobile="revoke"]').forEach((button) => button.onclick = async () => renderMobile(await window.bigkiji.remoteAccess({ action: 'revoke', deviceId: button.dataset.deviceId })));
  }
  function open() { root.classList.add('on'); root.setAttribute('aria-hidden', 'false'); syncControls(); refreshStatus(); }
  function close() { root.classList.remove('on'); root.setAttribute('aria-hidden', 'true'); }
  window.BKSettings = {
    async init(button) {
      state = await window.bigkiji.settingsGet();
      // Detection is synchronous in the main process, so this costs milliseconds and lets
      // every tool row exist before bind() attaches the shared [data-setting] listeners.
      try { tools = await window.bigkiji.toolsDetect(); } catch (_) { tools = []; }
      // Both lists must exist before render(), so bind() can attach to rows that are
      // already in the DOM rather than to rows that appear a tick later.
      await refreshWorkspaces({ rerender: false });
      window.BKAudio?.apply(state.audio);
      document.documentElement.style.fontSize = `${state.appearance.textScale * 100}%`;
      document.body.classList.toggle('reduce-motion', !!state.appearance.reduceMotion);
      applyPiAgentName(piAgentName());
      render();
      button?.addEventListener('click', open);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === ',' && e.metaKey) { e.preventDefault(); open(); } });
      // The application menu's Settings item sends this. Only the console renderer was
      // listening (console-app/src/lib/ipc.js), so with the console retired the menu item
      // opened a window and then did nothing. It belongs here, where the modal is, rather
      // than in each window that hosts it.
      window.bigkiji.onOpenSettings?.(() => open());
      // Another window (or the tray) may change settings; keep this modal and the name in sync.
      window.bigkiji.onWorkspaceChanged?.((next) => {
        workspaces = next;
        const host = root?.querySelector('[data-workspace-host]');
        if (host) { host.innerHTML = workspacesCard(); bindWorkspaces(); }
      });
      window.bigkiji.onSettingsChanged?.((next) => {
        if (saveTimer) return; // a local edit is still debounced — never clobber it
        state = next;
        window.BKAudio?.apply(state.audio);
        applyPiAgentName(piAgentName());
        syncControls();
      });
    },
    open, close, piAgentName,
  };
})();
