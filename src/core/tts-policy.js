'use strict';

const INTERNAL_LINE = /^\s*(?:\[?(?:thinking|thought|internal reasoning|chain[- ]of[- ]thought)\]?|🧠\s*(?:thinking|planning))\s*[:：-]?/i;

function sanitizeOwnerSpeech(value, max = 6000) {
  let text = String(value || '');
  text = text
    .replace(/<(thought|thinking|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(thought|thinking|analysis)\b[^>]*>[\s\S]*$/gi, ' ')
    .replace(/```(?:thinking|thought|analysis)[\s\S]*?```/gi, ' ');
  text = text.split(/\r?\n/).filter((line) => !INTERNAL_LINE.test(line)).join(' ');
  return text.replace(/[*_#`>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isOwnerFacingEvent(event = {}) {
  const kind = String(event.kind || event.type || '').toLowerCase();
  return ['say', 'result', 'final', 'question', 'agent_end'].includes(kind) && !/think|analysis|internal/.test(kind);
}

module.exports = { sanitizeOwnerSpeech, isOwnerFacingEvent };
