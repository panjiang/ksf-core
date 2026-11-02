import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOptions, optionSpecs, hasJsonFlag } from '../shared/options.js';
import { invalid } from '../chat-state/storage.js';
import { enableChat, readChat, readChatContext, mutateChat } from '../services/chat.js';
import { installTaskHooks } from '../services/tasks.js';
import { syncChat } from '../services/chat-sync.js';

export function chatHelp() {
  return `KSF chat\n\nUsage:\n` +
    `  ksf chat hooks [--json]\n` +
    `  ksf chat sync [--json]\n` +
    `  ksf chat read [--object <id>] [--fields <name...>] [--json]\n` +
    `  ksf chat context [--json]\n` +
    `  ksf chat use --object <id> --turn <nativeTurnId> [--dry-run] [--json]\n` +
    `  ksf chat write [--object <id>] (--data <JSON> | --from -|file) --if-match <etag|missing> [--dry-run] [--json]\n` +
    `  ksf chat remove [--object <id>] (--fields <name...> | --all) --if-match <etag|missing> [--dry-run] [--json]\n` +
    `  ksf chat restart --object <id> --turn <nativeTurnId> --if-match <etag|missing> [--dry-run] [--json]\n\n` +
    `Identity comes from CODEX_THREAD_ID, never cwd. Hooks or explicit sync register verified native turns after activation.\n` +
    `Variables are arbitrary runtime JSON keys; no field registration, business schema or implicit inheritance.\n` +
    `Without --object, use shared chat variables. Object scopes use full IDs without @version.\n` +
    `write merges top-level keys; nested values replace whole values, null is a value.\n` +
    `read, context and dry-run do not create chat state. use counts once per object/run/native turn.\n` +
    `restart clears only the selected object's variables and starts its new run at turn 1.\n`;
}
async function input(root, p, supplied) {
  if (p.data !== undefined) {
    if (Buffer.byteLength(p.data) > 1024 * 1024) invalid('Variable input exceeds 1 MiB.');
    try { return JSON.parse(p.data); } catch { invalid('--data must be JSON.'); }
  }
  if (supplied !== undefined) return supplied;
  let bytes;
  if (p.from === '-') {
    if (process.stdin.isTTY) invalid('Supply JSON on stdin.');
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024 * 1024) invalid('Variable input exceeds 1 MiB.'); chunks.push(chunk); }
    bytes = Buffer.concat(chunks);
  } else bytes = readFileSync(resolve(root, p.from));
  if (bytes.length > 1024 * 1024) invalid('Variable input exceeds 1 MiB.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid('Variable input must be UTF-8 JSON.'); }
}
export async function runChatCommand(args, root, { env = process.env, stdin } = {}) {
  const operation = args[0], json = hasJsonFlag(args), response = { ok: false, command: 'chat', operation, data: null, errors: [] };
  let exitCode = 0;
  try {
    if (!args.length || args.length === 1 && ['--help', '-h'].includes(operation)) return { stdout: chatHelp(), exitCode: 0 };
    const names = { hooks: [], sync: [], context: [], read: ['object', 'fields'], use: ['object', 'turn', 'dry-run'], write: ['object', 'data', 'from', 'if-match', 'dry-run'], remove: ['object', 'fields', 'all', 'if-match', 'dry-run'], restart: ['object', 'turn', 'if-match', 'dry-run'] }[operation];
    if (!names) invalid('Unknown chat operation.');
    const p = {};
    const seen = parseOptions(args.slice(1), { result: p, options: optionSpecs([...names, 'json', 'help'], {
      fields: { kind: 'many', unique: true, missing: '--fields requires at least one key.' }, all: { kind: 'flag' }, from: { kind: 'value', allowDash: true },
    }), target() { invalid('chat does not accept positional arguments.'); }, invalid });
    if (p.help) { if (seen.size !== 1) invalid('Use --help alone.'); return { stdout: chatHelp(), exitCode: 0 }; }
    if (operation === 'hooks') {
      const hooks = installTaskHooks({ root, capture: false });
      const config = enableChat({ root });
      response.data = { ...config, hookConfigured: hooks.hookConfigured, trust: hooks.trust };
    } else if (operation === 'sync') response.data = await syncChat({root,env});
    else if (operation === 'read') response.data = readChat({ root, env, objectId: p.object, fields: p.fields });
    else if (operation === 'context') response.data = readChatContext({ root, env });
    else {
      if (operation === 'write' && Number(p.data !== undefined) + Number(p.from !== undefined) !== 1) invalid('Choose exactly one of --data or --from.');
      response.data = mutateChat({ root, env, operation, objectId: p.object, turnId: p.turn, values: operation === 'write' ? await input(root, p, stdin) : undefined,
        fields: p.fields, all: p.all, ifMatch: p.ifMatch, dryRun: p.dryRun });
    }
    response.ok = true;
  } catch (error) {
    response.errors.push({ code: error.code ?? 'CHAT_FAILED', message: error.code ? error.message : 'Chat operation failed; inspect local data.' });
    exitCode = error.exitCode ?? 1;
  }
  return { stdout: JSON.stringify(json ? response : response.ok ? response.data : response, null, json ? undefined : 2) + '\n', exitCode };
}
