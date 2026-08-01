#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { ToolInterceptor } = require('./tool-interceptor');

async function main() {
  const policyFile = process.env.BIGKIJI_SECURITY_POLICY || process.argv[2];
  if (!policyFile) throw new Error('SECURITY_POLICY_MISSING');
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw || '{}'); const result = new ToolInterceptor().decide(event, policy);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: result.allow ? 'allow' : 'deny', permissionDecisionReason: result.reason } }));
  process.exitCode = 0;
}

main().catch((error) => { console.error(String(error.message || error)); process.exitCode = 2; });
