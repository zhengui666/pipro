export function redactor(secrets = []) {
  const literals = secrets.filter(v => typeof v === 'string' && v.length >= 4).sort((a, b) => b.length - a.length);
  return value => {
    let text = String(value);
    for (const secret of literals) text = text.split(secret).join('[REDACTED]');
    return text
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
      .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]')
      .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [REDACTED]')
      .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  };
}

export function safeText(value, redact, maxChars) {
  const text = redact(typeof value === 'string' ? value : '');
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

// Use a fixed projection. Never publish arbitrary event args/results/messages/paths.
export function eventSummary(record) {
  const knownTypes = new Set(['agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end',
    'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update',
    'tool_execution_end', 'queue_update', 'compaction_start', 'compaction_end',
    'auto_retry_start', 'auto_retry_end', 'summarization_retry_scheduled', 'summarization_retry_finished']);
  const out = { type: knownTypes.has(record.type) ? record.type : 'other_event' };
  if (record.type === 'message_end') {
    const message = record.message;
    if (['assistant', 'user', 'toolResult'].includes(message?.role)) out.role = message.role;
    if (['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message?.stopReason)) out.stopReason = message.stopReason;
  }
  if (record.type.startsWith('tool_execution_')) {
    out.tool = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'].includes(record.toolName) ? record.toolName : 'other';
    if (typeof record.isError === 'boolean') out.isError = record.isError;
  }
  if (record.type === 'queue_update') {
    out.steeringCount = Array.isArray(record.steering) ? record.steering.length : 0;
    out.followupCount = Array.isArray(record.followUp) ? record.followUp.length : 0;
  }
  return out;
}

