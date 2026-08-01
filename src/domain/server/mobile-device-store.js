'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function digest(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function random(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a || '')); const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class MobileDeviceStore {
  constructor({ root, now = () => Date.now() } = {}) {
    this.root = path.resolve(root); this.file = path.join(this.root, 'mobile-devices.json'); this.now = now; this.pairings = new Map(); this.state = this.load();
  }
  load() {
    try { const value = JSON.parse(fs.readFileSync(this.file, 'utf8')); return { version: 1, devices: value.devices || [] }; }
    catch (_) { return { version: 1, devices: [] }; }
  }
  save() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); fs.renameSync(temp, this.file);
  }
  createPairing({ ttlMs = 5 * 60 * 1000 } = {}) {
    this.cleanup(); const code = random(18); const expiresAt = this.now() + ttlMs;
    this.pairings.set(digest(code), { expiresAt }); return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  validPairing(code) { const item = this.pairings.get(digest(code)); return !!item && item.expiresAt > this.now(); }
  pair(code, { name = 'Owner phone', platform = 'mobile' } = {}) {
    const key = digest(code); const pairing = this.pairings.get(key);
    if (!pairing || pairing.expiresAt <= this.now()) throw new Error('PAIRING_CODE_INVALID_OR_EXPIRED');
    this.pairings.delete(key); const token = random(32); const csrf = random(20); const id = `mobile-${random(8)}`; const at = new Date(this.now()).toISOString();
    this.state.devices.push({ id, name: String(name || 'Owner phone').replace(/[\r\n<>]/g, '').slice(0, 80),
      platform: String(platform || 'mobile').slice(0, 40), tokenHash: digest(token), csrfHash: digest(csrf),
      permissions: ['observe', 'prompt', 'directive', 'abort', 'session'], createdAt: at, lastActiveAt: at, revokedAt: null });
    this.state.devices = this.state.devices.slice(-24); this.save(); return { token, csrf, device: this.public(this.state.devices.at(-1)) };
  }
  authenticate(token) {
    const tokenHash = digest(token); const device = this.state.devices.find((item) => !item.revokedAt && safeEqual(item.tokenHash, tokenHash));
    if (!device) return null; device.lastActiveAt = new Date(this.now()).toISOString(); this.save(); return device;
  }
  verifyCsrf(device, csrf) { return !!device && safeEqual(device.csrfHash, digest(csrf)); }
  list() { return this.state.devices.map((device) => this.public(device)); }
  revoke(id = '') {
    let count = 0; for (const device of this.state.devices) if (!device.revokedAt && (!id || device.id === id)) { device.revokedAt = new Date(this.now()).toISOString(); count++; }
    this.save(); return { revoked: count, devices: this.list() };
  }
  cleanup() { for (const [key, item] of this.pairings) if (item.expiresAt <= this.now()) this.pairings.delete(key); }
  public(device) { const { tokenHash, csrfHash, ...safe } = device; return safe; }
}

module.exports = { MobileDeviceStore, digest, safeEqual };

