'use strict';

const { TUIRenderer } = require('./renderer');

class TUIMonitor {
  constructor({ client, input = process.stdin, output = process.stdout } = {}) {
    this.client = client; this.input = input; this.output = output; this.renderer = new TUIRenderer({ output });
    this.state = {}; this.relay = []; this.timer = null; this.onEvent = this.onEvent.bind(this); this.onKey = this.onKey.bind(this);
  }
  async start() {
    this.state = await this.client.state(); this.client.on('event', this.onEvent); this.client.connect();
    this.output.write('\x1b[?1049h\x1b[?25l');
    if (this.input.isTTY) { this.input.setRawMode(true); this.input.resume(); this.input.on('data', this.onKey); }
    this.timer = setInterval(() => this.refresh(), 1000); this.timer.unref?.(); this.renderer.draw(this.state, this.relay);
    return new Promise((resolve) => { this.resolve = resolve; });
  }
  async refresh() { try { this.state = await this.client.state(); this.renderer.draw(this.state, this.relay); } catch (error) { this.push('DAEMON', error.message); } }
  onEvent({ event, data }) {
    if (event === 'state') this.state = data;
    else if (event === 'models') this.state.models = data;
    else if (event === 'run') { const list = this.state.runs || []; this.state.runs = [...list.filter((run) => run.id !== data.id), data]; this.state.phase = data.status; }
    else if (event === 'phase') this.state.phase = data.phase || data.status;
    if (['commentary', 'tasklog', 'phase', 'run', 'session'].includes(event)) this.push(data.source || data.provider || event, data.text || data.status || data.phase || 'update');
    this.renderer.draw(this.state, this.relay);
  }
  push(source, text) { this.relay.push({ time: new Date().toLocaleTimeString('en-GB', { hour12: false }), source, text: String(text || '').replace(/\s+/g, ' ') }); this.relay = this.relay.slice(-40); }
  async onKey(buffer) {
    const key = buffer.toString();
    if (key === 'q' || key === '\x1b' || key === '\x03') return this.stop();
    if (key === 'r') { const result = await this.client.reload().catch((error) => ({ error: error.message })); this.push('RELOAD', result.error || `${result.cleared} hooks`); }
    if (key === 'a' || key === 'x') {
      const run = (this.state.runs || []).filter((item) => item.status === 'AWAITING_APPROVAL').at(-1);
      if (run) { const result = key === 'a' ? await this.client.approve(run.id) : await this.client.abort(run.id); this.push('OWNER', result.status); }
    }
    if (key === 'h') this.client.emit('hud-request');
  }
  stop() {
    clearInterval(this.timer); this.client.off('event', this.onEvent); this.client.disconnect();
    if (this.input.isTTY) { this.input.off('data', this.onKey); this.input.setRawMode(false); }
    this.output.write('\x1b[?25h\x1b[?1049l'); this.resolve?.();
  }
}

module.exports = { TUIMonitor };
