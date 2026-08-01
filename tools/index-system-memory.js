#!/usr/bin/env node
'use strict';

const path = require('path');
const { writeSystemMemory, DEFAULT_FILE } = require('../src/domain/pi-core/system-memory');
const appRoot = path.resolve(__dirname, '..');
const result = writeSystemMemory({ appRoot });
console.log(`[BIGKIJI SYSTEM MEMORY] ${result.unchanged ? 'current' : 'indexed'} · ${result.files.length} files · ${result.structureHash.slice(0, 12)} · ${DEFAULT_FILE}`);

