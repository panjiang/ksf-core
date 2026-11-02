import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostIdentity } from '../routing/storage.js';
import { fail } from '../chat-state/storage.js';
import { discover, sourceMeta, belongsToRoot, isInternalSession, nativeTurnState } from '../task-capture/codex.js';
import { chatConfig, registerChatTurn, readChatContext } from './chat.js';

// Explicit metadata reconciliation for native triggers that do not emit Hooks.
// Reads/context and capability use never silently create a native ledger.
export async function syncChat({ root, env = process.env }) {
  const config = chatConfig(root);
  if (!config?.enabled) return { skipped:true, reason:'disabled' };
  let identity;
  try { identity = hostIdentity(undefined,env); }
  catch { fail('CHAT_IDENTITY_REQUIRED','A native chat identity is required; cwd is not an identity.'); }
  if (identity.host !== 'codex') fail('CHAT_HOST_UNSUPPORTED','Native source reconciliation currently supports Codex.');
  const paths = discover(env.CODEX_HOME || join(homedir(),'.codex')).filter(path=>path.endsWith('-'+identity.sessionId+'.jsonl'));
  if (paths.length !== 1) fail(paths.length?'CHAT_SOURCE_AMBIGUOUS':'CHAT_SOURCE_UNAVAILABLE','Cannot uniquely locate this native chat source; preserve existing state.');
  const path = paths[0], before = sourceMeta(path), meta = before.meta;
  if (meta.id !== identity.sessionId || !belongsToRoot(meta,root) || isInternalSession(meta)) fail('CHAT_SOURCE_IDENTITY','Native session and workspace identity do not match.');
  const activated = Date.parse(config.activatedAt), created = Date.parse(meta.timestamp);
  if (meta.parent_thread_id && !Number.isFinite(created)) fail('CHAT_SOURCE_UNSUPPORTED','A fork needs a reliable native creation timestamp.');
  const countingSince = new Date(Math.max(activated,Number.isFinite(created)?created:activated)).toISOString();
  const observed = await nativeTurnState(path,countingSince), after = sourceMeta(path);
  if (after.meta.id !== meta.id || after.stat.ino !== before.stat.ino || after.stat.dev !== before.stat.dev || after.stat.size < before.stat.size) fail('CHAT_SOURCE_IDENTITY','Native source changed identity while reading.');
  if (observed.partial) fail('CHAT_SOURCE_PARTIAL','Native source is being written; retry this explicit synchronization.');
  if (observed.current?.state !== 'running' || !observed.turnIds.includes(observed.current.turnId)) fail('CHAT_TURN_UNAVAILABLE','No active post-baseline native boundary is confirmed.');
  const registered = registerChatTurn({root,identity,turnId:observed.current.turnId,observedTurnIds:observed.turnIds,countingSince});
  const context = readChatContext({root,identity});
  if (context.system.turnId !== registered.turnId) fail('CHAT_TURN_CONFLICT','A newer native turn is registered; read the current state.');
  return { skipped:false, registration:'native-transcript', registered, context };
}
