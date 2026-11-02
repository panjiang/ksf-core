// Adapter for the observed Codex JSONL format, deliberately separate from the archive protocol.
import { createReadStream, lstatSync, readdirSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isToken, fail, encode } from '../routing/schema.js';
import { sha256 } from '../shared/hash.js';

const nativeTime = (value, fallback) => typeof value === 'number' && Number.isFinite(value)
  ? new Date(value < 100_000_000_000 ? value * 1000 : value).toISOString()
  : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;

export function sourceMeta(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('TASK_SOURCE_INVALID', 'Transcript must be an ordinary file.');
  const fd = openSync(path, 'r');
  try {
    const chunks = []; let size = 0, end = -1;
    while (size < 1024 * 1024 && end < 0) {
      const chunk = Buffer.alloc(4096), count = readSync(fd, chunk, 0, chunk.length, size);
      if (!count) break;
      chunks.push(chunk.subarray(0, count)); size += count;
      end = chunk.subarray(0, count).indexOf(10);
    }
    const bytes = Buffer.concat(chunks); end = bytes.indexOf(10);
    if (end < 0) fail('TASK_SOURCE_UNSUPPORTED', 'Missing supported session metadata.');
    let row;
    try { row = JSON.parse(bytes.subarray(0, end).toString('utf8')); }
    catch { fail('TASK_SOURCE_UNSUPPORTED', 'Invalid or unknown Codex transcript metadata.'); }
    if (row.type !== 'session_meta' || !row.payload?.id) fail('TASK_SOURCE_UNSUPPORTED', 'Unknown Codex transcript metadata.');
    return { meta: row.payload, stat };
  } finally { closeSync(fd); }
}
export function belongsToRoot(meta, root) {
  return [meta.cwd, ...(meta.runtime_workspace_roots ?? [])].some(path => typeof path === 'string' && resolve(path) === resolve(root));
}
// Native internal workers are not user-owned Codex chats. A parent ID alone
// is insufficient: a user-created fork is still a real chat task.
export function isInternalSession(meta) {
  return meta.source !== null && typeof meta.source === 'object' && Object.hasOwn(meta.source, 'subagent');
}
export function discover(home) {
  const files = [];
  function visit(folder) {
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of entries) {
      if (e.isDirectory()) visit(join(folder, e.name));
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) files.push(join(folder, e.name));
    }
  }
  visit(join(home, 'sessions')); visit(join(home, 'archived_sessions'));
  return files.sort();
}
export function titles(home) {
  let body;
  try { body = readFileSync(join(home, 'session_index.jsonl'), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return new Map(); throw e; }
  const result = new Map();
  for (const line of body.split('\n')) {
    try { const r = JSON.parse(line); if (r.id && typeof r.thread_name === 'string') result.set(r.id, r.thread_name); } catch { /* Partial appended index line. */ }
  }
  return result;
}
function visibleContent(payload) {
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (payload.role === 'user' && kinds && !kinds.some(k => k === 'user.text' || k.startsWith('user.'))) return [];
  if (!Array.isArray(payload.content)) fail('TASK_SOURCE_UNSUPPORTED', 'Unknown Codex message content format.');
  return payload.content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'input_text' || block.type === 'text' || block.type === 'output_text') {
      if (typeof block.text !== 'string') return [];
      let text = block.text;
      // Strip only a known, complete automatic wrapper. Arbitrary quoted material stays intact.
      if (payload.role === 'user' && /^\s*<in-app-browser-context source="ambient-ui-state">/.test(text)) {
        const closing = '</in-app-browser-context>', end = text.indexOf(closing);
        if (end >= 0 && /^\s*## My request:\s*/.test(text.slice(end + closing.length))) text = text.slice(end + closing.length).replace(/^\s*## My request:\s*/, '');
      }
      return [{ ...block, text }];
    }
    // Attachment structure and references, without copying artifacts or downloading resources.
    return /image|audio|file|video|attachment/.test(block.type ?? '') ? [block] : [];
  });
}
async function* sourceLines(stream, start) {
  let pending = Buffer.alloc(0), position = start;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let begin = 0, end;
    while ((end = pending.indexOf(10, begin)) >= 0) {
      const bytes = pending.subarray(begin, end);
      yield { line: bytes.toString('utf8').replace(/\r$/, ''), offset: position, end: position + end - begin + 1, complete: true };
      position += end - begin + 1; begin = end + 1;
    }
    pending = pending.subarray(begin);
  }
  if (pending.length) yield { line: pending.toString('utf8'), offset: position, end: position, complete: false };
}
// Metadata-only reconciliation for chat counters. Never retain message bodies,
// tool outputs or pre-activation native turns in the chat-state store.
export async function nativeTurnState(path, activatedAt) {
  const stream = createReadStream(path), ids = new Set(); let current = null, partial = false;
  try {
    for await (const entry of sourceLines(stream, 0)) {
      if (!entry.complete) { partial = true; continue; } // Hooks may supply a boundary before its final flush.
      let row;
      try { row = JSON.parse(entry.line); } catch { fail('CHAT_SOURCE_PARTIAL', 'Native transcript contains an unreadable record; counting is unconfirmed.'); }
      if (row.type === 'turn_context' && current && row.payload?.turn_id !== current.turnId) current.state = 'unconfirmed';
      if (row.type !== 'event_msg') continue;
      // Desktop started_at may be whole seconds while the envelope timestamp
      // and session creation include milliseconds. Preserve that precision so
      // a real first turn does not appear to precede its own thread creation.
      const p = row.payload ?? {}, at = nativeTime(row.timestamp, nativeTime(p.started_at));
      if (['task_complete','turn_aborted','task_interrupted'].includes(p?.type)) {
        if (current && (!p.turn_id || p.turn_id === current.turnId)) current.state = p.type === 'task_complete' ? 'completed' : 'interrupted';
        continue;
      }
      if (p?.type !== 'task_started') continue;
      if (!isToken(p.turn_id) || !Number.isFinite(Date.parse(at))) fail('CHAT_SOURCE_UNSUPPORTED', 'Unknown native turn boundary; counting is unconfirmed.');
      current = { turnId: p.turn_id, startedAt: at, state: 'running' };
      if (Date.parse(at) > Date.parse(activatedAt)) ids.add(p.turn_id);
    }
  } finally { stream.destroy(); }
  return { turnIds: [...ids], current, partial };
}
export async function nativeTurnsSince(path, activatedAt) { return (await nativeTurnState(path, activatedAt)).turnIds; }
export const TRANSCRIPT_ADAPTER_VERSION = 1;
export async function parseTranscript(path, activatedAt, startOffset = 0, { allowDelegatedInput = false } = {}) {
  const result = { turns: new Map(), issues: [], bytes: startOffset, nextOffset: startOffset };
  const stream = createReadStream(path, { start: startOffset });
  let active = null, order = startOffset, lineNumber = 0;
  const get = id => result.turns.get(id);
  try {
    for await (const entry of sourceLines(stream, startOffset)) {
      const { line, offset, end, complete } = entry;
      lineNumber++; order = offset; result.bytes = end;
      if (!complete) { result.issues.push({ code: 'TASK_SOURCE_PARTIAL', line: lineNumber }); continue; }
      result.nextOffset = end;
      let row;
      try { row = JSON.parse(line); } catch { result.issues.push({ code: 'TASK_SOURCE_PARTIAL', line: lineNumber }); continue; }
      const p = row.payload ?? {}, at = row.timestamp, event = row.type === 'event_msg';
      if (event && p.type === 'task_started') {
        active = p.turn_id;
        const start = nativeTime(p.started_at, at);
        if (!isToken(active) || !Number.isFinite(Date.parse(start))) fail('TASK_SOURCE_UNSUPPORTED', 'Unknown native turn boundary format.');
        if (isToken(active) && Number.isFinite(Date.parse(start)) && Date.parse(start) > Date.parse(activatedAt) && !get(active))
          result.turns.set(active, { turnId: active, startedAt: start, startOffset: offset, messages: [], outputs: [], questions: new Map(), complete: false, interrupted: false, issues: [],
            delegatedInput: allowDelegatedInput && p.turn_attribution?.turn_trigger === 'app_tool_create_thread' });
        continue;
      }
      if (row.type === 'turn_context' && isToken(p.turn_id)) { active = p.turn_id; continue; }
      const native = p.internal_chat_message_metadata_passthrough?.turn_id ?? row.metadata?.retained_source?.id?.turn_id ?? p.turn_id ?? active;
      const turn = get(native);
      if (!turn) continue; // No reliable new native boundary: never import a historical body.
      if (event && p.type === 'task_complete') { turn.complete = true; turn.completedAt = nativeTime(p.completed_at, at); continue; }
      if (event && ['turn_aborted', 'task_interrupted'].includes(p.type)) { turn.interrupted = true; continue; }
      if (row.type !== 'response_item') continue;
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        const content = visibleContent(p);
        if (!content.length) continue;
        const id = p.id ?? row.metadata?.retained_source?.id?.message_id;
        if (!id) { turn.issues.push({ code: 'TASK_MESSAGE_ID_MISSING', line: lineNumber }); continue; }
        const message = { id, role: p.role, phase: p.phase ?? (p.role === 'user' ? 'input' : 'unknown'),
          at: nativeTime(p.internal_chat_message_metadata_passthrough?.create_time, at), sourceAt: at, order: ++order, content };
        turn.messages.push(message);
      } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
        if (/^(?:.*[._])?request_user_input(?:_async)?$/.test(p.name ?? '')) {
          try { turn.questions.set(p.call_id, { name: p.name, questions: JSON.parse(p.arguments ?? p.input).questions, at, order: ++order }); } catch { turn.issues.push({ code: 'TASK_QUESTION_INVALID' }); }
        }
      } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        // This user-owned native thread receives its initial task as a typed
        // create_thread output. Other tool results and quoted wrappers stay data.
        if (turn.delegatedInput && p.type === 'function_call_output' && p.namespace === 'codex_app' && p.name === 'create_thread' && typeof p.output === 'string') {
          const match = /^\s*<codex_delegation>\s*<source_thread_id>([^<]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/.exec(p.output);
          if (match && isToken(match[1]) && match[2].trim() && p.id) turn.messages.push({ id:p.id, role:'user', phase:'delegated_input',
            at:nativeTime(p.internal_chat_message_metadata_passthrough?.create_time,at), sourceAt:at, order:++order,
            origin:{kind:'codex-app-create-thread',sourceThreadId:match[1]}, content:[{type:'input_text',text:match[2]}] });
        }
        const encoded = typeof p.output === 'string' ? p.output : JSON.stringify(p.output) ?? '';
        if (encoded.includes('KSF_TASK_RECEIPT:')) turn.outputs.push({ output: p.output, at, order: ++order });
        const question = turn.questions.get(p.call_id);
        if (question) {
          let answer;
          try { answer = typeof p.output === 'string' ? JSON.parse(p.output) : p.output; } catch { answer = null; }
          // Async acknowledgements are not human answers; their later user message is authoritative.
          turn.messages.push({ id: `question:${p.call_id}`, role: 'assistant', phase: 'question', at: question.at, order: question.order,
            content: [{ type: 'text', text: JSON.stringify({ questions: question.questions }, null, 2) }] });
          if (answer && (answer.answers || answer.responses)) turn.messages.push({ id: `answer:${p.call_id}`, role: 'user', phase: 'answer', at, order,
            content: [{ type: 'text', text: JSON.stringify(answer.answers ?? answer.responses, null, 2) }] });
        }
      }
    }
  } finally { stream.destroy(); }
  for (const turn of result.turns.values()) {
    const unique = new Map();
    for (const message of turn.messages) {
      const before = unique.get(message.id);
      if (!before) unique.set(message.id, { ...message, sourceVersions: [] });
      else if (messageDigest(before) !== messageDigest(message)) {
        const versions = before.sourceVersions;
        if (!versions.some(v => messageDigest(v) === messageDigest(before))) versions.push({ role: before.role, phase: before.phase, content: before.content, at: before.at, sourceAt: before.sourceAt });
        unique.set(message.id, { ...message, order: before.order, sourceVersions: versions });
      }
    }
    turn.messages = [...unique.values()].sort((a, b) => a.order - b.order);
    turn.issues.push(...result.issues);
    if (!turn.messages.some(m => m.role === 'user')) turn.issues.push({ code: 'TASK_USER_MESSAGE_MISSING' });
  }
  return result;
}
export function messageDigest(message) { return sha256(encode({ role: message.role, phase: message.phase, content: message.content })); }
