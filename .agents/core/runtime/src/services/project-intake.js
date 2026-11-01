import {portable} from '../shared/paths.js';
import {
  constants, lstatSync, readdirSync, openSync, closeSync, fstatSync, readSync, writeSync,
  fsyncSync, fchmodSync, mkdirSync, linkSync, unlinkSync, readFileSync,
} from 'node:fs';
import { resolve, join, dirname, basename, relative as nativeRelative, isAbsolute, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sameIdentity, withExclusiveLock, withTemporaryFile } from '../shared/files.js';
import { replaceFileSync } from '../platform/index.js';

const relative=(...args)=>portable(nativeRelative(...args));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const issue = (code, message) => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw issue(code, message); };
const inside = (base, path) => { const p = relative(base, path); return p === '' || p !== '..' && !p.startsWith('../') && !isAbsolute(p); };
const identity = stat => ({ dev: stat.dev, ino: stat.ino });
const token = stat => ({ ...identity(stat), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const missing = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const safeRelative = path => typeof path === 'string' && path !== '' && !isAbsolute(path) && !/[\\\p{Cc}]/u.test(path) &&
  path.split('/').every(part => part && !['.', '..'].includes(part));

// Check existing components without resolving through links. Missing descendants
// are allowed only for proposed destinations, never for a source read.
function pathGuard(path, optional = false) {
  const absolute = resolve(path), start = parse(absolute).root, found = [];
  let current = start, absent = false;
  for (const part of relative(start, absolute).split('/').filter(Boolean)) {
    current = join(current, part);
    if (absent) continue;
    const stat = missing(current);
    if (!stat) {
      if (!optional) fail('INTAKE_NOT_FOUND', 'A required path is missing.');
      absent = true; continue;
    }
    if (stat.isSymbolicLink()) fail('INTAKE_UNSAFE_PATH', 'Symbolic links are not followed.');
    if (current !== absolute && !stat.isDirectory()) fail('INTAKE_UNSAFE_PATH', 'A parent is not a directory.');
    found.push({ path: current, ...identity(stat) });
  }
  return () => {
    for (const item of found) {
      const stat = lstatSync(item.path);
      if (stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino)
        fail('INTAKE_PATH_CHANGED', 'A path component changed during the operation.');
    }
  };
}

function fingerprint(path) {
  const guard = pathGuard(path, true), stat = missing(path);
  if (!stat) return { state: 'missing' };
  if (stat.isDirectory()) { guard(); return { state: 'directory', ...identity(stat) }; }
  if (!stat.isFile()) fail('INTAKE_UNSUPPORTED_FILE', 'Only ordinary files and directories are supported.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || !sameIdentity(stat, before)) fail('INTAKE_SOURCE_CHANGED', 'File changed before reading.');
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    const after = fstatSync(fd);
    if (!sameIdentity(before, after)) fail('INTAKE_SOURCE_CHANGED', 'File changed while reading.');
    guard();
    return { state: 'file', ...token(after), sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}

function context(root, project) {
  if (typeof root !== 'string' || typeof project !== 'string' || !project.trim() ||
      /[/\\\p{Cc}]/u.test(project) || ['.', '..'].includes(project) || project.startsWith('.ksf-project-'))
    fail('INTAKE_ARGUMENT_INVALID', 'Provide a KSF root and one project directory name.');
  root = resolve(root);
  const folder = join(root, '项目', project), guard = pathGuard(folder);
  if (!lstatSync(folder).isDirectory()) fail('INTAKE_PROJECT_INVALID', 'Project must be an ordinary directory.');
  const card = fingerprint(join(folder, 'project.md'));
  if (card.state !== 'file') fail('INTAKE_PROJECT_INVALID', 'Create or verify the project root card first.');
  guard();
  return { root, project, folder, projectIdentity: identity(lstatSync(folder)), guard };
}

function sourceInfo(source) {
  if (typeof source !== 'string' || !source.trim()) fail('INTAKE_ARGUMENT_INVALID', 'Provide a source path.');
  source = resolve(source); pathGuard(source)();
  const stat = lstatSync(source);
  if (!stat.isFile() && !stat.isDirectory()) fail('INTAKE_UNSUPPORTED_FILE', 'Source must be an ordinary file or directory.');
  return { source, sourceKind: stat.isDirectory() ? 'directory' : 'file', sourceIdentity: identity(stat) };
}

function targetRoot(ctx, info, destination) {
  const result = destination ?? `资料/${basename(info.source)}`;
  if (!safeRelative(result) || !result.startsWith('资料/') || result === '资料/导入记录' || result.startsWith('资料/导入记录/'))
    fail('INTAKE_DESTINATION_INVALID', 'Destination must be under this project’s 资料 directory, outside 导入记录.');
  const target = resolve(ctx.folder, result);
  if (!inside(ctx.folder, target) || inside(info.source, target) || inside(target, info.source))
    fail('INTAKE_OVERLAP', 'Source and destination overlap.');
  return result;
}

function receiptInfo(ctx, info, destination) {
  const sourceId = digest(info.sourceKind + ':' + info.source);
  const path = join(ctx.folder, '资料', '导入记录', sourceId + '.json');
  pathGuard(path, true)();
  const stat = missing(path);
  if (!stat) return { sourceId, path, etag: 'missing', value: null };
  if (!stat.isFile()) fail('INTAKE_RECORD_INVALID', 'Import record is not an ordinary file.');
  const before = fingerprint(path), bytes = readFileSync(path);
  if (digest(bytes) !== before.sha256) fail('INTAKE_RECORD_CHANGED', 'Import record changed while reading.');
  let value;
  try { value = JSON.parse(bytes); } catch { fail('INTAKE_RECORD_INVALID', 'Preserve the damaged import record.'); }
  if (value.schemaVersion !== 1 || value.source !== info.source || value.sourceKind !== info.sourceKind ||
      value.project !== ctx.project || value.destination !== destination || !Array.isArray(value.files) ||
      !Array.isArray(value.directories) || !Array.isArray(value.issues))
    fail('INTAKE_RECORD_INVALID', 'Import record identity or format is not supported.');
  const expected = rel => info.sourceKind === 'file' ? destination : rel === '' ? destination : destination + '/' + rel;
  const seen = new Set();
  for (const row of value.files) {
    if (!row || typeof row.relativePath !== 'string' || info.sourceKind === 'file' && row.relativePath !== '' || row.relativePath !== '' && !safeRelative(row.relativePath) ||
        row.target !== expected(row.relativePath) || !hashPattern.test(row.sha256) || seen.has(row.relativePath))
      fail('INTAKE_RECORD_INVALID', 'Import record contains an unsafe or duplicate file mapping.');
    seen.add(row.relativePath);
  }
  if (new Set(value.directories).size !== value.directories.length || info.sourceKind === 'file' && value.directories.length ||
      value.directories.some(p => !safeRelative(p) || !(p === destination || p.startsWith(destination + '/'))))
    fail('INTAKE_RECORD_INVALID', 'Import record contains an unsafe directory mapping.');
  const issuePaths = new Set();
  for (const row of value.issues) {
    if (!row || typeof row.relativePath !== 'string' || info.sourceKind === 'file' && row.relativePath !== '' ||
        row.relativePath !== '' && !safeRelative(row.relativePath) || row.target !== expected(row.relativePath) ||
        typeof row.code !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(row.code) || issuePaths.has(row.relativePath))
      fail('INTAKE_RECORD_INVALID', 'Import record contains an invalid issue mapping.');
    issuePaths.add(row.relativePath);
  }
  return { sourceId, path, etag: before.sha256, value };
}

export function planMaterials({ root, project, source, destination }) {
  const ctx = context(root, project), info = sourceInfo(source);
  const base = { schemaVersion: 1, root: ctx.root, project, ...info, projectIdentity: ctx.projectIdentity };
  if (info.sourceKind === 'directory' && missing(join(info.source, '.git')))
    return { ...base, mode: 'engineering', entries: [], receiptEtag: 'missing' };
  if (inside(ctx.folder, info.source)) return { ...base, mode: 'in-place', entries: [], receiptEtag: 'missing' };
  destination = targetRoot(ctx, info, destination);
  const receipt = receiptInfo(ctx, info, destination), entries = [], encountered = new Set();
  const previous = new Map((receipt.value?.files ?? []).map(row => [row.relativePath, row]));
  const oldDirs = new Set(receipt.value?.directories ?? []);
  const visit = (path, rel) => {
    const target = rel === '' || info.sourceKind === 'file' ? destination : destination + '/' + rel;
    const row = { relativePath: rel, target };
    encountered.add(rel);
    try {
      pathGuard(path)();
      const stat = lstatSync(path);
      if (stat.isDirectory() && missing(join(path, '.git'))) fail('INTAKE_ENGINEERING_SOURCE', 'An engineering directory needs verification and association, not copying.');
      row.source = fingerprint(path); row.destination = fingerprint(join(ctx.folder, target));
      if (row.source.state === 'directory') {
        row.action = row.destination.state === 'directory' ? 'skip' : row.destination.state === 'missing' && !oldDirs.has(target) ? 'mkdir' : 'conflict';
      } else {
        row.action = row.destination.state === 'file' && row.destination.sha256 === row.source.sha256 ? 'skip'
          : row.destination.state === 'missing' && !previous.has(rel) ? 'copy' : 'conflict';
      }
      if (row.action === 'conflict') row.code = 'INTAKE_CONTENT_CONFLICT';
      const children = stat.isDirectory() ? readdirSync(path).sort() : [];
      entries.push(row);
      for (const name of children) visit(join(path, name), rel ? rel + '/' + name : name);
    } catch (error) {
      entries.push({ ...row, action: 'error', code: error.code ?? 'INTAKE_IO_FAILED', message: error.message });
    }
  };
  visit(info.source, '');
  for (const old of receipt.value?.files ?? []) if (!encountered.has(old.relativePath))
    entries.push({ relativePath: old.relativePath, target: old.target, action: 'conflict', code: 'INTAKE_SOURCE_MISSING',
      source: { state: 'missing' }, destination: fingerprint(join(ctx.folder, old.target)) });
  ctx.guard();
  return { ...base, mode: 'copy', sourceId: receipt.sourceId, destination, receiptEtag: receipt.etag, entries };
}

function ensureDirectory(path, folder, oldDirectories = new Set()) {
  if (!inside(folder, path)) fail('INTAKE_DESTINATION_INVALID', 'Directory escapes the project.');
  pathGuard(path, true)();
  const parts = relative(folder, path).split('/').filter(Boolean);
  let current = folder;
  for (const part of parts) {
    current = join(current, part);
    const stat = missing(current);
    if (!stat) {
      if (oldDirectories.has(relative(folder, current))) fail('INTAKE_TARGET_CHANGED', 'A previously imported directory is missing; do not recreate it.');
      mkdirSync(current, { mode: 0o700 });
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INTAKE_UNSAFE_PATH', 'Destination parent is not an ordinary directory.');
  }
  return pathGuard(path);
}

function publishCopy(source, target, expected, ctx, hooks, row) {
  const sourceGuard = pathGuard(source), parentGuard = pathGuard(dirname(target));
  const temporary = join(dirname(target), '.intake-' + randomUUID() + '.tmp');
  let input, output;
  try {
    input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(input);
    if (!same(token(before), Object.fromEntries(Object.entries(expected).filter(([k]) => !['state', 'sha256'].includes(k)))))
      fail('INTAKE_SOURCE_CHANGED', 'Source changed since planning.');
    output = openSync(temporary, 'wx', 0o600);
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = readSync(input, buffer, 0, buffer.length, null))) {
      hash.update(buffer.subarray(0, count));
      for (let offset = 0; offset < count;) offset += writeSync(output, buffer, offset, count - offset);
    }
    if (!sameIdentity(before, fstatSync(input)) || hash.digest('hex') !== expected.sha256)
      fail('INTAKE_SOURCE_CHANGED', 'Source changed while copying.');
    fchmodSync(output, before.mode & 0o777); fsyncSync(output);
    closeSync(output); output = undefined;
    hooks.beforePublish?.(row);
    ctx.guard(); sourceGuard(); parentGuard();
    if (!same(fingerprint(source), expected)) fail('INTAKE_SOURCE_CHANGED', 'Source changed before publication.');
    if (fingerprint(target).state !== 'missing') fail('INTAKE_TARGET_CHANGED', 'Destination appeared; no replacement is allowed.');
    linkSync(temporary, target);
    parentGuard();
    if (fingerprint(target).sha256 !== expected.sha256) fail('INTAKE_COPY_VERIFICATION_FAILED', 'Published bytes do not match the source snapshot.');
  } finally {
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
    // A replaced parent must not turn cleanup into an unlink in another tree.
    try { parentGuard(); unlinkSync(temporary); } catch (e) { if (!['ENOENT', 'INTAKE_PATH_CHANGED', 'INTAKE_UNSAFE_PATH'].includes(e.code)) throw e; }
  }
}

export function applyMaterials({ root, project, plan }, hooks = {}) {
  if (!plan || plan.schemaVersion !== 1 || plan.root !== resolve(root) || plan.project !== project || !Array.isArray(plan.entries))
    fail('INTAKE_PLAN_INVALID', 'Plan does not belong to this root/project or has an unsupported format.');
  const ctx = context(root, project), fresh = planMaterials({ root, project, source: plan.source, destination: plan.destination });
  if (plan.mode !== fresh.mode || !same(plan.projectIdentity, fresh.projectIdentity) || !same(plan.sourceIdentity, fresh.sourceIdentity) || plan.receiptEtag !== fresh.receiptEtag)
    fail('INTAKE_PLAN_STALE', 'Project, source identity or import record changed; prepare a new plan.');
  if (plan.mode !== 'copy') return { ok: plan.mode === 'in-place', mode: plan.mode, changed: false, results: [],
    ...(plan.mode === 'engineering' ? { errors: [{ code: 'INTAKE_ENGINEERING_SOURCE', message: 'Verify and associate the engineering root with repository CLI.' }] } : {}) };
  if (plan.sourceId !== fresh.sourceId || plan.destination !== fresh.destination) fail('INTAKE_PLAN_INVALID', 'Plan source or destination identity is invalid.');
  const unique = new Set(), current = new Map(fresh.entries.map(row => [row.relativePath, row]));
  for (const row of plan.entries) {
    if (!row || typeof row.relativePath !== 'string' || unique.has(row.relativePath) ||
        row.relativePath !== '' && !safeRelative(row.relativePath)) fail('INTAKE_PLAN_INVALID', 'Invalid or duplicate plan entry.');
    unique.add(row.relativePath);
    const expected = plan.sourceKind === 'file' || row.relativePath === '' ? plan.destination : plan.destination + '/' + row.relativePath;
    if (row.target !== expected || !['copy', 'mkdir', 'skip', 'conflict', 'error'].includes(row.action)) fail('INTAKE_PLAN_INVALID', 'Unsafe plan mapping or action.');
  }
  const info = sourceInfo(plan.source), receipt = receiptInfo(ctx, info, plan.destination);
  const oldDirectories = new Set(receipt.value?.directories ?? []), files = new Map((receipt.value?.files ?? []).map(row => [row.relativePath, row]));
  const directories = new Set(oldDirectories), results = [];
  const problems = new Map((receipt.value?.issues ?? []).map(row => [row.relativePath, row]));
  let changed = false, expectedEtag = receipt.etag;
  const persist = () => {
    const value = { schemaVersion: 1, project, source: info.source, sourceKind: info.sourceKind, destination: plan.destination,
      files: [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)), directories: [...directories].sort(),
      issues: [...problems.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)) };
    const bytes = JSON.stringify(value, null, 2) + '\n';
    const latest = receiptInfo(ctx, info, plan.destination);
    if (latest.etag !== expectedEtag) fail('INTAKE_RECORD_CHANGED', 'Import record changed concurrently; preserve it.');
    if (latest.value && same(latest.value, value)) return;
    if (!files.size && !directories.size && !latest.value) return;
    hooks.beforeReceipt?.(value);
    const parentGuard = pathGuard(dirname(receipt.path));
    withTemporaryFile(receipt.path + '.' + randomUUID() + '.tmp', bytes, {}, temporary => {
      ctx.guard(); parentGuard();
      if (receiptInfo(ctx, info, plan.destination).etag !== expectedEtag) fail('INTAKE_RECORD_CHANGED', 'Import record changed before publication.');
      if (expectedEtag === 'missing') linkSync(temporary, receipt.path);
      else replaceFileSync(temporary, receipt.path);
    });
    expectedEtag = digest(bytes); changed = true;
  };
  // Nothing can be written before plan validation and the record baseline check.
  if (!receipt.value && !plan.entries.some(row => ['copy', 'mkdir', 'skip'].includes(row.action)))
    return { ok: false, mode: 'copy', changed: false, results: plan.entries.map(row => ({ ...row, status: 'failed' })), errors: [] };
  ensureDirectory(dirname(receipt.path), ctx.folder);
  const lock = join(dirname(receipt.path), '.intake.lock');
  return withExclusiveLock(lock, { pid: process.pid }, () => {
    if (receiptInfo(ctx, info, plan.destination).etag !== expectedEtag) fail('INTAKE_PLAN_STALE', 'Import record changed before acquiring the lock.');
    for (const row of plan.entries) {
      const now = current.get(row.relativePath);
      const result = { relativePath: row.relativePath, target: row.target, action: row.action };
      problems.delete(row.relativePath);
      try {
        if (!now || !same(row.source, now.source) || !same(row.destination, now.destination) || row.action !== now.action)
          fail('INTAKE_ENTRY_CHANGED', 'Source or target changed after planning; keep both and replan.');
        if (row.action === 'error' || row.action === 'conflict') fail(row.code ?? 'INTAKE_CONTENT_CONFLICT', row.message ?? 'Keep the original and existing copy; resolve the difference before replacing anything.');
        ctx.guard();
        const target = join(ctx.folder, row.target);
        if (row.source.state === 'directory') {
          if (row.action === 'mkdir') { ensureDirectory(target, ctx.folder, oldDirectories); changed = true; result.status = 'created'; }
          else { pathGuard(target)(); result.status = 'skipped'; }
          directories.add(row.target);
        } else {
          const source = plan.sourceKind === 'file' ? plan.source : join(plan.source, row.relativePath);
          if (!same(fingerprint(source), row.source) || !same(fingerprint(target), row.destination)) fail('INTAKE_ENTRY_CHANGED', 'Source or target changed immediately before use.');
          if (row.action === 'copy') {
            ensureDirectory(dirname(target), ctx.folder, oldDirectories);
            publishCopy(source, target, row.source, ctx, hooks, row); changed = true; result.status = 'copied';
            hooks.afterPublish?.(row);
          } else result.status = 'skipped';
          files.set(row.relativePath, { relativePath: row.relativePath, target: row.target, sha256: row.source.sha256 });
        }
        results.push(result); persist();
      } catch (error) {
        const code = error.code ?? 'INTAKE_IO_FAILED';
        Object.assign(result, { status: /CONFLICT|CHANGED|STALE/.test(code) ? 'conflict' : 'failed', code, message: error.message });
        if (!results.includes(result)) results.push(result);
        problems.set(row.relativePath, { relativePath: row.relativePath, target: row.target, code });
        if (['INTAKE_RECORD_CHANGED', 'INTAKE_RECORD_INVALID', 'INTAKE_INTERRUPTED'].includes(code)) return { ok: false, mode: 'copy', changed, results, record: relative(ctx.root, receipt.path), errors: [{ code, message: error.message }] };
      }
    }
    for (const row of fresh.entries) if (!unique.has(row.relativePath)) {
      const result = { relativePath: row.relativePath, target: row.target, action: 'conflict', status: 'conflict', code: 'INTAKE_NOT_PLANNED', message: 'New source entry was not in the reviewed plan.' };
      results.push(result); problems.set(row.relativePath, { relativePath: row.relativePath, target: row.target, code: result.code });
    }
    try { persist(); } catch (error) { return { ok: false, mode: 'copy', changed, results, errors: [{ code: error.code ?? 'INTAKE_RECORD_WRITE_FAILED', message: error.message }] }; }
    return { ok: results.every(row => ['copied', 'created', 'skipped'].includes(row.status)), mode: 'copy', changed, results, record: relative(ctx.root, receipt.path), errors: [] };
  }, { onLocked: () => fail('INTAKE_LOCKED', 'Another intake operation holds the project lock.') });
}
