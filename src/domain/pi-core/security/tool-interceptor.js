'use strict';

const { SecurityPolicy } = require('./security-policy');
const { sanitizeSearchQuery } = require('./payload-redactor');

const READ_TOOLS = /^(?:Read|Glob|Grep|read_file|list_directory|glob|grep_search)$/i;
const WRITE_TOOLS = /^(?:Write|Edit|write_file|replace)$/i;
const WEB_TOOLS = /(?:WebFetch|WebSearch|google_web_search|web_fetch|browser|chrome)/i;
const SHELL_TOOLS = /^(?:Bash|run_shell_command|shell|exec)$/i;

function candidatePaths(input = {}) {
  return ['file_path', 'path', 'directory', 'dir', 'cwd'].flatMap((key) => input[key] ? [String(input[key])] : []);
}

class ToolInterceptor {
  constructor({ security = new SecurityPolicy() } = {}) { this.security = security; }
  decide(event, policy) {
    const tool = String(event.tool_name || event.toolName || ''); const input = event.tool_input || event.input || {};
    try {
      if (!tool) throw new Error('SECURITY_UNKNOWN_TOOL');
      if (WEB_TOOLS.test(tool) || /^mcp__/i.test(tool)) throw new Error(`SECURITY_EXTERNAL_TOOL_BLOCKED:${tool}`);
      if (READ_TOOLS.test(tool)) {
        const paths = candidatePaths(input); if (!paths.length && input.pattern && /[\\/]/.test(input.pattern)) paths.push(input.pattern);
        for (const value of paths.length ? paths : [policy.taskRoot]) this.security.assertPath(policy, value, 'read');
        return { allow: true, reason: 'sandbox read allowed' };
      }
      if (WRITE_TOOLS.test(tool)) {
        const paths = candidatePaths(input); if (!paths.length) throw new Error('SECURITY_WRITE_PATH_REQUIRED');
        for (const value of paths) this.security.assertPath(policy, value, 'write');
        return { allow: true, reason: 'approved write root' };
      }
      if (SHELL_TOOLS.test(tool)) {
        const command = String(input.command || input.cmd || '').trim();
        if (!command || /(?:^|\s)(?:curl|wget|scp|sftp|ssh|nc|ncat|telnet|open|osascript|python\s+-c)(?:\s|$)/i.test(command)) throw new Error('SECURITY_SHELL_NETWORK_OR_DYNAMIC_CODE_BLOCKED');
        if (/[|;&><`]|\$\(/.test(command)) throw new Error('SECURITY_COMPLEX_SHELL_BLOCKED');
        if (!policy.security.shellCommands.some((source) => new RegExp(source, 'i').test(command))) throw new Error('SECURITY_SHELL_COMMAND_NOT_ALLOWLISTED');
        return { allow: true, reason: 'allowlisted verification command' };
      }
      if (/^(?:AskUserQuestion|ExitPlanMode|ask_user)$/i.test(tool)) return { allow: true, reason: 'owner interaction' };
      throw new Error(`SECURITY_UNKNOWN_TOOL:${tool}`);
    } catch (error) { return { allow: false, reason: String(error.message || error) }; }
  }
  sanitizeResearch(query) { return sanitizeSearchQuery(query); }
}

module.exports = { ToolInterceptor, READ_TOOLS, WRITE_TOOLS, WEB_TOOLS, SHELL_TOOLS, candidatePaths };
