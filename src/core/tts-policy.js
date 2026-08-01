'use strict';

const INTERNAL_LINE = /^\s*(?:\[?(?:thinking|thought|internal reasoning|chain[- ]of[- ]thought)\]?|🧠\s*(?:thinking|planning))\s*[:：-]?/i;
const INTERNAL_TAG = /<(?:thought|thinking|analysis)\b/i;
const SENTENCE_END = /(?:[.!?。！？](?:["'”’」』】)]*)|\n)\s*/g;

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

function sanitizeAgentSpeech(value, max = 420) {
  const clean = sanitizeOwnerSpeech(value, max);
  if (!clean || /(?:api[_ -]?key|authorization:|bearer\s+[a-z0-9._-]+)/i.test(clean)) return '';
  return clean;
}

function detectSpeechLanguage(value, fallback = 'English') {
  const text = String(value || '');
  const ja = (text.match(/[ぁ-んァ-ヶ一-龯]/g) || []).length;
  const letters = (text.match(/[A-Za-zぁ-んァ-ヶ一-龯]/g) || []).length || 1;
  return ja / letters >= 0.28 ? 'Japanese' : fallback;
}

/**
 * Stateful final-answer sentence gate. It understands internal tags split over
 * multiple deltas and releases only complete, owner-visible sentences. Draft
 * text is never emitted merely because an idle timer fired.
 */
class StreamingSpeechFilter {
  constructor() { this.reset(); }
  reset() { this.buffer = ''; this.insideInternal = false; this.tagCarry = ''; }
  push(delta) {
    let input = this.tagCarry + String(delta || '');
    this.tagCarry = '';
    // Retain a possible partial tag so "<think" + "ing>" cannot leak.
    const partial = input.match(/<[^>]{0,18}$/);
    if (partial) { this.tagCarry = partial[0]; input = input.slice(0, -partial[0].length); }
    let visible = '';
    for (let i = 0; i < input.length;) {
      const rest = input.slice(i);
      const open = rest.match(/^<(thought|thinking|analysis)\b[^>]*>/i);
      const close = rest.match(/^<\/(thought|thinking|analysis)\s*>/i);
      if (open) { this.insideInternal = true; i += open[0].length; continue; }
      if (close) { this.insideInternal = false; i += close[0].length; continue; }
      if (!this.insideInternal) visible += input[i];
      i++;
    }
    this.buffer += visible;
    const out = [];
    let consumed = 0; let match;
    SENTENCE_END.lastIndex = 0;
    while ((match = SENTENCE_END.exec(this.buffer))) {
      const sentence = sanitizeOwnerSpeech(this.buffer.slice(consumed, match.index + match[0].length), 520);
      consumed = match.index + match[0].length;
      if (sentence && !INTERNAL_TAG.test(sentence) && !INTERNAL_LINE.test(sentence)) out.push(sentence);
    }
    if (consumed) this.buffer = this.buffer.slice(consumed);
    return out;
  }
  flush() {
    if (this.insideInternal || this.tagCarry) return [];
    const sentence = sanitizeOwnerSpeech(this.buffer, 520);
    this.buffer = '';
    return sentence ? [sentence] : [];
  }
}

module.exports = {
  sanitizeOwnerSpeech, sanitizeAgentSpeech, detectSpeechLanguage,
  isOwnerFacingEvent, StreamingSpeechFilter,
};
