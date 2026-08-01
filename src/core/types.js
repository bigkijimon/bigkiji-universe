'use strict';

const FLEET_STATUS = Object.freeze({
  IDLE: 'IDLE',
  ORCHESTRATING: 'ORCHESTRATING',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  REPAIRING: 'REPAIRING',
  FAILED: 'FAILED',
  COMPLETED: 'COMPLETED',
  BYPASSED_QWEN_TIMEOUT: 'BYPASSED_QWEN_TIMEOUT',
});

const PHASE_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
});

module.exports = { FLEET_STATUS, PHASE_STATUS };
