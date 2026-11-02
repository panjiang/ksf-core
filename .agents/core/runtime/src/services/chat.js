import { randomUUID } from 'node:crypto';
import { hostIdentity, sessionKey } from '../routing/storage.js';
import { isToken } from '../routing/schema.js';
import { CONFIG, snapshot, abilitySnapshots, turnsPath, location, locked, expect, publish, encode, validate, values as validateValues, invalid, fail } from '../chat-state/storage.js';
import { packChatContext, MAX_CONTEXT_SCAN } from '../chat-state/context.js';

export const chatConfig = root => snapshot(root, CONFIG, 'config').document;
export function enableChat({ root, at = new Date().toISOString() }) {
  if (!Number.isFinite(Date.parse(at))) invalid('Invalid activation time.');
  return locked(root, 'configuration', () => {
    const before = snapshot(root, CONFIG, 'config');
    sessionKey(root, { host: 'codex', sessionId: 'identity-initialization' }, true);
    const next = before.document ? { ...before.document, enabled: true } : { schemaVersion: 1, kind: 'config', enabled: true, activatedAt: at };
    if (encode(next) !== encode(before.document)) publish(root, before, next, 'config');
    return next;
  });
}
function identityKey(root, env, identity) {
  let native;
  try { native = hostIdentity(identity, env); } catch (error) {
    if (error.code === 'ROUTE_IDENTITY_REQUIRED') fail('CHAT_IDENTITY_REQUIRED', 'A native chat identity is required; cwd is not an identity.');
    throw error;
  }
  if (native.host !== 'codex') fail('CHAT_HOST_UNSUPPORTED', 'Automatic chat tracking currently supports Codex.');
  return sessionKey(root, native);
}
function ledger(root, key) { return key ? snapshot(root, turnsPath(key), 'turns', key) : { etag: 'missing', document: null }; }
function current(root, key) {
  const record = ledger(root, key);
  if (!record.document) fail('CHAT_TURN_UNAVAILABLE', 'No native turn is registered. Enable chat hooks and start a new native turn.');
  return record;
}
// Called by native Hooks or explicit verified source sync, never by reads or variable writes.
export function registerChatTurn({ root, identity, turnId, observedTurnIds = [], countingSince }) {
  if (!isToken(turnId)) invalid('Supply a valid native turnId.');
  if (!Array.isArray(observedTurnIds) || observedTurnIds.some(id => !isToken(id))) invalid('Invalid observed native turn identities.');
  const config = chatConfig(root);
  if (!config?.enabled) return { skipped: true, reason: 'disabled' };
  const baseline = countingSince ?? config.activatedAt;
  if (!Number.isFinite(Date.parse(baseline)) || Date.parse(baseline) < Date.parse(config.activatedAt)) invalid('Invalid chat counting baseline.');
  const key = identityKey(root, {}, identity);
  if (!key) fail('CHAT_IDENTITY_REQUIRED', 'Chat identity is not initialized.');
  return locked(root, key, () => {
    const before = ledger(root, key);
    if (before.document && Date.parse(before.document.countingSince) !== Date.parse(baseline)) fail('CHAT_SOURCE_IDENTITY', 'The chat creation baseline changed; preserve the existing ledger.');
    const next = before.document ? structuredClone(before.document) : { schemaVersion: 1, kind: 'turns', chatId: key, revision: 0, host: 'codex', countingSince: baseline, turnIds: [] };
    const replayed = next.turnIds.includes(turnId), previous = [...next.turnIds];
    if (replayed && previous.at(-1) !== turnId) return { chatId: key, turnId, chatTurnNumber: previous.indexOf(turnId) + 1, countingSince: next.countingSince, replayed: true };
    // Insert missing boundaries relative to surviving source anchors. A compacted
    // source may omit old IDs, so never discard or reorder the retained ledger.
    let anchor = replayed ? turnId : null;
    for (const id of [...new Set(observedTurnIds)].reverse()) {
      if (!next.turnIds.includes(id)) { const at = anchor === null ? next.turnIds.length : next.turnIds.indexOf(anchor); next.turnIds.splice(at, 0, id); }
      anchor = id;
    }
    if (!replayed) next.turnIds.push(turnId);
    // Current native ID may already have been added by source reconciliation.
    next.turnIds = [...new Set(next.turnIds)];
    if (encode(previous) !== encode(next.turnIds)) { next.revision++; publish(root, before, next, 'turns', key); }
    return { chatId: key, turnId, chatTurnNumber: next.turnIds.indexOf(turnId) + 1, countingSince: next.countingSince, replayed };
  });
}
function scope(root, key, objectId) { return snapshot(root, location(key, objectId), 'scope', key, objectId); }
function validateParticipation(turns, before) {
  const used = before?.document?.turnIds ?? [], known = turns.document?.turnIds ?? [];
  let last = -1;
  for (const id of used) { const index = known.indexOf(id); if (index <= last) fail('CHAT_DATA_INVALID', 'Capability participation does not match the native turn ledger.'); last = index; }
}
function view(root, key, turns, before, objectId, fields) {
  const d = before?.document, t = turns.document, variables = d?.values ?? {};
  const selected = fields ? Object.fromEntries(fields.filter(k => Object.hasOwn(variables, k)).map(k => [k, variables[k]])) : variables;
  return { state: d ? 'present' : 'missing', path: key ? location(key, objectId) : null, etag: before?.etag ?? 'missing', schemaVersion: 1, revision: d?.revision ?? null,
    system: { chatId: key, trackingEnabled: chatConfig(root)?.enabled ?? false, turnId: t?.turnIds.at(-1) ?? null, chatTurnNumber: t?.turnIds.length ?? null, countingSince: t?.countingSince ?? null,
      ...(objectId !== undefined ? { objectId, runId: d?.runId ?? null, abilityTurnNumber: d?.turnIds.length ?? 0, participatedInCurrentTurn: Boolean(t && d?.turnIds.includes(t.turnIds.at(-1))) } : {}) },
    values: selected, ...(fields ? { missingFields: fields.filter(k => !Object.hasOwn(variables, k)) } : {}) };
}
export function readChat({ root, env = process.env, identity, objectId, fields }) {
  if (fields && (!Array.isArray(fields) || !fields.length || fields.some(k => typeof k !== 'string'))) invalid('Supply variable field names.');
  // Validate IDs even when the chat does not yet have an identity key.
  location('0'.repeat(64), objectId);
  const key = identityKey(root, env, identity), turns = ledger(root, key), before = key ? scope(root, key, objectId) : null;
  validateParticipation(turns, before);
  if (key && ledger(root, key).etag !== turns.etag) fail('CHAT_CONFLICT', 'The native turn changed during read; retry.');
  return view(root, key, turns, before, objectId, fields);
}
export function readChatContext({ root, env = process.env, identity }) {
  const key = identityKey(root, env, identity), turns = ledger(root, key);
  const shared = view(root, key, turns, key ? scope(root, key) : null);
  const known = turns.document?.turnIds ?? [], active = known.length - 1;
  const order = new Map(known.map((id, i) => [id, i])), issues = [], valid = [];
  if (key && known.length) {
    try {
      const discovered = abilitySnapshots(root, key, MAX_CONTEXT_SCAN); issues.push(...discovered.issues);
      for (const record of discovered.records) {
        try { validateParticipation(turns, record.before); valid.push(record); }
        catch (error) { issues.push({ code: error.code ?? 'CHAT_CONTEXT_UNAVAILABLE', objectId: record.objectId }); }
      }
    } catch (error) { issues.push({ code: error.code ?? 'CHAT_CONTEXT_UNAVAILABLE' }); }
  }
  // Resume the latest explicitly participating set, even after a read-only or
  // interrupted turn with no adoption. Include current adoptions on Hook replay.
  let prior = -1;
  for (const { before } of valid) for (const id of before.document.turnIds) {
    const index = order.get(id); if (index < active && index > prior) prior = index;
  }
  const selected = valid.filter(({ before }) => before.document.turnIds.some(id =>
    (prior >= 0 && order.get(id) === prior) || order.get(id) === active)).sort((a, b) => a.objectId.localeCompare(b.objectId));
  if (key && ledger(root, key).etag !== turns.etag) fail('CHAT_CONFLICT', 'The native turn changed during context assembly; retry.');
  return packChatContext({ shared, abilities: selected.map(({ objectId, before }) => view(root, key, turns, before, objectId)),
    ledgerVersion: { schemaVersion: 1, revision: turns.document?.revision ?? null, etag: turns.etag },
    lastParticipatingTurnId: prior >= 0 ? known[prior] : selected.length ? known[active] : null, issues });
}
export function mutateChat({ root, env = process.env, identity, objectId, operation, turnId, values, fields, all, ifMatch, dryRun = false, beforePublish }) {
  location('0'.repeat(64), objectId);
  if (!['use', 'restart', 'write', 'remove'].includes(operation)) invalid('Unknown chat mutation.');
  if (['use', 'restart'].includes(operation) && (objectId === undefined || !isToken(turnId))) invalid('Supply --object and the current native --turn.');
  if (operation === 'write') validateValues(values);
  if (operation === 'remove' && (Boolean(all) === Boolean(fields) || fields && (!Array.isArray(fields) || !fields.length || fields.some(k => typeof k !== 'string')))) invalid('Choose --fields or --all.');
  if (operation !== 'use') expect({ etag: ifMatch }, ifMatch);
  const key = identityKey(root, env, identity);
  if (!key) fail('CHAT_TURN_UNAVAILABLE', 'No chat turn is registered.');
  const perform = () => {
    const turns = current(root, key), active = turns.document.turnIds.at(-1), before = scope(root, key, objectId);
    validateParticipation(turns, before);
    if (['use', 'restart'].includes(operation) && turnId !== active) fail('CHAT_TURN_CONFLICT', 'Only the current registered native turn can participate or restart.');
    if (operation !== 'use') expect(before, ifMatch);
    const old = before.document;
    const next = old ? structuredClone(old) : { schemaVersion: 1, kind: 'scope', chatId: key, objectId: objectId ?? null, revision: 0, runId: objectId === undefined ? null : randomUUID(), turnIds: [], values: {} };
    let removedFields;
    if (operation === 'use' && !next.turnIds.includes(turnId)) next.turnIds.push(turnId);
    if (operation === 'restart') { next.runId = randomUUID(); next.turnIds = [turnId]; next.values = {}; }
    if (operation === 'write') next.values = { ...next.values, ...values };
    if (operation === 'remove') {
      removedFields = (all ? Object.keys(next.values) : fields).filter(k => Object.hasOwn(next.values, k));
      for (const field of removedFields) delete next.values[field];
    }
    const changed = old ? encode(old) !== encode(next) : operation !== 'remove';
    let etag = before.etag;
    if (changed) {
      next.revision++;
      validate(next, 'scope', key, objectId);
      // Check capacity during previews too, without preparing directories or locks.
      if (Buffer.byteLength(encode(next)) > 1024 * 1024) fail('CHAT_CAPACITY', 'Chat scope exceeds 1 MiB.');
      if (!dryRun) etag = publish(root, before, next, 'scope', key, objectId, beforePublish);
    }
    return { ...view(root, key, turns, changed ? { ...before, document: next, etag } : before, objectId), dryRun, changed: changed && !dryRun, wouldChange: changed, beforeEtag: before.etag,
      ...(removedFields ? { removedFields, missingFields: all ? [] : fields.filter(k => !removedFields.includes(k)) } : {}) };
  };
  return dryRun ? perform() : locked(root, key, perform);
}
