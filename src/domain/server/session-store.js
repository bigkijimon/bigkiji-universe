'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
}

class SessionStore {
  constructor({ root = path.join(os.homedir(), '.bigkiji', 'sessions') } = {}) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  create(prompt, metadata = {}) {
    const now = new Date().toISOString();
    const id = `session-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const session = { id, createdAt: now, updatedAt: now, status: 'PREFLIGHT',
      promptSummary: String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 180), metadata };
    this.append(id, { type: 'session', session });
    return session;
  }

  append(id, event) {
    const key = safeId(id);
    if (!key) throw new Error('Invalid session id');
    const row = { ts: new Date().toISOString(), ...event };
    fs.appendFileSync(path.join(this.root, `${key}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return row;
  }

  read(id) {
    const file = path.join(this.root, `${safeId(id)}.jsonl`);
    if (!fs.existsSync(file)) return null;
    const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch (_) { return []; }
    });
    const seed = events.find((entry) => entry.type === 'session')?.session || { id: safeId(id) };
    const latest = [...events].reverse().find((entry) => entry.status || entry.run?.status);
    return { ...seed, status: latest?.status || latest?.run?.status || seed.status, updatedAt: latest?.ts || seed.updatedAt, events };
  }

  list(limit = 40) {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^session-[\w-]+\.jsonl$/.test(entry.name))
      .map((entry) => {
        const full = path.join(this.root, entry.name);
        const session = this.read(entry.name.slice(0, -6));
        return { ...session, events: undefined, bytes: fs.statSync(full).size };
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 40)));
  }
}

module.exports = { SessionStore, safeId };
