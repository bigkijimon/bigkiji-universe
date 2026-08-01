'use strict';

(() => {
  const speakers = ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'];
  const providerLabels = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', glm: 'GLM' };
  let state = null; let root = null; let saveTimer = null;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const speakerOptions = (current) => speakers.map((v) => `<option ${v === current ? 'selected' : ''}>${v}</option>`).join('');
  function set(obj, path, value) { const keys = path.split('.'); let at = obj; keys.slice(0, -1).forEach((k) => { at[k] ||= {}; at = at[k]; }); at[keys.at(-1)] = value; }
  function scheduleSave() {
    clearTimeout(saveTimer); saveTimer = setTimeout(async () => {
      state = await window.bigkiji.settingsUpdate(state);
      window.BKAudio?.apply(state.audio);
      document.documentElement.style.fontSize = `${state.appearance.textScale * 100}%`;
      document.body.classList.toggle('reduce-motion', !!state.appearance.reduceMotion);
    }, 120);
  }
  function rail(name, label, color, value) {
    return `<div class="voice-rail" data-rail="${name}" style="--rail:${color};--level:${Math.round(value * 100)}%"><label>${label}<strong>${Math.round(value * 100)}%</strong></label><input data-setting="audio.${name}Volume" type="range" min="0" max="1" step="0.01" value="${value}"></div>`;
  }
  function profileRow(id) {
    const profile = state.audio.profiles[id];
    return `<div class="setting-row"><label>${providerLabels[id] || 'Pi-Agents'}<small style="display:block;color:#61736e">${esc(profile.label)}</small></label><select data-setting="audio.profiles.${id}.speaker">${speakerOptions(profile.speaker)}</select><button data-preview="${id}">🔊 Test</button></div>`;
  }
  function render() {
    root = document.createElement('div'); root.className = 'settings-shell'; root.id = 'settingsModal'; root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `<div class="settings-deck" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
      <div class="settings-head"><span class="sigil"><i></i></span><div class="settings-title"><b id="settingsTitle">BIGKIJI SETTINGS</b><span>Voice, specialist routing, quality and local workspace</span></div><button class="settings-close" aria-label="Close settings">×</button></div>
      <nav class="settings-tabs"><button class="on" data-page="audio">Audio</button><button data-page="models">AI & Routing</button><button data-page="quality">Quality & Repair</button><button data-page="preview">Preview</button><button data-page="mobile">Mobile</button><button data-page="cmux">Terminal & cmux</button></nav>
      <div class="settings-body">
        <section class="settings-page on" data-page-panel="audio">
          <div class="sla-strip"><b>FIRST SPEECH SLA</b><i></i><span>meaningful answer ≤ ${Math.round(state.audio.firstSpeechDeadlineMs / 1000)}s</span></div>
          <div class="voice-rails">${rail('owner', 'OWNER / PRIMARY', '#00f3ff', state.audio.ownerVolume)}${rail('agent', 'AGENT / BACKGROUND', '#a78bfa', state.audio.agentVolume)}</div>
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
            <div class="settings-card wide"><h3>LOCAL NEURAL ENGINE</h3><div class="setting-row"><label>Qwen3-TTS endpoint</label><input data-setting="audio.ttsEndpoint" value="${esc(state.audio.ttsEndpoint)}"><span id="ttsStatus" class="connection"><i></i>Checking</span></div><div class="setting-row"><label>Model</label><select data-setting="audio.ttsModel"><option value="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice">0.6B · Fast balanced</option><option value="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" ${state.audio.ttsModel.includes('1.7B') ? 'selected' : ''}>1.7B · High quality</option></select><span></span></div></div>
          </div>
        </section>
        <section class="settings-page" data-page-panel="models"><div class="settings-grid"><div class="settings-card wide"><h3>AUTHORIZED PAID MODELS · OS ENCRYPTED STORAGE</h3>${Object.entries(providerLabels).map(([id,label]) => `<div class="setting-row"><label>${label}</label><input data-secret="${id}" type="password" autocomplete="off" placeholder="Leave blank to keep saved credential"><span class="connection" data-secret-status="${id}"><i></i>Not saved</span></div>`).join('')}</div><div class="settings-card"><h3>EXECUTION</h3><div class="setting-row"><label>Default mode</label><select data-setting="routing.executionMode"><option value="plan" ${state.routing.executionMode === 'plan' ? 'selected' : ''}>Plan</option><option value="auto" ${state.routing.executionMode === 'auto' ? 'selected' : ''}>Auto-plan · approval required</option><option value="manual" ${state.routing.executionMode === 'manual' ? 'selected' : ''}>Manual</option></select><span></span></div><div class="setting-row"><label>Maximum active models</label><input data-setting="routing.maxAgents" type="range" min="1" max="5" step="1" value="${state.routing.maxAgents}"><output>${state.routing.maxAgents}</output></div><div class="setting-row"><label>Activation</label><b class="connection ok"><i></i>PiAgent on demand</b><span></span></div><div class="setting-row"><label>Session leader</label><select data-setting="routing.sessionLeader"><option value="auto">Auto · Claude first</option><option value="claude-code" ${state.routing.sessionLeader === 'claude-code' ? 'selected' : ''}>Claude Code</option><option value="codex" ${state.routing.sessionLeader === 'codex' ? 'selected' : ''}>Codex</option><option value="gemini" ${state.routing.sessionLeader === 'gemini' ? 'selected' : ''}>Gemini</option><option value="glm" ${state.routing.sessionLeader === 'glm' ? 'selected' : ''}>GLM</option></select><span></span></div><div class="setting-row"><label>Qwen bypass timeout</label><input data-setting="routing.qwenBypassTimeoutMs" type="number" min="250" max="5000" step="50" value="${state.routing.qwenBypassTimeoutMs}"><span>ms</span></div></div><div class="settings-card"><h3>BUDGET POLICY</h3><p class="settings-copy">Paid allowlist: Claude · Codex · Gemini · GLM.<br>Models stay closed until PiAgent assigns a necessary role, then exit after completion. Every mutation-capable run waits for Owner approval on desktop or a paired phone.</p></div><div class="settings-card wide"><h3>PORTABLE DATA PATHS · RESTART TO APPLY</h3><div class="setting-row"><label>BigKiji Vault</label><input data-setting="paths.vaultRoot" placeholder="~/Documents/BigKiji" value="${esc(state.paths?.vaultRoot || '')}"><span></span></div><div class="setting-row"><label>Knowledge cache</label><input data-setting="paths.knowledgeRoot" placeholder="OS app data" value="${esc(state.paths?.knowledgeRoot || '')}"><span></span></div><div class="setting-row"><label>Graphify graph.json</label><input data-setting="paths.graphifyGraphPath" placeholder="Vault/graphify-out/graph.json" value="${esc(state.paths?.graphifyGraphPath || '')}"><span></span></div></div></div></section>
        <section class="settings-page" data-page-panel="quality"><div class="settings-grid"><div class="settings-card"><h3>QUALITY GATE</h3><div class="setting-row"><label>Verification</label><select data-setting="quality.gate"><option value="strict" ${state.quality.gate === 'strict' ? 'selected' : ''}>Strict</option><option value="standard" ${state.quality.gate === 'standard' ? 'selected' : ''}>Standard</option></select><span></span></div><div class="setting-row"><label>Maker / Checker</label><input type="checkbox" checked disabled><span>Required</span></div><div class="setting-row"><label>Test timeout</label><input data-setting="quality.testTimeoutMs" type="number" min="30000" max="900000" step="10000" value="${state.quality.testTimeoutMs}"><span>ms</span></div></div><div class="settings-card"><h3>SELF REPAIR</h3><div class="setting-row"><label>Repair scope</label><select data-setting="quality.repairScope"><option value="broad" ${state.quality.repairScope === 'broad' ? 'selected' : ''}>Broad</option><option value="low" ${state.quality.repairScope === 'low' ? 'selected' : ''}>Low risk</option><option value="off" ${state.quality.repairScope === 'off' ? 'selected' : ''}>Off</option></select><span></span></div><div class="setting-row"><label>Maximum cycles</label><input data-setting="quality.maxRepairCycles" type="range" min="0" max="5" step="1" value="${state.quality.maxRepairCycles}"><output>${state.quality.maxRepairCycles}</output></div><div class="setting-row"><label>Rollback regression</label><input data-setting="quality.rollbackOnRegression" type="checkbox" ${state.quality.rollbackOnRegression ? 'checked' : ''}><span></span></div><div class="setting-row"><label>Smoke after restart</label><input data-setting="quality.smokeAfterRestart" type="checkbox" ${state.quality.smokeAfterRestart ? 'checked' : ''}><span></span></div></div><div class="settings-card wide"><h3>RESEARCH & LEARNING</h3><div class="setting-row"><label>Official sources first</label><input data-setting="quality.officialSourcesFirst" type="checkbox" ${state.quality.officialSourcesFirst ? 'checked' : ''}><span></span></div><div class="setting-row"><label>Research cache</label><input data-setting="quality.researchCacheDays" type="number" min="1" max="180" value="${state.quality.researchCacheDays}"><span>days</span></div><p class="settings-copy">Learning records performance and role fit only. Secrets and internal reasoning are never stored.</p></div></div></section>
        <section class="settings-page" data-page-panel="preview"><div class="settings-grid"><div class="settings-card"><h3>LIVE WORKSPACE</h3><div class="setting-row"><label>Enable preview</label><input data-setting="preview.enabled" type="checkbox" ${state.preview.enabled ? 'checked' : ''}><span></span></div><div class="setting-row"><label>Preferred port</label><input data-setting="preview.preferredPort" type="number" min="1024" max="65500" value="${state.preview.preferredPort}"><span>localhost</span></div><div class="setting-row"><label>Live reload</label><input data-setting="preview.liveReload" type="checkbox" ${state.preview.liveReload ? 'checked' : ''}><span></span></div><div class="setting-row"><label>Default viewport</label><select data-setting="preview.viewport"><option value="desktop">Desktop</option><option value="tablet" ${state.preview.viewport === 'tablet' ? 'selected' : ''}>Tablet</option><option value="mobile" ${state.preview.viewport === 'mobile' ? 'selected' : ''}>Mobile</option></select><span></span></div></div><div class="settings-card"><h3>APPEARANCE</h3><div class="setting-row"><label>Theme</label><select data-setting="appearance.theme"><option value="studio">Quiet Studio</option></select><span></span></div><div class="setting-row"><label>Text scale</label><input data-setting="appearance.textScale" type="range" min="0.85" max="1.25" step="0.05" value="${state.appearance.textScale}"><output>${state.appearance.textScale.toFixed(2)}×</output></div><div class="setting-row"><label>Reduced glow</label><input data-setting="appearance.reducedGlow" type="checkbox" ${state.appearance.reducedGlow ? 'checked' : ''}><span></span></div><div class="setting-row"><label>Reduce motion</label><input data-setting="appearance.reduceMotion" type="checkbox" ${state.appearance.reduceMotion ? 'checked' : ''}><span></span></div></div><div class="settings-card wide"><h3>TERMINAL</h3><div class="setting-row"><label>BigKiji session</label><input type="checkbox" checked disabled><span>Pinned</span></div><div class="setting-row"><label>Maximum tabs</label><input data-setting="terminal.maxTabs" type="range" min="2" max="16" step="1" value="${state.terminal.maxTabs}"><output>${state.terminal.maxTabs}</output></div><p class="settings-copy">Use the + button in the terminal tab row. Added cmux terminals can be renamed, colored, split or closed; the BigKiji session remains pinned.</p></div></div></section>
        <section class="settings-page" data-page-panel="mobile"><div class="mobile-connect-layout">
          <div class="settings-card mobile-ticket"><div><h3>OWNER PHONE PAIRING</h3><h2>Carry the approval desk.</h2><p>BigKiji sends compact state only. The phone renders its own 3D universe and can accept, edit, reject or stop the current run.</p><div id="mobileState" class="mobile-state"><i></i><span>Checking Mac, daemon and Tailscale…</span></div><div class="mobile-actions"><button data-mobile="pair">Create 5-minute QR</button><button data-mobile="refresh">Check connection</button><button data-mobile="copy" disabled>Copy link</button><button data-mobile="open" disabled>Open here</button></div><code id="mobileURL"></code></div><div class="mobile-qr-wrap"><img id="mobileQR" alt="One-time BigKiji mobile pairing QR code"><span id="mobileQRHint">Generate a one-time pairing ticket</span></div></div>
          <div class="settings-card mobile-steps"><h3>SETUP · SAME TAILNET REQUIRED</h3><ol><li><b>1</b><span>Install Tailscale on this Mac and your iPhone or Android device.</span></li><li><b>2</b><span>Sign in to the same tailnet. BigKiji enables a private HTTPS route—never a public port.</span></li><li><b>3</b><span>Scan the QR, pair the device, then add BigKiji Universe Mobile to the Home Screen.</span></li></ol><div id="mobileSetupLink"></div></div>
          <div class="settings-card mobile-devices"><h3>PAIRED OWNER DEVICES</h3><div id="mobileDeviceList"><p class="settings-copy">No paired device data loaded.</p></div><div class="mobile-actions"><button data-mobile="revoke-all" class="quiet-danger">Revoke all phones</button></div></div>
          <div class="settings-card mobile-note"><h3>MOBILE AUTHORITY</h3><p class="settings-copy">A paired phone may send directives and approve only the exact current revision and plan hash. Changed or already-processed plans are rejected. Code mutation still never starts without an explicit Owner action.</p></div>
        </div></section>
        <section class="settings-page" data-page-panel="cmux"><div class="settings-grid"><div class="settings-card wide"><h3>CMUX CONTROL PLANE · MACOS EXTENSION</h3><div class="setting-row"><label>CLI</label><input data-setting="cmux.cliPath" value="${esc(state.cmux.cliPath)}"><span id="cmuxStatus" class="connection"><i></i>Checking</span></div><div class="setting-row"><label>Socket password</label><input data-secret="cmux" type="password" autocomplete="off" placeholder="OS encrypted storage"><span class="connection" data-secret-status="cmux"><i></i>Not saved</span></div><div class="setting-row"><label>Theme</label><select id="cmuxTheme"><option value="">Load themes…</option></select><button data-cmux="theme">Apply</button></div><div class="setting-row"><label>Workspace</label><select id="cmuxWorkspace"><option value="">Current workspace</option></select><select id="cmuxColor"><option>Aqua</option><option>Green</option><option>Amber</option><option>Indigo</option><option>Purple</option><option>Rose</option><option>Charcoal</option></select></div><div class="cmux-controls"><button data-cmux="color">Set color</button><button data-cmux="terminal">New terminal</button><button data-cmux="split">Split right</button><button data-cmux="workspace">New workspace</button><button data-cmux="palette">All commands</button><button data-cmux="native">Open native</button></div></div><div class="settings-card wide"><h3>SAFETY</h3><div class="setting-row"><label>Confirm destructive commands</label><input type="checkbox" checked disabled><span>Required</span></div><p style="font-size:10px;line-height:1.55;color:#78938a">All cmux commands are available through the Operations Index. Commands run as argv without a shell. Close, remove, logout, hook and VM deletion operations show their exact target before execution.</p></div></div></section>
      </div></div>`;
    document.body.appendChild(root); bind(); refreshStatus();
  }
  function bind() {
    root.querySelector('.settings-close').onclick = close;
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    root.querySelectorAll('[data-page]').forEach((button) => button.onclick = () => {
      root.querySelectorAll('[data-page]').forEach((b) => b.classList.toggle('on', b === button));
      root.querySelectorAll('[data-page-panel]').forEach((p) => p.classList.toggle('on', p.dataset.pagePanel === button.dataset.page));
    });
    root.querySelectorAll('[data-setting]').forEach((input) => input.addEventListener('input', () => {
      const value = input.type === 'checkbox' ? input.checked : (input.type === 'range' || input.type === 'number' ? Number(input.value) : input.value);
      set(state, input.dataset.setting, value);
      const rail = input.closest('.voice-rail'); if (rail) { rail.style.setProperty('--level', `${Math.round(value * 100)}%`); rail.querySelector('strong').textContent = `${Math.round(value * 100)}%`; }
      const output = input.parentElement.querySelector('output'); if (output) {
        const key = input.dataset.setting;
        output.textContent = key.includes('Speed') || key.includes('textScale') ? `${Number(value).toFixed(2)}×`
          : ['routing.maxAgents', 'quality.maxRepairCycles', 'terminal.maxTabs'].includes(key) ? String(value) : `${Math.round(value * 100)}%`;
      }
      scheduleSave();
    }));
    root.querySelectorAll('[data-preview]').forEach((button) => button.onclick = () => window.bigkiji.ttsPreview({ agent: button.dataset.preview, text: button.dataset.preview === 'pi' ? 'Systems are synchronized. I am ready for the next operation.' : 'BigKiji Universe is ready. This is my English voice profile.' }));
    root.querySelectorAll('[data-secret]').forEach((input) => input.addEventListener('change', async () => { if (input.value) { await window.bigkiji.settingsSecret(input.dataset.secret, input.value); input.value = ''; refreshStatus(); } }));
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
    const [secrets, tts, cmux] = await Promise.all([window.bigkiji.settingsSecretStatus(), window.bigkiji.ttsStatus(), window.bigkiji.cmuxSnapshot()]);
    root.querySelectorAll('[data-secret-status]').forEach((el) => { const ok = !!secrets[el.dataset.secretStatus]; el.classList.toggle('ok', ok); el.innerHTML = `<i></i>${ok ? 'Keychain saved' : 'Not saved'}`; });
    const ts = root.querySelector('#ttsStatus'); ts.className = `connection ${tts.ready ? 'ok' : (tts.state === 'loading' ? '' : 'bad')}`; ts.innerHTML = `<i></i>${esc(tts.state)} · ${esc(tts.engine)}`;
    const cs = root.querySelector('#cmuxStatus'); cs.className = `connection ${cmux.connected ? 'ok' : 'bad'}`; cs.innerHTML = `<i></i>${cmux.connected ? `${cmux.surfaces?.length || 0} surfaces` : 'Offline'}`;
    if (cmux.connected) {
      const themeResult = await window.bigkiji.cmuxAction('theme-list', {}).catch(() => ({ themes: [] }));
      const theme = root.querySelector('#cmuxTheme'); if (theme) theme.innerHTML = (themeResult.themes || []).map((row) => `<option ${row.current ? 'selected' : ''}>${esc(row.name)}</option>`).join('');
      const workspace = root.querySelector('#cmuxWorkspace'); if (workspace) workspace.innerHTML = (cmux.workspaces || []).map((row) => `<option value="${esc(row.ref || row.id)}">${esc(row.title || row.ref || row.id)}</option>`).join('') || '<option value="">Current workspace</option>';
    }
    refreshMobile();
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
  function open() { root.classList.add('on'); root.setAttribute('aria-hidden', 'false'); refreshStatus(); }
  function close() { root.classList.remove('on'); root.setAttribute('aria-hidden', 'true'); }
  window.BKSettings = { async init(button) { state = await window.bigkiji.settingsGet(); window.BKAudio?.apply(state.audio); document.documentElement.style.fontSize = `${state.appearance.textScale * 100}%`; document.body.classList.toggle('reduce-motion', !!state.appearance.reduceMotion); render(); button?.addEventListener('click', open); document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === ',' && e.metaKey) { e.preventDefault(); open(); } }); }, open, close };
})();
