'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const QRCode = require('qrcode');

function run(file, args, timeout = 7000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 2 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { detail: String(stderr || stdout).trim() })) : resolve(String(stdout))));
}

class TailscaleRemoteAccess {
  constructor({ port = 8777, configFile = path.join(os.homedir(), '.bigkiji', 'remote.json') } = {}) {
    this.port = Number(port); this.configFile = configFile;
    this.bin = [process.env.TAILSCALE_BIN, '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale'].find((value) => value && (value === 'tailscale' || fs.existsSync(value)));
  }
  token() { try { return JSON.parse(fs.readFileSync(this.configFile, 'utf8')).token || ''; } catch (_) { return ''; } }
  async status({ ensure = false } = {}) {
    if (!this.bin) return { state: 'unavailable', ready: false, requirement: 'Install Tailscale on this Mac and on the phone.' };
    let status;
    try { status = JSON.parse(await run(this.bin, ['status', '--json'])); }
    catch (error) { return { state: 'offline', ready: false, requirement: 'Open Tailscale on this Mac, sign in, then retry. The phone must use the same tailnet.', detail: error.detail || error.message }; }
    const self = status.Self || {}; const online = self.Online !== false && ['Running', 'NeedsLogin'].includes(status.BackendState) ? status.BackendState === 'Running' : !!self.TailscaleIPs?.length;
    if (!online) return { state: 'offline', ready: false, requirement: 'Connect this Mac and the iPhone/Android device to the same Tailscale tailnet.', backendState: status.BackendState };
    if (ensure) {
      try { await run(this.bin, ['serve', '--bg', '--yes', `http://127.0.0.1:${this.port}`], 15000); }
      catch (error) {
        const detail = error.detail || error.message; const setupUrl = String(detail).match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0] || '';
        return { state: 'error', ready: false,
          requirement: setupUrl ? 'Tailscale Serve needs one-time approval from the tailnet owner.' : 'Tailscale Serve could not be enabled. Check tailnet HTTPS permissions.',
          detail, setupUrl };
      }
    }
    const dns = String(self.DNSName || '').replace(/\.$/, ''); const ip = self.TailscaleIPs?.find((value) => /^100\./.test(value)) || self.TailscaleIPs?.[0] || '';
    const baseUrl = dns ? `https://${dns}` : `http://${ip}:${this.port}`; const token = this.token();
    if (!baseUrl || !token) return { state: 'error', ready: false, requirement: 'BigKiji daemon credentials are not ready.' };
    const url = `${baseUrl}/?t=${encodeURIComponent(token)}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#07100d', light: '#f4fff9' } });
    return { state: ensure ? 'ready' : 'available', ready: !!ensure, url, displayUrl: `${baseUrl}/`, qrDataUrl,
      device: self.HostName || dns.split('.')[0], requirement: 'Install Tailscale on iPhone/Android and connect it to this Mac’s tailnet before scanning.' };
  }
}

module.exports = { TailscaleRemoteAccess };
