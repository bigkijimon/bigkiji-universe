'use strict';

const FLEET_STATUS = Object.freeze({
  IDLE: 'IDLE',
  ORCHESTRATING: 'ORCHESTRATING',
  EXECUTING: 'EXECUTING',
  BYPASSED_QWEN_TIMEOUT: 'BYPASSED_QWEN_TIMEOUT',
});

const PHASE_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
});

module.exports = { FLEET_STATUS, PHASE_STATUS };
