import {GitHubAPI} from './github.js';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkedPath, fileMode, parseJSON, readJSON, readRegular, textBytes, walkFiles, writeAtomic, writeJSON } from './files.js';
import { compareVersions, versionParts } from './versions.js';
import { configuration } from './configuration.js';
import { digestObject, isSHA, sha256, stableJSON } from '../shared/hash.js';
import { fail } from './errors.js';
import { installedManifest, validateManifest, releaseReceipt, validateProducts } from './manifests.js';
import {assertCoreDataCompatibility} from '../data-compatibility.js';
import { checkSourceCompatibility } from '../sources/compatibility.js';
import { isRepository, isRevision } from './git-values.js';
import { developmentPath } from './paths.js';
import { matchesBaseline, resolveBaseline } from './baseline.js';
import { download, releaseIndex } from './network.js';
import { inspectCoreArchive } from './release.js';
import { rootFiles, launcherProtocol } from './products.js';
import {platform,launcherInvocation,replaceFileSync as renameSync,removePathSync as rmSync} from '../platform/index.js';
import {mergeText} from '../shared/merge-text.js';
import {retainRuntimeArtifacts} from './retention.js';
export {mergeText};

const generated = new Set(['.agents/core/manifest.yaml']);
const modeOf = (root, path) => existsSync(checkedPath(root, path)) ? fileMode(checkedPath(root, path)) : null;
const equals = matchesBaseline;
function localFile(root, path, declared) {
  const bytes = readRegular(root, path, true);
  return bytes === null ? null : { bytes, mode: fileMode(checkedPath(root, path), declared) };
}
export function systemFingerprint(root) {
  const paths = walkFiles(root, '.agents/core', { exclude: developmentPath }).concat(rootFiles).sort();
  return digestObject(paths.map(path => [path, sha256(readRegular(root, path)), fileMode(checkedPath(root, path))]));
}
export async function systemRead({ root, api, fetcher }) {
  const receipt = installedManifest(root, true), config = configuration(root, { user: true });
  const backups = backupRecords(root);
  if (!receipt) return { mode: 'development', installed: false, coreRepository: config.core_repository,
    releaseSource: config.release_source, automaticUpdates: false, backups: [] };
  if ([4, 5].includes(receipt.schema_version) && receipt.development) return { mode: 'workspace', installed: true,
    version: receipt.version, platform: receipt.platform, core: receipt.core, developmentPackage: true,
    releaseSource: config.release_source, automaticUpdates: false, checkIntervalSeconds: config.check_interval_seconds,
    requestTimeoutSeconds: config.request_timeout_seconds, changes: null, baselineVerified: false,
    baselineStatus: 'development-package', backups: backups.map(b => ({ id: b.id, from: b.from, to: b.to, operation: b.operation })) };
  const manifest = await resolveBaseline(receipt, { api, fetcher });
  const changes = [];
  for (const [path, base] of Object.entries(manifest.files)) {
    if (generated.has(path)) continue;
    const file = localFile(root, path, base.mode);
    if (!equals(file, base)) changes.push({ path, state: file === null ? 'deleted' : 'modified' });
  }
  for (const path of walkFiles(root, '.agents/core', { exclude: developmentPath }).concat(rootFiles)) {
    if (path !== '.agents/core/release.json' && !generated.has(path) && !Object.hasOwn(manifest.files, path) && !/\.tmp$/.test(path) && localFile(root, path) !== null) changes.push({ path, state: 'added' });
  }
  return { mode: 'workspace', installed: true, version: manifest.version, platform: manifest.platform,
    core: manifest.core, developmentPackage: manifest.development === true, releaseSource: config.release_source,
    automaticUpdates: false, checkIntervalSeconds: config.check_interval_seconds, requestTimeoutSeconds: config.request_timeout_seconds, changes, backups: backups.map(b => ({ id: b.id, from: b.from, to: b.to, operation: b.operation })) };
}
export function validateIndex(index, manifest) {
  if (!index || ![1, 2].includes(index.schema_version) || !isRepository(index.core_repository) || !isRevision(index.core_revision) ||
      index.core_repository !== manifest.core.repository || !index.platforms || Array.isArray(index.platforms)) fail('RELEASE_INVALID', 'Release index identity is invalid.');
  versionParts(index.version);
  validateProducts(index.products, { legacy: index.schema_version === 1 });
  if (index.development === true) fail('RELEASE_INVALID', 'Development packages cannot be installed from a release feed.');
  if (index.schema_version === 2 && Object.values(index.platforms).some(items => Object.keys(items).some(key => key !== 'core'))) fail('RELEASE_INVALID', 'A single-Core index cannot contain a second product.');
  const selected = index.platforms[manifest.platform];
  if (!selected?.core) fail('PLATFORM_UNSUPPORTED', `Release has no Core package for ${manifest.platform}.`);
  for (const item of [selected.core, selected.workspace].filter(Boolean)) {
    if (typeof item.url !== 'string' || !isSHA(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 256 * 1024 * 1024) fail('RELEASE_INVALID', 'Invalid release artifact descriptor.');
  }
  return selected;
}
function sourceAtRoot(root, source) {
  return source && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source) ? resolve(root, source) : source;
}
async function sourceReleaseState(current, incoming, { api, fetcher } = {}) {
  const ordinary = { promotion: false, sourceAhead: false };
  if (current.origin !== 'core-template' || incoming.version !== current.version) return ordinary;
  if (current.core.revision === incoming.core_revision) return { promotion: true, sourceAhead: false };
  const github = api ?? new GitHubAPI({ readOnly: true, fetcher });
  const comparison = await github.request('GET', `/repos/${current.core.repository}/compare/${current.core.revision}...${incoming.core_revision}`);
  if (comparison.base_commit?.sha !== current.core.revision) fail('RELEASE_REPLACED', 'The release comparison does not identify the verified template source.');
  if (comparison.status === 'behind' && comparison.merge_base_commit?.sha === incoming.core_revision) return { promotion: false, sourceAhead: true };
  if (comparison.merge_base_commit?.sha === current.core.revision && ['ahead', 'identical'].includes(comparison.status)) return { promotion: true, sourceAhead: false };
  fail('RELEASE_REPLACED', 'The same-version release and verified template source are unrelated.');
}
export async function systemCheck({ root, source, fetcher, api }) {
  const current = installedManifest(root), config = configuration(root, { user: true });
  const resolvedSource = sourceAtRoot(root, source) ?? config.release_source;
  const { index, url } = await releaseIndex(resolvedSource, { timeout: config.request_timeout_seconds * 1000, fetcher });
  const nativePlatform = `${process.platform}-${process.arch}`;
  const selectedPlatform = index.schema_version === 2 || index.platforms?.[nativePlatform]?.core ? nativePlatform : current.platform;
  const artifacts = validateIndex(index, { ...current, platform: selectedPlatform }), comparison = compareVersions(index.version, current.version);
  const platformSwitch = selectedPlatform !== current.platform && comparison === 0 && index.core_revision === current.core.revision;
  const { promotion, sourceAhead } = await sourceReleaseState(current, index, { api, fetcher });
  if (comparison === 0 && index.core_revision !== current.core.revision && !promotion && !sourceAhead) fail('RELEASE_REPLACED', 'The installed version was republished with a different Core revision.');
  return { current: current.version, latest: index.version, platform: selectedPlatform, installedPlatform: current.platform, platformSwitch, available: comparison > 0 || promotion || platformSwitch, sourcePromotion: promotion, sourceAhead,
    source: resolvedSource, indexURL: url, index, artifacts };
}
export async function planUpdate(root, current, incoming, entries) {
  const result = { files: new Map(), changes: [], conflicts: [] };
  const paths = [...new Set([...Object.keys(current.files), ...Object.keys(incoming.files)])].sort();
  for (const path of paths) {
    const base = current.files[path] ?? null, next = incoming.files[path] ?? null, local = localFile(root, path, base?.mode);
    const remote = next ? entries.get(path) : null;
    let chosen;
    if (generated.has(path)) chosen = remote;
    else if (equals(local, next)) chosen = local;
    else if (equals(local, base)) chosen = remote;
    else if ((base === null && next === null) || (base && next && equals(remote, base))) chosen = local;
    else if (base && next && local && textBytes(local.bytes) && textBytes(remote.bytes)) {
      const original = await current.read(path);
      if (!textBytes(original)) { result.conflicts.push({ path, kind: 'binary' }); continue; }
      const merged = mergeText(original, local.bytes, remote.bytes);
      if (merged.conflict) result.conflicts.push({ path, kind: 'text', merged: merged.bytes.toString('utf8') });
      else chosen = { bytes: merged.bytes, mode: local.mode === base.mode ? next.mode : local.mode };
    } else result.conflicts.push({ path, kind: !base ? 'add-add' : !next ? 'delete-modify' : !local ? 'modify-delete' : 'binary' });
    if (chosen !== undefined) {
      result.files.set(path, chosen);
      if ((chosen === null) !== (local === null) || (chosen && local && (!chosen.bytes.equals(local.bytes) || chosen.mode !== local.mode))) {
        result.changes.push({ path, operation: chosen === null ? 'delete' : local === null ? 'add' : 'update', preservesLocalChanges: !!base && !equals(local, base) });
      }
    }
  }
  return result;
}
function backupRecords(root) {
  const path = checkedPath(root, '.agents/runtime-data/system/backups');
  if (!existsSync(path)) return [];
  return readdirSync(path).sort().reverse().flatMap(id => {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return [];
    if (!lstatSync(checkedPath(root, `.agents/runtime-data/system/backups/${id}`)).isDirectory()) return [];
    const record = readJSON(root, `.agents/runtime-data/system/backups/${id}/meta.json`, true);
    return record && !existsSync(join(path, id, 'retention.json')) ? [{ ...record, id }] : [];
  });
}
function verifyCandidate(candidate, changedPaths = []) {
  const invocation = launcherInvocation(candidate, ['runtime','verify','--json']);
  const verify = spawnSync(invocation.executable, invocation.args, {
    cwd: candidate, encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024,
    env: { ...process.env, KSF_SKIP_AUTO_UPDATE: '1', KSF_INSTALLED_LAUNCHER: '1' },
  });
  if (verify.status !== 0) fail('CANDIDATE_INVALID', 'Updated system did not pass its bundled runtime verification.', { stderr: verify.stderr?.slice(0, 4000), stdout: verify.stdout?.slice(0, 4000) });
  const binaries = walkFiles(candidate, '.agents/runtime-data/runtime/node').filter(p => p.endsWith('/bin/node') || p.endsWith('/node.exe'));
  if (binaries.length !== 1) fail('CANDIDATE_INVALID', 'Candidate runtime installation is ambiguous.');
  const definitions = spawnSync(join(candidate, binaries[0]), [fileURLToPath(new URL('../services/validate-system.js', import.meta.url)), candidate], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (definitions.status !== 0) fail('CANDIDATE_INVALID', 'Updated system definitions or exact references are invalid.', { stderr: definitions.stderr?.slice(0, 4000) });
  for (const path of changedPaths.filter(p => /\.(?:js|mjs|cjs)$/.test(p) && existsSync(checkedPath(candidate, p)))) {
    const checked = spawnSync(join(candidate, binaries[0]), ['--check', checkedPath(candidate, path)], { encoding: 'utf8', timeout: 10000 });
    if (checked.status !== 0) fail('CANDIDATE_INVALID', `Updated JavaScript does not parse: ${path}.`, { stderr: checked.stderr?.slice(0, 4000) });
  }
}
function ownerStart() {
  try { return platform.processStart(process.pid); }
  catch { fail('TRANSACTION_FAILED', 'Cannot record update owner identity.'); }
}
export function recoverTransaction(root) {
  const path = checkedPath(root, '.agents/runtime-data/system/transaction');
  if (!existsSync(path)) return { recovered: false };
  const invocation = launcherInvocation(root, ['launcher','recover']);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, KSF_SKIP_AUTO_UPDATE: '1' },
  });
  if (result.status !== 0) fail('UPDATE_BUSY', 'An update is active or its recovery needs attention.', { stderr: result.stderr?.slice(0, 2000) });
  return { recovered: true };
}
function restoreCandidate(root, transaction) {
  const pending = rootFiles.filter(path => existsSync(join(transaction, 'root-intent', path)));
  const same = (first, second) => existsSync(first) && existsSync(second) && readFileSync(first).equals(readFileSync(second));
  // Preflight all roots before changing Core or restoring any one root.
  for (const path of pending) {
    const live = checkedPath(root, path), old = checkedPath(transaction, `old-root/${path}`), next = checkedPath(transaction, `new-root/${path}`);
    if (!same(live, old) && !same(live, next)) fail('RECOVERY_CONFLICT', `Concurrent edit at ${path}; files and transaction were preserved.`);
  }
  if (existsSync(join(transaction, 'old-core'))) {
    if (existsSync(join(root, '.agents/core'))) renameSync(join(root, '.agents/core'), join(transaction, 'failed-core'));
    renameSync(join(transaction, 'old-core'), join(root, '.agents/core'));
  }
  for (const path of pending) {
    const old = join(transaction, 'old-root', path), live = checkedPath(root, path);
    if (!same(live, old)) writeAtomic(live, readFileSync(old), fileMode(old));
  }
}
function commitCandidate(root, candidate, { before, from, to, operation = 'update', fault } = {}) {
  checkSourceCompatibility(root, candidate);
  const system = checkedPath(root, '.agents/runtime-data/system'); mkdirSync(system, { recursive: true });
  const transaction = checkedPath(root, '.agents/runtime-data/system/transaction');
  if (existsSync(transaction)) fail('UPDATE_BUSY', 'Another update transaction exists; use .agents/ksf to recover it.');
  const id = `${Date.now()}-${randomUUID()}`, preparation = checkedPath(root, `.agents/runtime-data/system/prepare-${id}`);
  mkdirSync(preparation);
  writeAtomic(join(preparation, 'protocol'), `${launcherProtocol}\n`);
  writeAtomic(join(preparation, 'owner'), String(process.pid) + '\n');
  writeAtomic(join(preparation, 'owner.start'), ownerStart() + '\n');
  writeAtomic(join(preparation, 'name'), id + '\n');
  try { renameSync(preparation, transaction); }
  catch { rmSync(preparation, { recursive: true, force: true }); fail('UPDATE_BUSY', 'Another update acquired the transaction.'); }
  let committed = false;
  try {
    // Staging is copied onto the same filesystem before changing live files.
    cpSync(join(candidate, '.agents/core'), join(transaction, 'new-core'), { recursive: true, errorOnExist: true, force: false });
    mkdirSync(join(transaction, 'old-root'));
    mkdirSync(join(transaction, 'new-root'));
    const changedRoots = rootFiles.filter(path => !readRegular(root, path).equals(readRegular(candidate, path)) || modeOf(root, path) !== modeOf(candidate, path));
    for (const path of changedRoots) {
      writeAtomic(join(transaction, 'old-root', path), readRegular(root, path), modeOf(root, path));
      writeAtomic(join(transaction, 'new-root', path), readRegular(candidate, path), modeOf(candidate, path));
    }
    const after = systemFingerprint(candidate);
    writeJSON(join(transaction, 'meta.json'), { from, to, operation, afterFingerprint: after, createdAt: new Date().toISOString() });
    if (systemFingerprint(root) !== before) fail('SYSTEM_CHANGED', 'System files changed after the update preview.');
    fault?.('prepared', transaction);
    renameSync(checkedPath(root, '.agents/core'), join(transaction, 'old-core'));
    fault?.('old-renamed', transaction);
    renameSync(join(transaction, 'new-core'), join(root, '.agents/core'));
    fault?.('new-renamed', transaction);
    for (const path of changedRoots) {
      if (!readRegular(root, path).equals(readRegular(transaction, `old-root/${path}`))) fail('SYSTEM_CHANGED', `Root changed before replacement: ${path}.`);
      writeAtomic(join(transaction, 'root-intent', path), '1\n');
      writeAtomic(join(root, path), readRegular(transaction, `new-root/${path}`), modeOf(candidate, path));
      fault?.(`root-installed:${path}`, transaction);
    }
    fault?.('roots-installed', transaction);
    writeAtomic(join(transaction, 'committed'), id + '\n'); committed = true;
    fault?.('committed', transaction);
    const backups = checkedPath(root, '.agents/runtime-data/system/backups'); mkdirSync(backups, { recursive: true });
    renameSync(transaction, join(backups, id));
    const retention = retainRuntimeArtifacts(root, 'switches');
    return { backup: id, from, to, changed: true, retention: { removed: retention.removed?.length ?? 0, errors: retention.errors, warnings: retention.warnings ?? [] } };
  } catch (error) {
    if (error?.simulateCrash) throw error;
    if (!committed && existsSync(transaction)) {
      restoreCandidate(root, transaction);
      const failed = checkedPath(root, '.agents/runtime-data/system/failed'); mkdirSync(failed, { recursive: true });
      renameSync(transaction, join(failed, id));
    }
    throw error;
  }
}
export async function systemUpdate({ root, source, from, dryRun = false, fetcher, fault, api }) {
  const receipt = installedManifest(root), config = configuration(root, { user: true }), before = systemFingerprint(root);
  let current = receipt;
  let archive, check;
  if (from) {
    archive = (await download(sourceAtRoot(root, from), { timeout: config.request_timeout_seconds * 1000, fetcher })).bytes;
  } else {
    check = await systemCheck({ root, source, fetcher, api });
    if (!check.available) return { current: current.version, latest: check.latest, changed: false, dryRun };
    archive = (await download(check.artifacts.core.url, { base: check.indexURL, timeout: config.request_timeout_seconds * 1000, fetcher })).bytes;
    if (archive.length !== check.artifacts.core.size || sha256(archive) !== check.artifacts.core.sha256) fail('CHECKSUM_MISMATCH', 'Downloaded Core archive does not match the Release index.');
  }
  const { manifest: incoming, entries } = inspectCoreArchive(archive, { expectedPlatform: check?.platform ?? `${process.platform}-${process.arch}`, expectedRepository: current.core.repository, expectedVersion: check?.latest });
  if (incoming.development) fail('RELEASE_INVALID', 'Cannot install a development package as an official update.');
  if (check && incoming.core.revision !== check.index.core_revision) fail('RELEASE_INVALID', 'Release source revision differs from the index.');
  const { promotion } = await sourceReleaseState(current, { version: incoming.version, core_revision: incoming.core.revision }, { api, fetcher });
  const platformSwitch = incoming.platform !== current.platform && incoming.core.revision === current.core.revision && incoming.version === current.version;
  if (compareVersions(incoming.version, current.version) <= 0 && !promotion && !platformSwitch) fail('VERSION_NOT_NEWER', 'Updates require a newer version; use rollback to return to a previous installed version.');
  current = await resolveBaseline(receipt, { api, fetcher });
  const plan = await planUpdate(root, current, incoming, entries);
  const result = { current: current.version, latest: incoming.version, dryRun, changed: false, changes: plan.changes, conflicts: plan.conflicts };
  if (plan.conflicts.length) fail('UPDATE_CONFLICT', 'Core changes conflict with local edits; the current system was preserved.', result);
  const staging = mkdtempSync(join(tmpdir(), 'ksf-update-'));
  try {
    cpSync(checkedPath(root, '.agents/core'), join(staging, '.agents/core'), { recursive: true });
    for (const [path, file] of plan.files) {
      const target = checkedPath(staging, path);
      if (file === null) rmSync(target, { force: true });
      else writeAtomic(target, file.bytes, file.mode);
    }
    writeAtomic(join(staging, '.agents/core/release.json'), stableJSON(releaseReceipt(incoming)));
    verifyCandidate(staging, plan.changes.map(c => c.path));
    checkSourceCompatibility(root, staging);
    await assertCoreDataCompatibility(root,join(staging,'.agents/core'));
    if (systemFingerprint(root) !== before) fail('SYSTEM_CHANGED', 'System files changed during update validation.');
    if (dryRun) return { ...result, wouldChange: true };
    return { ...result, ...commitCandidate(root, staging, { before, from: current.version, to: incoming.version, fault }) };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
export async function systemRollback({ root, dryRun = false, fault }) {
  const current = installedManifest(root), records = backupRecords(root), latest = records[0];
  if (!latest) fail('BACKUP_MISSING', 'No previous system version is available.');
  const before = systemFingerprint(root);
  if (latest.afterFingerprint !== before) fail('ROLLBACK_LOCAL_CHANGES', 'Core files changed after the last upgrade; preserve or contribute those edits before rollback.');
  const backup = checkedPath(root, `.agents/runtime-data/system/backups/${latest.id}`);
  const old = validateManifest(parseJSON(readFileSync(join(backup, 'old-core/release.json')), 'backup manifest'));
  const staging = mkdtempSync(join(tmpdir(), 'ksf-rollback-'));
  try {
    cpSync(join(backup, 'old-core'), join(staging, '.agents/core'), { recursive: true });
    for (const path of rootFiles) {
      const old = join(backup, 'old-root', path);
      const source = existsSync(old) ? old : checkedPath(root, path);
      writeAtomic(join(staging, path), readFileSync(source), fileMode(source));
    }
    verifyCandidate(staging);
    checkSourceCompatibility(root, staging);
    await assertCoreDataCompatibility(root,join(staging,'.agents/core'));
    if (dryRun) return { current: current.version, target: old.version, changed: false, wouldChange: true, dryRun };
    return { ...commitCandidate(root, staging, { before, from: current.version, to: old.version, operation: 'rollback', fault }), dryRun };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
export async function systemSync({ root, now = Date.now(), fetcher }) {
  const manifest = installedManifest(root, true);
  if (!manifest) return { skipped: true, reason: 'development', changed: false };
  if (manifest.development) return { skipped: true, reason: 'development-package', changed: false };
  const config = configuration(root, { user: true }), cachePath = '.agents/runtime-data/system/check.json';
  let cache;
  try { cache = readJSON(root, cachePath, true); }
  catch (error) {
    if (error.code !== 'INVALID_JSON') throw error;
    renameSync(checkedPath(root, cachePath), checkedPath(root, `.agents/runtime-data/system/check-corrupt-${randomUUID()}.json`));
    cache = null;
  }
  if (cache?.lastAttempt && now >= cache.lastAttempt && now - cache.lastAttempt < config.check_interval_seconds * 1000) return { skipped: true, reason: 'not-due', changed: false };
  if (existsSync(checkedPath(root, '.agents/runtime-data/system/transaction'))) return { skipped: true, reason: 'busy', changed: false };
  try {
    const response = await systemUpdate({ root, fetcher });
    writeJSON(checkedPath(root, cachePath), { lastAttempt: now, lastSuccess: now, version: response.latest, changed: response.changed });
    return response;
  } catch (error) {
    writeJSON(checkedPath(root, cachePath), { lastAttempt: now, error: { code: error.code ?? 'UPDATE_FAILED', message: error.message } });
    throw error;
  }
}
