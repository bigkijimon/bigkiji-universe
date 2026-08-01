'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redactPayload } = require('./security/payload-redactor');

function digest(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function safeId(value) { return String(value || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 96); }
function clean(value, max = 4000) {
  return redactPayload(String(value || '')).text.replace(/<(?:thought|thinking|analysis)\b[^>]*>[\s\S]*?<\/(?:thought|thinking|analysis)>/gi, '')
    .replace(/^\s*(?:thinking|thought|analysis|internal reasoning)\s*:\s*.*$/gim, '').trim().slice(0, max);
}
function list(values, max = 12) { return [...new Set((values || []).map((value) => clean(value, 500)).filter(Boolean))].slice(0, max); }
function slug(value) {
  const ascii = clean(value, 80).toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii.slice(0, 64) || 'bigkiji-idea';
}
function yaml(value) { return JSON.stringify(clean(value, 500)); }

class IdeaDraftStore {
  constructor({ root, workspace } = {}) {
    if (!root) throw new Error('IdeaDraftStore requires root');
    this.root = path.resolve(root); this.workspace = path.resolve(workspace || process.cwd());
    this.archiveRoot = path.join(this.root, 'archive');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  files(id) {
    const key = safeId(id); if (!key) throw new Error('Invalid idea id');
    return { markdown: path.join(this.root, `${key}.md`), metadata: path.join(this.root, `${key}.json`) };
  }

  render(value) {
    const sections = [
      ['Summary', value.summary ? [value.summary] : []],
      ['Ideas', value.ideas], ['Requirements', value.requirements], ['Decisions', value.decisions],
      ['Open questions', value.openQuestions], ['TODO', value.todos],
    ];
    const body = sections.filter(([, entries]) => entries?.length).map(([title, entries]) =>
      `## ${title}\n\n${entries.map((entry) => title === 'Summary' ? clean(entry) : `- ${clean(entry)}`).join('\n')}`).join('\n\n');
    return `---\nid: ${yaml(value.id)}\nstatus: ${yaml(value.status)}\nsource_session: ${yaml(value.sessionId)}\nsource_turn: ${yaml(value.turnId)}\nprivacy: ${value.status === 'promoted' ? 'local-adopted' : 'local-draft'}\ncreated_at: ${yaml(value.createdAt)}\nupdated_at: ${yaml(value.updatedAt)}\n---\n\n# ${clean(value.title, 160)}\n\n${body || '## Summary\n\nLocal conversation note.'}\n`;
  }

  writeAtomic(file, data, mode = 0o600) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data, { mode }); fs.renameSync(tmp, file);
  }

  create(input = {}) {
    const now = new Date().toISOString();
    const value = {
      id: safeId(input.id) || `idea-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      status: 'draft', title: clean(input.title || input.summary || 'BigKiji idea', 160), summary: clean(input.summary, 1800),
      ideas: list(input.ideas), requirements: list(input.requirements), decisions: list(input.decisions),
      openQuestions: list(input.openQuestions), todos: list(input.todos), sessionId: safeId(input.sessionId),
      turnId: safeId(input.turnId), sourceExcerpt: clean(input.sourceExcerpt, 2400), provider: clean(input.provider || 'local-qwen', 80),
      confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0)), createdAt: now, updatedAt: now,
    };
    const markdown = this.render(value); value.draftHash = digest(markdown);
    const target = this.files(value.id); this.writeAtomic(target.markdown, markdown); this.writeAtomic(target.metadata, JSON.stringify(value, null, 2));
    return this.public(value);
  }

  read(id) {
    const target = this.files(id); if (!fs.existsSync(target.metadata) || !fs.existsSync(target.markdown)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(target.metadata, 'utf8')); const markdown = fs.readFileSync(target.markdown, 'utf8');
      return this.public({ ...value, draftHash: digest(markdown), markdown });
    } catch (_) { return null; }
  }

  list(limit = 40) {
    return fs.readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isFile() && /^idea-[\w-]+\.json$/.test(entry.name))
      .map((entry) => this.read(entry.name.slice(0, -5))).filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, Math.max(1, Math.min(200, Number(limit) || 40)))
      .map(({ markdown, sourceExcerpt, ...item }) => item);
  }

  revise(id, patch = {}, { expectedHash = '' } = {}) {
    const current = this.read(id); if (!current) throw new Error('Unknown idea draft');
    if (expectedHash && expectedHash !== current.draftHash) throw new Error('STALE_IDEA_DRAFT');
    const value = { ...current, ...patch, id: current.id, status: patch.status || current.status,
      title: clean(patch.title ?? current.title, 160), summary: clean(patch.summary ?? current.summary, 1800),
      ideas: list(patch.ideas ?? current.ideas), requirements: list(patch.requirements ?? current.requirements),
      decisions: list(patch.decisions ?? current.decisions), openQuestions: list(patch.openQuestions ?? current.openQuestions),
      todos: list(patch.todos ?? current.todos), updatedAt: new Date().toISOString() };
    delete value.markdown; delete value.draftHash;
    const markdown = this.render(value); value.draftHash = digest(markdown); const target = this.files(value.id);
    this.writeAtomic(target.markdown, markdown); this.writeAtomic(target.metadata, JSON.stringify(value, null, 2));
    return this.public(value);
  }

  promote(id, { draftHash, ownerConfirmed = false } = {}) {
    if (!ownerConfirmed) throw new Error('OWNER_CONFIRMATION_REQUIRED');
    const current = this.read(id); if (!current) throw new Error('Unknown idea draft');
    if (!draftHash || draftHash !== current.draftHash) throw new Error('STALE_IDEA_DRAFT');
    const targetRoot = path.join(this.workspace, 'docs', 'ideas'); fs.mkdirSync(targetRoot, { recursive: true });
    const destination = path.join(targetRoot, `${new Date().toISOString().slice(0, 10)}-${slug(current.title)}-${current.id.slice(-6)}.md`);
    const promotedPath = path.relative(this.workspace, destination).replace(/\\/g, '/');
    const revised = this.revise(id, { status: 'promoted', promotedPath }, { expectedHash: current.draftHash });
    const promoted = this.read(id); this.writeAtomic(destination, promoted.markdown, 0o644);
    return { ...revised, promotedPath };
  }

  archive(id, { draftHash, ownerConfirmed = false } = {}) {
    if (!ownerConfirmed) throw new Error('OWNER_CONFIRMATION_REQUIRED');
    const current = this.read(id); if (!current) throw new Error('Unknown idea draft');
    if (!draftHash || draftHash !== current.draftHash) throw new Error('STALE_IDEA_DRAFT');
    fs.mkdirSync(this.archiveRoot, { recursive: true, mode: 0o700 }); const target = this.files(id);
    for (const file of [target.markdown, target.metadata]) fs.renameSync(file, path.join(this.archiveRoot, path.basename(file)));
    return { id: current.id, status: 'archived', archivedAt: new Date().toISOString() };
  }

  public(value) {
    if (!value) return null;
    return { id: value.id, status: value.status, title: value.title, summary: value.summary, ideas: value.ideas || [],
      requirements: value.requirements || [], decisions: value.decisions || [], openQuestions: value.openQuestions || [],
      todos: value.todos || [], sessionId: value.sessionId, turnId: value.turnId, provider: value.provider,
      confidence: value.confidence, draftHash: value.draftHash, createdAt: value.createdAt, updatedAt: value.updatedAt,
      promotedPath: value.promotedPath, markdown: value.markdown };
  }
}

module.exports = { IdeaDraftStore, digest, clean, safeId };
