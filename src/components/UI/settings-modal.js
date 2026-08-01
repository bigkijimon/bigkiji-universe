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
      <div class="settings-head"><span class="sigil"><i></i></span><div class="settings-title"><b id="settingsTitle">VOICE CONTROL DECK</b><span>BigKiji local speech, routing and cmux operations</span></div><button class="settings-close" aria-label="Close settings">×</button></div>
      <nav class="settings-tabs"><button class="on" data-page="audio">AUDIO & VOICES</button><button data-page="models">MODELS & API</button><button data-page="cmux">CMUX</button></nav>
      <div class="settings-body">
        <section class="settings-page on" data-page-panel="audio">
          <div class="sla-strip"><b>FIRST SPEECH SLA</b><i></i><span>meaningful answer ≤ ${Math.round(state.audio.firstSpeechDeadlineMs / 1000)}s</span></div>
          <div class="voice-rails">${rail('owner', 'OWNER / PRIMARY', '#00f3ff', state.audio.ownerVolume)}${rail('agent', 'AGENT / BACKGROUND', '#a78bfa', state.audio.agentVolume)}</div>
          <div class="settings-grid">
            <div class="settings-card"><h3>ATTENTION & PACING</h3>
              <div class="setting-row"><label>Attention chime</label><input data-setting="audio.attentionChime" type="checkbox" ${state.audio.attentionChime ? 'checked' : ''}><span></span></div>
              <div class="setting-row"><label>Chime tone</label><select data-setting="audio.chimeTone"><option>arrival</option><option>soft</option><option>pulse</option></select><span></span></div>
              <div class="setting-row"><label>English speed</label><input data-setting="audio.ownerSpeedEnglish" type="range" min="0.85" max="1.4" step="0.01" value="${state.audio.ownerSpeedEnglish}"><output>${state.audio.ownerSpeedEnglish.toFixed(2)}×</output></div>
              <div class="setting-row"><label>Japanese speed</label><input data-setting="audio.ownerSpeedJapanese" type="range" min="0.85" max="1.4" step="0.01" value="${state.audio.ownerSpeedJapanese}"><output>${state.audio.ownerSpeedJapanese.toFixed(2)}×</output></div>
              <div class="setting-row"><label>Pause naturalness</label><input data-setting="audio.pauseNaturalness" type="range" min="0" max="1" step="0.01" value="${state.audio.pauseNaturalness}"><output>${Math.round(state.audio.pauseNaturalness * 100)}%</output></div>
            </div>
            <div class="settings-card"><h3>VOICE PERSONALITIES · DEFAULT ENGLISH</h3>${profileRow('claude')}${profileRow('codex')}${profileRow('glm')}${profileRow('pi')}${profileRow('gemini')}</div>
            <div class="settings-card wide"><h3>LOCAL NEURAL ENGINE</h3><div class="setting-row"><label>Qwen3-TTS endpoint</label><input data-setting="audio.ttsEndpoint" value="${esc(state.audio.ttsEndpoint)}"><span id="ttsStatus" class="connection"><i></i>Checking</span></div><div class="setting-row"><label>Model</label><select data-setting="audio.ttsModel"><option value="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice">0.6B · Fast balanced</option><option value="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" ${state.audio.ttsModel.includes('1.7B') ? 'selected' : ''}>1.7B · High quality</option></select><span></span></div></div>
          </div>
        </section>
        <section class="settings-page" data-page-panel="models"><div class="settings-grid"><div class="settings-card wide"><h3>AUTHORIZED PAID MODELS · OS ENCRYPTED STORAGE</h3>${Object.entries(providerLabels).map(([id,label]) => `<div class="setting-row"><label>${label}</label><input data-secret="${id}" type="password" autocomplete="off" placeholder="Leave blank to keep saved credential"><span class="connection" data-secret-status="${id}"><i></i>Not saved</span></div>`).join('')}</div><div class="settings-card"><h3>LOCAL ROUTING</h3><div class="setting-row"><label>Qwen bypass timeout</label><input data-setting="routing.qwenBypassTimeoutMs" type="number" min="250" max="5000" step="50" value="${state.routing.qwenBypassTimeoutMs}"><span>ms</span></div></div><div class="settings-card"><h3>BUDGET POLICY</h3><p style="font-size:11px;line-height:1.6;color:#8ba49d">Paid allowlist: Claude · Codex · Gemini · GLM.<br>Planning, context pruning and speech stay local.</p></div><div class="settings-card wide"><h3>PORTABLE DATA PATHS · RESTART TO APPLY</h3><div class="setting-row"><label>BigKiji Vault</label><input data-setting="paths.vaultRoot" placeholder="~/Documents/BigKiji" value="${esc(state.paths?.vaultRoot || '')}"><span></span></div><div class="setting-row"><label>Knowledge cache</label><input data-setting="paths.knowledgeRoot" placeholder="OS app data" value="${esc(state.paths?.knowledgeRoot || '')}"><span></span></div><div class="setting-row"><label>Graphify graph.json</label><input data-setting="paths.graphifyGraphPath" placeholder="Vault/graphify-out/graph.json" value="${esc(state.paths?.graphifyGraphPath || '')}"><span></span></div></div></div></section>
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
      const output = input.parentElement.querySelector('output'); if (output) output.textContent = input.dataset.setting.includes('Speed') ? `${Number(value).toFixed(2)}×` : `${Math.round(value * 100)}%`;
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
  }
  function open() { root.classList.add('on'); root.setAttribute('aria-hidden', 'false'); refreshStatus(); }
  function close() { root.classList.remove('on'); root.setAttribute('aria-hidden', 'true'); }
  window.BKSettings = { async init(button) { state = await window.bigkiji.settingsGet(); window.BKAudio?.apply(state.audio); render(); button?.addEventListener('click', open); document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === ',' && e.metaKey) { e.preventDefault(); open(); } }); }, open, close };
})();
