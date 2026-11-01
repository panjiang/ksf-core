import {platform,gitExecutable} from '../platform/index.js';
import { createGitSettings, configurationActions, redactConfiguration } from './git-settings.js';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, join, relative, dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, assert, problem } from './workbench-common.js';
import { filePolicy } from './workspace-files.js';

const SKIP = new Set(['.git', 'node_modules', '.cache', '.venv', 'dist', 'build', 'target', '__pycache__']);
const binary = gitExecutable;
const safeRef = value => typeof value === 'string' && value.length <= 1024 && value.length > 0 && !value.startsWith('-') && !/[\x00-\x20\x7f]/.test(value);
function envForGit() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|SHALLOW_FILE|NAMESPACE|CONFIG.*|.*PATHSPECS)$/.test(key)) delete env[key];
  return env;
}
export async function runGit(path, args, { input, allowFailure = false, timeout = 30000, onProgress } = {}) {
  return new Promise((resolveResult, reject) => {
    // stash passes internally generated pathspecs to clean. Propagating literal
    // pathspecs breaks its untracked-file cleanup (notably for quoted names).
    // Our stash commands accept only validated refs, never user pathspecs.
    const child = spawn(binary, ['--no-replace-objects', ...(args[0] === 'stash' ? [] : ['--literal-pathspecs']), '-c', 'core.fsmonitor=false', '-C', path, ...args], { env: envForGit(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: platform.detachedChildren });
    const stdout = [], stderr = []; let size = 0, timedOut = false, overflow = false;
    const terminate = signal => { try { if (child.pid && child.exitCode === null && child.signalCode === null) platform.terminate(child, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const timer = setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, timeout);
    const killTimer = setTimeout(() => { if (timedOut || overflow) { terminate('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); } }, timeout + 2000);
    const capture = (chunks, bytes) => { size += bytes.length; if (size > 16 * 1024 * 1024) { overflow = true; terminate('SIGTERM'); } else chunks.push(bytes); };
    child.stdout.on('data', bytes => capture(stdout, bytes));
    child.stderr.on('data', bytes => { capture(stderr, bytes); onProgress?.(bytes.toString('utf8')); });
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(problem(error.code === 'ENOENT' ? 'GIT_REQUIRED' : 'GIT_START_FAILED', error.code === 'ENOENT' ? '请先安装本机 Git。' : 'Git 无法启动。', 503)); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      const result = { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (timedOut || overflow) reject(problem(timedOut ? 'GIT_TIMEOUT' : 'GIT_OUTPUT_LIMIT', timedOut ? 'Git 操作超时，结果需要重新核对，请勿直接重复执行。' : '输出过大，请缩小查询范围。', 504));
      else if (code !== 0 && !allowFailure) reject(problem('GIT_FAILED', redact(result.stderr.trim() || 'Git 操作失败。'), 409));
      else resolveResult(result);
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const redact = value => redactConfiguration(value).replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@').replace(/([?&](?:access_token|token|password|secret)=)[^\s&]+/gi, '$1[redacted]').slice(-16000);
export function parseStatus(raw) {
  const records = raw.split('\0'), entries = [], branch = { name: null, oid: null, upstream: null, ahead: 0, behind: 0 };
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.startsWith('# ')) {
      const space = row.indexOf(' ', 2), key = row.slice(2, space), value = row.slice(space + 1);
      if (key === 'branch.head') branch.name = value === '(detached)' ? null : value;
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value;
      if (key === 'branch.upstream') branch.upstream = value;
      if (key === 'branch.ab') { const numbers = value.match(/\+(\d+) -(\d+)/); if (numbers) { branch.ahead = +numbers[1]; branch.behind = +numbers[2]; } }
    } else if (/^[12u] /.test(row)) {
      const count = row[0] === '1' ? 8 : row[0] === '2' ? 9 : 10;
      const fields = row.split(' '), path = fields.slice(count).join(' '), xy = fields[1];
      entries.push({ path, originalPath: row[0] === '2' ? records[++i] : null, index: xy[0], worktree: xy[1], conflict: row[0] === 'u', untracked: false });
    } else if (row.startsWith('? ')) entries.push({ path: row.slice(2), originalPath: null, index: '?', worktree: '?', conflict: false, untracked: true });
  }
  return { branch, entries };
}
export function splitHunks(patch) {
  const lines = patch.split('\n'), first = lines.findIndex(line => line.startsWith('@@ '));
  if (first < 0 || patch.includes('GIT binary patch') || patch.includes('Binary files ')) return [];
  const header = lines.slice(0, first).join('\n') + '\n', chunks = [];
  for (let start = first; start < lines.length;) {
    let end = start + 1; while (end < lines.length && !lines[end].startsWith('@@ ')) end++;
    const text = lines.slice(start, end).join('\n').replace(/\n*$/, '\n');
    chunks.push({ id: digest(header + text), header: lines[start], patch: header + text, text }); start = end;
  }
  return chunks;
}
export async function createPersistedWorkbenchGit(root, files, coordinator, storage) {
  const caller = {appId: 'com.ksf.git'}, name = 'operations.json', scope = {scope: 'runtime'};
  const current = await storage.read(caller, name, scope);
  const record = current.exists ? current : await storage.read(caller, name);
  let ledger = [];
  if (record.exists) {
    try { ledger = JSON.parse(record.text); }
    catch { throw problem('APP_DATA_INVALID', 'Git 操作记录无效，请保留原件。'); }
    assert(Array.isArray(ledger), 'APP_DATA_INVALID', 'Git 操作记录无效，请保留原件。');
    // Preserve the old user-data record, but never mutate the repository while
    // recording an operation: its own receipt must not invalidate the Git CAS.
    if (!current.exists) await storage.write(caller, name, record.text, {...scope, ifMatch: null});
  }
  return createWorkbenchGit(root, files, coordinator, {
    ledger, persist: value => storage.write(caller, name, JSON.stringify(value), scope),
  });
}
export function createWorkbenchGit(root, files, coordinator, { command = runGit, now = Date.now, ledger = [], persist = async () => {} } = {}) {
  root = files.root;
  const repositories = new Map(), snapshots = new Map(), operations = new Map(), requests = new Map(), summaries = new Map();
  for(const item of ledger){if(!item?.operation?.id||!item.requestId)continue;const operation=item.operation;if(['queued','running'].includes(operation.status)){operation.status='failed';operation.error={code:'GIT_OPERATION_INTERRUPTED',message:'服务中断，请先核对仓库结果。',uncertain:true};}operations.set(operation.id,operation);requests.set(item.requestId,{id:operation.id,fingerprint:item.fingerprint});}
  const checkpoint=()=>persist([...requests].map(([requestId,item])=>({requestId,fingerprint:item.fingerprint,operation:operations.get(item.id)})));
  const summaryEpochs = new Map(), summaryQueue = new Set(), summaryJobs = new Map();
  const operationJobs = new Set();
  const summaryTTL = 30000, discoveryTTL = 60000;
  let scanPromise, scanAt = -Infinity, scanErrors = [], scanning = false, closed = false;
  const epoch = id => summaryEpochs.get(id) ?? 0;
  const fresh = (id, cached) => cached && cached.epoch === epoch(id) && now() - cached.at < summaryTTL;
  function publishSummary(id, expected, state, error = null) {
    if (epoch(id) !== expected || !repositories.has(id)) return;
    const next = expected + 1; summaryEpochs.set(id, next);
    summaries.set(id, { at: now(), epoch: next, state, error });
  }
  function pumpSummaries() {
    if (closed) return;
    for (const id of summaryQueue) {
      if (summaryJobs.size >= 4) break;
      summaryQueue.delete(id);
      if (!repositories.has(id) || fresh(id, summaries.get(id))) continue;
      const expected = epoch(id);
      const job = Promise.resolve().then(() => status(id, true)).catch(error => {
        publishSummary(id, expected, summaries.get(id)?.state ?? {}, redact(error.message));
      }).finally(() => { summaryJobs.delete(id); pumpSummaries(); });
      summaryJobs.set(id, job);
    }
  }
  function invalidate(...paths) {
    const affected = paths.length ? new Set(paths.map(path => [...repositories.values()].filter(repo => repo.path === '.' || path === repo.path || path.startsWith(repo.path + '/')).sort((a, b) => b.path.length - a.path.length)[0]?.id)) : new Set(repositories.keys());
    for (const id of affected) if (id) summaryEpochs.set(id, epoch(id) + 1);
  }
  const display = path => relative(root, path).split(sep).join('/') || '.';
  async function register(path, kind = 'repository') {
    const rel = display(path);
    if (rel !== '.') await files.locate(rel, { content: false });
    const result = await command(path, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (result.code !== 0) { if (rel === '.') repositories.set(digest(rel), { id: digest(rel), name: 'KSF 实例', path: '.', absolute: root, kind: 'instance', worktree: false, valid: false, lastFetchedAt: null }); return; }
    if (await fs.realpath(result.stdout.trimEnd()) !== await fs.realpath(path)) return;
    const id = digest(rel), existing = repositories.get(id);
    const gitDir = await command(path, ['rev-parse', '--absolute-git-dir']);
    const common = await command(path, ['rev-parse', '--git-common-dir']);
    const parent = await command(path, ['rev-parse', '--show-superproject-working-tree']);
    repositories.set(id, { id, name: rel === '.' ? 'KSF 实例' : path.split(sep).at(-1), path: rel, absolute: path, kind: rel === '.' ? 'instance' : parent.stdout.trim() ? 'submodule' : kind, parentPath: parent.stdout.trim() ? display(parent.stdout.trimEnd()) : null, worktree: await fs.realpath(resolve(path, common.stdout.trimEnd())) !== await fs.realpath(gitDir.stdout.trimEnd()), valid: true, lastFetchedAt: existing?.lastFetchedAt ?? null });
  }
  async function scan(force = false) {
    if (scanPromise) return scanPromise;
    if (!force && now() - scanAt < discoveryTTL && repositories.size) return;
    scanning = true;
    scanPromise = (async () => {
      scanErrors = []; const seen = new Set(); let visited = 0;
      const collect = async (path, kind) => { try { await register(path, kind); seen.add(digest(display(path))); } catch (error) { scanErrors.push({ path: display(path), message: redact(error.message) }); } };
      await collect(root, 'instance');
      async function walk(path) {
        if (++visited > 50000) { if (!scanErrors.some(e => e.path === 'repositories')) scanErrors.push({ path: 'repositories', message: '扫描达到目录上限，请缩小工程容器。' }); return; }
        const entries = await fs.readdir(path, { withFileTypes: true });
        if (entries.some(e => e.name === '.git')) await collect(path, 'repository');
        for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.has(entry.name)) await walk(join(path, entry.name)).catch(error => scanErrors.push({ path: display(join(path, entry.name)), message: error.code ?? '目录无法读取' }));
      }
      try { await files.locate('repositories', { content: false }); await walk(join(root, 'repositories')); } catch (error) { if (error.code !== 'ENOENT') scanErrors.push({ path: 'repositories', message: error.message }); }
      for (const id of repositories.keys()) if (!seen.has(id)) { repositories.delete(id); summaries.delete(id); summaryQueue.delete(id); summaryEpochs.set(id, epoch(id) + 1); }
      scanAt = now();
    })().finally(() => { scanning = false; scanPromise = null; });
    return scanPromise;
  }
  async function get(id) {
    if (!repositories.has(id)) await scan();
    const repo = repositories.get(id); assert(repo, 'GIT_REPOSITORY_UNKNOWN', '仓库不存在，请刷新目录。', 404);
    assert(repo.valid, 'GIT_REPOSITORY_UNINITIALIZED', '此 KSF 实例是普通文件夹，尚未初始化 Git。', 409);
    if (repo.path !== '.') await files.locate(repo.path, { content: false });
    // Recheck the actual root; a removed child must not inherit its parent KSF.
    const top = await command(repo.absolute, ['rev-parse', '--show-toplevel']);
    assert(await fs.realpath(top.stdout.trimEnd()) === await fs.realpath(repo.absolute), 'GIT_ROOT_CHANGED', '仓库根已变化，请重新发现。', 409);
    return repo;
  }
  async function status(id, summaryOnly = false) {
    const expected = epoch(id), repo = await get(id), result = await command(repo.absolute, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
    const parsed = parseStatus(result.stdout);
    if (summaryOnly) {
      // A catalog row needs counts and branch metadata, not index bytes, file
      // stamps, merge state or remotes. Keep exact counts, including submodules.
      const cached = summaries.get(id)?.state;
      const recent = parsed.branch.oid && cached?.branch?.oid !== parsed.branch.oid ? await command(repo.absolute, ['log', '-1', '--format=%h%x00%s%x00%aI'], { allowFailure: true }) : null;
      const summary = { branch: parsed.branch, changedCount: parsed.entries.length, conflictCount: parsed.entries.filter(e => e.conflict).length,
        latestCommit: parsed.branch.oid ? recent ? recent.code === 0 ? recent.stdout.trimEnd().split('\0') : null : cached?.latestCommit ?? null : null, lastFetchedAt: repo.lastFetchedAt };
      publishSummary(id, expected, summary);
      return summary;
    }
    const indexPath = summaryOnly ? null : (await command(repo.absolute, ['rev-parse', '--git-path', 'index'])).stdout.trimEnd();
    const index = indexPath ? await fs.readFile(resolve(repo.absolute, indexPath)).catch(e => { if (e.code === 'ENOENT') return Buffer.alloc(0); throw e; }) : Buffer.alloc(0);
    const stamps = summaryOnly ? [] : await Promise.all(parsed.entries.map(async entry => { try { const s = await fs.lstat(join(repo.absolute, entry.path)); return [entry.path, s.size, s.mtimeMs, s.ctimeMs, s.ino]; } catch { return [entry.path, 'missing']; } }));
    const merging = (await command(repo.absolute, ['rev-parse', '--verify', 'MERGE_HEAD'], { allowFailure: true })).code === 0;
    const recent = await command(repo.absolute, ['log', '-1', '--format=%h%x00%s%x00%aI'], { allowFailure: true });
    const remotes = await command(repo.absolute, ['remote']);
    const state = { ...parsed, version: digest(JSON.stringify([result.stdout, digest(index), stamps])), merging, remotes: remotes.stdout.trim().split('\n').filter(Boolean), lastFetchedAt: repo.lastFetchedAt,
      latestCommit: recent.code === 0 ? recent.stdout.trimEnd().split('\0') : null, changedCount: parsed.entries.length, conflictCount: parsed.entries.filter(e => e.conflict).length };
    const { entries, ...summary } = state;
    publishSummary(id, expected, summary); return state;
  }
  async function list({ refresh = false } = {}) {
    // Never wait for status here: one slow submodule must not hide every repo.
    if (refresh) invalidate();
    if (!closed && !scanPromise && (refresh || now() - scanAt >= discoveryTTL)) void scan(refresh);
    const source = [...repositories.values()];
    for (const repo of source) if (repo.valid && !fresh(repo.id, summaries.get(repo.id)) && !summaryJobs.has(repo.id)) summaryQueue.add(repo.id);
    pumpSummaries();
    const items = source.map(({ absolute, ...repo }) => {
      const cached = summaries.get(repo.id), error = repo.valid ? cached?.error ?? null : '此 KSF 实例尚未初始化 Git。';
      return { ...repo, ...cached?.state, error, statusState: error ? 'error' : !cached ? 'pending' : fresh(repo.id, cached) ? 'ready' : 'stale', statusUpdatedAt: cached ? new Date(cached.at).toISOString() : null };
    });
    return { repositories: items.sort((a, b) => a.kind === 'instance' ? -1 : b.kind === 'instance' ? 1 : a.name.localeCompare(b.name)), scanning, refreshing: summaryJobs.size > 0 || summaryQueue.size > 0, pendingCount: summaryJobs.size + summaryQueue.size, errors: scanErrors };
  }
  async function checkedPath(repo, path, { missing = true } = {}) {
    assert(typeof path === 'string' && path && !path.startsWith('/') && !path.split('/').includes('..') && !/[\\\x00-\x1f\x7f]/.test(path), 'GIT_PATH_INVALID', '请选择仓库内的文件。');
    const workspacePath = repo.path === '.' ? path : `${repo.path}/${path}`;
    // Deleted files are valid paths, but every surviving ancestor must be safe.
    await files.locate(workspacePath, { missing, missingParents: missing });
    return workspacePath;
  }
  async function resolveCommit(repo, rev = 'HEAD') {
    assert(safeRef(rev), 'GIT_REF_INVALID', '无效的版本引用。');
    const result = await command(repo.absolute, ['rev-parse', '--verify', `${rev}^{commit}`]);
    return result.stdout.trim();
  }
  async function diff(id, { path, staged = false, rev, baseRev } = {}) {
    const repo = await get(id), workspacePath = await checkedPath(repo, path), current = await status(id);
    const entry = current.entries.find(e => e.path === path), historical = rev ? await resolveCommit(repo, rev) : null;
    let patch = '', before = '', after = '', binaryFile = false;
    const blob = async spec => {
      const result = await command(repo.absolute, ['show', spec], { allowFailure: true });
      return result.code === 0 ? result.stdout : '';
    };
    if (historical) {
      const parent = baseRev ? { code: 0, stdout: await resolveCommit(repo, baseRev) } : await command(repo.absolute, ['rev-parse', `${historical}^`], { allowFailure: true });
      before = parent.code === 0 ? await blob(`${parent.stdout.trim()}:${path}`) : '';
      after = await blob(`${historical}:${path}`);
      patch = (await command(repo.absolute, parent.code === 0 ? ['diff', '--no-ext-diff', '--no-textconv', parent.stdout.trim(), historical, '--', path] : ['show', '--format=', '--no-ext-diff', '--no-textconv', historical, '--', path])).stdout;
    } else {
      before = await blob(staged ? `HEAD:${entry?.originalPath ?? path}` : `:${path}`);
      if (staged) after = await blob(`:${path}`);
      else try { after = (await files.read(workspacePath)).text; } catch (error) { if (error.code === 'WORKSPACE_BINARY' || error.code === 'WORKSPACE_TOO_LARGE') binaryFile = true; else if (error.code !== 'ENOENT') throw error; }
      if (!entry?.untracked) patch = (await command(repo.absolute, ['diff', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : []), '--', path])).stdout;
    }
    binaryFile ||= before.includes('\0') || after.includes('\0') || patch.includes('Binary files ');
    const hunks = !historical && !binaryFile && entry && !entry.untracked && !entry.conflict && !entry.originalPath && entry.index !== 'A' && entry.worktree !== 'D' && entry.index !== 'D' ? splitHunks(patch) : [];
    const snapshotId = randomUUID(); snapshots.set(snapshotId, { id, path, staged, version: current.version, hunks, at: Date.now() });
    if (snapshots.size > 120) snapshots.delete(snapshots.keys().next().value);
    return { path, workspacePath, version: current.version, snapshotId, staged, historical: !!historical, patch, before: binaryFile ? '' : before, after: binaryFile ? '' : after, binary: binaryFile, hunks: hunks.map(({ patch, ...h }) => h) };
  }
  async function history(id, { path, offset = 0, rev, q = '', author = '' } = {}) {
    const repo = await get(id); assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000, 'GIT_PAGE_INVALID', '无效的历史页。');
    assert(typeof q === 'string' && q.length <= 1000 && typeof author === 'string' && author.length <= 1000, 'GIT_SEARCH_INVALID', '历史搜索条件过长。');
    if (path) await checkedPath(repo, path);
    const head = await command(repo.absolute, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    if (rev === 'HEAD' && head.code !== 0 && !(await status(id)).branch.oid) return { commits: [], offset, nextOffset: null };
    const refs = rev ? [await resolveCommit(repo, rev)] : ['--branches', '--remotes', '--tags', ...(head.code === 0 ? ['HEAD'] : [])];
    const result = await command(repo.absolute, ['log', ...refs, '--topo-order', '--date=iso-strict', `--skip=${offset}`, '-n', '101', '--regexp-ignore-case', '--fixed-strings', ...(q ? [`--grep=${q}`] : []), ...(author ? [`--author=${author}`] : []), '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D%x00', ...(path ? ['--follow', '--', path] : [])], { allowFailure: true });
    if (result.code !== 0) { const s = await status(id); if (!s.branch.oid) return { commits: [], nextOffset: null }; throw problem('GIT_HISTORY_FAILED', redact(result.stderr), 409); }
    const values = result.stdout.split('\0'), commits = [];
    for (let i = 0; i + 5 < values.length; i += 6) commits.push({ oid: values[i].trim(), parents: values[i + 1].split(' ').filter(Boolean), author: values[i + 2], at: values[i + 3], subject: values[i + 4], refs: values[i + 5] });
    return { commits: commits.slice(0, 100), offset, nextOffset: commits.length > 100 ? offset + 100 : null };
  }
  async function commit(id, rev) {
    const repo = await get(id), oid = await resolveCommit(repo, rev);
    const metadata = await command(repo.absolute, ['show', '-s', '--format=%P%x00%an%x00%ae%x00%aI%x00%cI%x00%B', oid]);
    const [parents, author, email, at, committedAt, message] = metadata.stdout.split('\0');
    // A merge is compared with its first parent, matching the file diff view.
    const changed = await command(repo.absolute, ['diff-tree', '--root', '--no-commit-id', '--name-status', '--no-renames', '-r', '-z', ...(parents ? [parents.split(' ')[0], oid] : [oid])]);
    const values = changed.stdout.split('\0'), files = [];
    for (let i = 0; i + 1 < values.length; i += 2) files.push({ status: values[i], path: values[i + 1] });
    const stats = await command(repo.absolute, ['diff-tree', '--root', '--no-commit-id', '--numstat', '--no-renames', '-r', '-z', ...(parents ? [parents.split(' ')[0], oid] : [oid])]);
    const counts = new Map(stats.stdout.split('\0').filter(Boolean).map(row => { const [added, removed, ...path] = row.split('\t'); return [path.join('\t'), { added: added === '-' ? null : +added, removed: removed === '-' ? null : +removed }]; }));
    return { oid, author, email, at, committedAt, parents: parents.split(' ').filter(Boolean), message, paths: files.map(f => f.path), files: files.map(f => ({ ...f, ...counts.get(f.path) })) };
  }
  async function tree(id, { rev = 'HEAD', path = '' } = {}) {
    const repo = await get(id), oid = await resolveCommit(repo, rev);
    assert(typeof path === 'string' && !path.split('/').includes('..') && !path.startsWith('/') && !/[\x00-\x1f\\]/.test(path), 'GIT_PATH_INVALID', '无效的历史目录。');
    const result = await command(repo.absolute, ['ls-tree', '-z', `${oid}${path ? ':' + path : ''}`]);
    return { rev: oid, path, entries: result.stdout.split('\0').filter(Boolean).map(row => { const tab = row.indexOf('\t'), [mode, type, oid] = row.slice(0, tab).split(' '); return { mode, type, oid, name: row.slice(tab + 1), path: [path, row.slice(tab + 1)].filter(Boolean).join('/') }; }) };
  }
  async function refs(id) {
    const repo = await get(id), branches = await command(repo.absolute, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(refname)%00%(subject)%00%(committerdate:iso-strict)%00%(symref)%00', 'refs/heads', 'refs/remotes', 'refs/tags']);
    const values = branches.stdout.split('\0'), list = [];
    for (let i = 0; i + 7 < values.length; i += 8) if (!values[i + 7]) list.push({ name: values[i].trim(), oid: values[i + 1], upstream: values[i + 2], current: values[i + 3] === '*', fullName: values[i + 4], subject: values[i + 5], at: values[i + 6], kind: values[i + 4].startsWith('refs/heads/') ? 'local' : values[i + 4].startsWith('refs/remotes/') ? 'remote' : 'tag' });
    const stash = await command(repo.absolute, ['stash', 'list', '--format=%gd%x00%H%x00%gs%x00%aI%x00']);
    const sv = stash.stdout.split('\0'), stashes = [];
    for (let i = 0; i + 3 < sv.length; i += 4) stashes.push({ ref: sv[i].trim(), oid: sv[i + 1], subject: sv[i + 2], at: sv[i + 3] });
    return { branches: list, stashes };
  }
  async function conflict(id, path) {
    const repo = await get(id); const workspacePath = await checkedPath(repo, path), current = await status(id);
    assert(current.entries.some(e => e.path === path && e.conflict), 'GIT_NOT_CONFLICTED', '该文件已不再冲突。', 409);
    const stages = await Promise.all([1, 2, 3].map(async n => { const r = await command(repo.absolute, ['show', `:${n}:${path}`], { allowFailure: true }); return { exists: r.code === 0, text: r.code === 0 ? r.stdout : '' }; }));
    assert(!stages.some(s => s.text.includes('\0')), 'GIT_BINARY_CONFLICT', '二进制冲突请使用本机工具解决。', 415);
    let result = '', fileVersion = 'missing'; try { const file = await files.read(workspacePath); result = file.text; fileVersion = file.version; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { path, workspacePath, base: stages[0].text, ours: stages[1].text, theirs: stages[2].text, oursExists: stages[1].exists, theirsExists: stages[2].exists, result, fileVersion, version: current.version };
  }
  async function stashDetail(id, oid) {
    const repo = await get(id);
    assert((await refs(id)).stashes.some(s => s.oid === oid), 'GIT_STASH_CHANGED', '储藏记录已变化，请重新选择。', 409);
    const detail = await commit(id, oid), third = await command(repo.absolute, ['rev-parse', '--verify', `${oid}^3`], { allowFailure: true });
    detail.files = detail.files.map(file => ({ ...file, rev: oid }));
    if (third.code === 0) {
      const untracked = await commit(id, third.stdout.trim());
      detail.files.push(...untracked.files.map(file => ({ ...file, rev: untracked.oid, untracked: true })));
      detail.paths = detail.files.map(file => file.path);
    }
    return detail;
  }
  const settings = createGitSettings({ get, command });
  async function execute(request, operation) {
    const repo = await get(request.repo);
    const configRun = (args, options = {}) => command(repo.absolute, args, { ...options, onProgress:text => { operation.progress = redact(operation.progress + text); } });
    if (configurationActions.has(request.action)) { const result = await settings.execute(repo, request, configRun); invalidate(repo.path); return result; }
    const current = await status(repo.id);
    assert(request.version === current.version, 'GIT_STATE_CHANGED', '仓库已变化，请刷新后重新选择操作。', 409);
    const run = (args, options = {}) => command(repo.absolute, args, { ...options, timeout: ['fetch', 'pull', 'push'].includes(request.action) ? 120000 : 30000, onProgress: text => { operation.progress = redact(operation.progress + text); } });
    const ref = value => { assert(safeRef(value), 'GIT_REF_INVALID', '无效的分支或远程引用。'); return value; };
    if (request.expectedOid) {
      const target = request.action === 'branch-create' ? request.startPoint : request.action === 'branch-track' ? request.source : request.name;
      assert(/^[a-f0-9]{40,64}$/.test(request.expectedOid), 'GIT_REF_INVALID', '无效的引用版本。');
      const actual = await run(['rev-parse', '--verify', ref(target)]);
      assert(actual.stdout.trim() === request.expectedOid, 'GIT_REF_CHANGED', '所选分支或标签已变化，请重新检查。', 409);
    }
    const filesArgs = async () => { assert(Array.isArray(request.paths) && request.paths.length > 0 && request.paths.length <= 1000, 'GIT_PATH_INVALID', '请选择需要操作的文件。'); for (const p of request.paths) await checkedPath(repo, p); return request.paths; };
    let result;
    switch (request.action) {
      case 'stage': result = await run(['add', '--', ...await filesArgs()]); break;
      case 'unstage': {
        const paths = await filesArgs(), expanded = new Set(paths);
        for (const path of paths) { const entry = current.entries.find(e => e.path === path); if (entry?.originalPath) { await checkedPath(repo, entry.originalPath); expanded.add(entry.originalPath); } }
        result = await run(current.branch.oid ? ['reset', '-q', 'HEAD', '--', ...expanded] : ['rm', '--cached', '--force', '--', ...expanded]); break;
      }
      case 'hunk': {
        const snap = snapshots.get(request.snapshotId);
        assert(snap && snap.id === repo.id && snap.version === current.version && Date.now() - snap.at < 600000, 'GIT_DIFF_EXPIRED', '差异快照已过期，请重新打开文件。', 409);
        const hunk = snap.hunks.find(h => h.id === request.hunkId); assert(hunk, 'GIT_HUNK_UNKNOWN', '修改块不存在。');
        await checkedPath(repo, snap.path);
        const args = ['apply', '--cached', ...(snap.staged ? ['--reverse'] : [])];
        await run([...args, '--check', '-'], { input: hunk.patch }); result = await run([...args, '-'], { input: hunk.patch }); break;
      }
      case 'commit':
        assert(typeof request.message === 'string' && request.message.trim() && request.message.length <= 32000, 'GIT_MESSAGE_REQUIRED', '请输入提交说明。');
        assert(current.entries.some(e => e.index !== '.' && e.index !== '?') && !current.conflictCount, 'GIT_COMMIT_EMPTY', '请先暂存变更并解决冲突。', 409);
        result = await run(['commit', '--file=-'], { input: request.message }); break;
      case 'branch-create': {
        await run(['check-ref-format', '--branch', ref(request.name)]);
        const start = request.startPoint && !(request.startPoint === 'HEAD' && !current.branch.oid) ? await resolveCommit(repo, request.startPoint) : null;
        result = request.checkout === false ? await run(['branch', '--', request.name, ...(start ? [start] : [])]) : await run(['switch', '-c', request.name, ...(start ? [start] : [])]); break;
      }
      case 'branch-track': {
        const source = ref(request.source);
        assert((await refs(repo.id)).branches.some(b => b.fullName === source && b.kind === 'remote'), 'GIT_REF_INVALID', '请选择实际的远程分支。');
        await run(['check-ref-format', '--branch', ref(request.name)]);
        result = await run(['switch', '--track', '-c', request.name, source]); break;
      }
      case 'branch-rename': await run(['check-ref-format', '--branch', ref(request.newName)]); result = await run(['branch', '-m', '--', ref(request.name), request.newName]); break;
      case 'branch-switch': result = await run(['switch', '--', ref(request.name)]); break;
      case 'branch-delete': result = await run(['branch', '-d', '--', ref(request.name)]); break;
      case 'merge': result = await run(['merge', '--no-edit', '--', ref(request.name)]); break;
      case 'merge-abort': assert(current.merging, 'GIT_NOT_MERGING', '当前没有进行中的合并。', 409); result = await run(['merge', '--abort']); break;
      case 'merge-complete': assert(current.merging && !current.conflictCount, 'GIT_CONFLICTS_REMAIN', '请先解决全部冲突。', 409); result = await run(['commit', '--no-edit']); break;
      case 'fetch': case 'pull': case 'push': {
        const remote = ref(request.remote); assert(current.remotes.includes(remote), 'GIT_REMOTE_UNKNOWN', '远程不存在，请刷新仓库。');
        if (request.action === 'fetch') result = await run(['fetch', '--progress', '--', remote]);
        else if (request.action === 'pull') { await run(['check-ref-format', `refs/heads/${ref(request.branch)}`]); result = await run(['pull', '--ff-only', '--progress', '--', remote, request.branch]); }
        else { assert(current.branch.name, 'GIT_DETACHED', '分离 HEAD 状态不能直接推送。', 409); await run(['check-ref-format', `refs/heads/${ref(request.branch)}`]); result = await run(['push', '--progress', ...(request.setUpstream === true ? ['--set-upstream'] : []), '--', remote, `HEAD:refs/heads/${request.branch}`]); }
        if (request.action !== 'push') repo.lastFetchedAt = new Date().toISOString(); break;
      }
      case 'stash-create': result = await run(['stash', 'push', ...(request.includeUntracked === true ? ['--include-untracked'] : []), '-m', typeof request.message === 'string' ? request.message.slice(0, 2000) : 'KSF 工作台']); break;
      case 'stash-apply': case 'stash-pop': case 'stash-drop': {
        const stashes = (await refs(repo.id)).stashes;
        assert(stashes.some(s => s.ref === request.stash && s.oid === request.stashOid), 'GIT_STASH_CHANGED', '暂存记录已变化，请重新选择。', 409);
        result = await run(['stash', request.action.slice(6), ...(request.action !== 'stash-drop' && request.restoreIndex === true ? ['--index'] : []), request.stash]); break;
      }
      case 'resolve': {
        const workspacePath = await checkedPath(repo, request.path);
        assert(current.entries.some(e => e.path === request.path && e.conflict), 'GIT_NOT_CONFLICTED', '文件已不再冲突。', 409);
        assert(request.remove === true || typeof request.text === 'string' && !/^(?:<<<<<<< |=======\r?$|>>>>>>> )/m.test(request.text), 'GIT_CONFLICT_MARKERS', '请先清除结果中的冲突标记。');
        const disk = await files.read(workspacePath).catch(error => { if (error.code === 'ENOENT') return { version: 'missing' }; throw error; });
        // Already inside this repository's queue: do not recursively acquire it.
        assert(disk.version === request.fileVersion, 'WORKSPACE_CONFLICT', '冲突结果文件已变化，请重新载入。', 409);
        if (request.remove === true) { assert(disk.version === 'missing' ? filePolicy(workspacePath) === 'editable' : disk.writable, 'WORKSPACE_PROTECTED', '该文件受保护，请先在文档应用中检查或解锁。', 403); result = await run(['rm', '--', request.path]); }
        else {
          if (disk.version === 'missing') await files.createUnlocked({ path: workspacePath, text: request.text });
          else await files.saveUnlocked({ path: workspacePath, text: request.text, version: request.fileVersion });
          result = await run(['add', '--', request.path]);
        }
        break;
      }
      default: throw problem('GIT_ACTION_UNKNOWN', '不支持此 Git 操作。');
    }
    const { entries, ...state } = await status(repo.id);
    return { output: redact((result?.stdout ?? '') + (result?.stderr ?? '')), state };
  }
  const actions = new Set(['stage', 'unstage', 'hunk', 'commit', 'branch-create', 'branch-track', 'branch-rename', 'branch-switch', 'branch-delete', 'merge', 'merge-abort', 'merge-complete', 'fetch', 'pull', 'push', 'stash-create', 'stash-apply', 'stash-pop', 'stash-drop', 'resolve']);
  async function start(request) {
    assert(request && (actions.has(request.action) || configurationActions.has(request.action)) && typeof (configurationActions.has(request.action) ? request.settingsVersion : request.version) === 'string' && typeof request.requestId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(request.requestId), 'GIT_REQUEST_INVALID', '操作需要有效动作、仓库版本和请求标识。');
    const fingerprint = digest(JSON.stringify(request)), previous = requests.get(request.requestId);
    if (previous) { assert(previous.fingerprint === fingerprint, 'GIT_REQUEST_CONFLICT', '请求标识已用于另一个操作。', 409); return operations.get(previous.id); }
    const repo = await get(request.repo);
    // Another request can finish repository validation while this one awaits Git.
    const raced = requests.get(request.requestId);
    if (raced) { assert(raced.fingerprint === fingerprint, 'GIT_REQUEST_CONFLICT', '请求标识已用于另一个操作。', 409); return operations.get(raced.id); }
    const operation = { id: randomUUID(), repo: repo.id, action: request.action, status: 'queued', progress: '', startedAt: new Date().toISOString(), result: null, error: null };
    operations.set(operation.id, operation); requests.set(request.requestId, { id: operation.id, fingerprint });
    await checkpoint();
    const job = coordinator.run(repo.absolute, async () => {
      operation.status = 'running';
      try { operation.result = await execute(request, operation); operation.status = 'completed'; }
      catch (error) { operation.status = 'failed'; operation.error = { code: error.code ?? 'GIT_IO_FAILED', message: redact(error.message), uncertain: ['GIT_TIMEOUT', 'GIT_OUTPUT_LIMIT'].includes(error.code) }; }
      finally { operation.finishedAt = new Date().toISOString(); await checkpoint(); }
    }).catch(async error=>{operation.status='failed';operation.error={code:error.code??'GIT_IO_FAILED',message:redact(error.message),uncertain:true};operation.finishedAt=new Date().toISOString();await checkpoint();});
    operationJobs.add(job);
    void job.finally(() => operationJobs.delete(job)).catch(() => {});
    // Keep a bounded session ledger; entries are never silently rerun on reconnect.
    if (operations.size > 500) for (const [id, item] of operations) if (['completed', 'failed'].includes(item.status)) { operations.delete(id); for (const [key, r] of requests) if (r.id === id) requests.delete(key); if (operations.size <= 400) break; }
    return operation;
  }
  return { list, scan, status, diff, history, commit, tree, refs, conflict, stashDetail, start, invalidate, settings:settings.read,
    async owner(path) { await files.locate(path); await scan(); const repo = [...repositories.values()].filter(r => r.valid && (r.path === '.' || path.startsWith(r.path + '/'))).sort((a, b) => b.path.length - a.path.length)[0]; assert(repo, 'GIT_OWNER_MISSING', '此文件没有所属 Git 仓库。', 404); return { repo: repo.id, path: repo.path === '.' ? path : path.slice(repo.path.length + 1) }; },
    operation(id) { const operation = operations.get(id); assert(operation, 'GIT_OPERATION_UNKNOWN', '操作记录已失效或服务已重启，请重新读取仓库核对结果。', 404); return operation; },
    async close() { closed = true; summaryQueue.clear(); await scanPromise; await Promise.all(summaryJobs.values()); await Promise.all(operationJobs); },
  };
}
