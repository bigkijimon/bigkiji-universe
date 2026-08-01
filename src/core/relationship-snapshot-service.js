'use strict';

const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');

class RelationshipSnapshotService extends EventEmitter {
  constructor({ graphPath, workerPath = path.join(__dirname, 'relationship-worker.js') } = {}) {
    super();
    this.graphPath = graphPath;
    this.workerPath = workerPath;
    this.current = { version: 1, nodes: [], edges: [], source: 'graphify', state: 'idle', graphUpdatedAt: 0 };
    this.graphMtime = 0;
    this.worker = null;
  }

  snapshot() { return { ...this.current, nodes: this.current.nodes.slice(), edges: this.current.edges.slice() }; }

  async refresh(force = false) {
    let stat;
    try { stat = await fs.promises.stat(this.graphPath); } catch (_) {
      this.current = { ...this.current, state: 'missing', error: `Graphify graph not found: ${this.graphPath}` };
      this.emit('update', this.snapshot()); return this.snapshot();
    }
    if (!force && stat.mtimeMs === this.graphMtime && this.current.state === 'ready') return this.snapshot();
    if (this.worker) return this.snapshot();
    this.graphMtime = stat.mtimeMs;
    this.current = { ...this.current, state: 'loading', error: '' };
    this.emit('update', this.snapshot());
    const started = Date.now();
    this.worker = new Worker(this.workerPath, { workerData: { graphPath: this.graphPath } });
    this.worker.once('message', (message) => {
      this.worker = null;
      this.current = message.ok ? { ...message.snapshot, state: 'ready', loadMs: Date.now() - started }
        : { ...this.current, state: 'error', error: message.error, loadMs: Date.now() - started };
      this.emit('update', this.snapshot());
    });
    this.worker.once('error', (error) => {
      this.worker = null; this.current = { ...this.current, state: 'error', error: error.message, loadMs: Date.now() - started };
      this.emit('update', this.snapshot());
    });
    return this.snapshot();
  }

  dispose() { this.worker?.terminate(); this.worker = null; }
}

module.exports = { RelationshipSnapshotService };
