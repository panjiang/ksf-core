import { sha256 as sha } from '../shared/hash.js';
import { portable } from '../shared/paths.js';
import { validateObjectInput, validateObjectWrite, selectObjectState, planObjectChange } from '../objects/plan.js';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from '../vendor/yaml/dist/index.js';
import { parseInput, equalValues } from '../metadata/input.js';
import { decodeUtf8 } from '../metadata/errors.js';
import { readSnapshot, publishFile } from '../metadata/files.js';
import { parseFrontmatter } from '../metadata/frontmatter.js';
import { types, protectedPaths, parseReference, fail, compare } from '../objects/schema.js';
import { catalog, fingerprint, summary } from '../objects/catalog.js';
import { resolveObject, referenceResults, problems } from '../objects/references.js';
import { safeDirectory, withObjectLock, readTree, copyTree, writeDurably, stageDirectory, removeDirectory, canonicalRoot } from '../objects/storage.js';
import { validSourceId } from '../sources/schema.js';

export function parseObjectInput(text, target) {
  return validateObjectInput(parseInput(text, target));
}

function upstream(root, row, { verify = false } = {}) {
  const directory = join(root, row.directory, '.upstream');
  const declared = row.metadata.upstream;
  if (!declared && !existsSync(directory)) return null;
  if (!declared || !existsSync(directory)) fail('OBJECT_BASELINE_INVALID', 'Derived identity and baseline directory must both be present.', { id: row.id });
  safeDirectory(root, portable(relative(root, directory)));
  let origin;
  try { origin = JSON.parse(decodeUtf8(readSnapshot(join(directory, 'origin.json')).bytes, 'origin.json')); }
  catch { fail('OBJECT_BASELINE_INVALID', 'Cannot read the user object baseline manifest.', { id: row.id }); }
  if (origin.id !== row.id || origin.version !== row.metadata.version || !Array.isArray(origin.files) || !Array.isArray(origin.directories) || typeof origin.digest !== 'string') {
    fail('OBJECT_BASELINE_INVALID', 'Baseline identity or version does not match the user definition.', { id: row.id });
  }
  if (verify) {
    const snapshot = readTree(join(directory, 'snapshot'));
    const files = snapshot.files.map(f => ({ path: f.path, sha256: f.digest }));
    const directories = snapshot.directories.map(d => d.path);
    if (!equalValues(origin.files, files) || !equalValues(origin.directories, directories) || origin.digest !== sha(JSON.stringify({ files, directories }))) {
      fail('OBJECT_BASELINE_INVALID', 'System baseline snapshot changed or is incomplete.', { id: row.id });
    }
  }
  return origin;
}

function ksfVersion(root) {
  const path = join(root, '.agents/core/manifest.yaml');
  if (!existsSync(path)) return null;
  const doc = YAML.parseDocument(decodeUtf8(readSnapshot(path).bytes, path), { version: '1.2', schema: 'core', uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) fail('OBJECT_BASELINE_INVALID', 'KSF manifest cannot be read for baseline provenance.');
  return doc.get('version') ?? null;
}

function view(row, part) {
  const result = { id: row.id, source: row.source, path: row.path, directory: row.directory,
    ...(row.sourceRoot ? { source_root: row.sourceRoot } : {}),
    version: row.metadata.version, user_revision: row.metadata.user_revision ?? null, definition_digest: row.digest, protected: Object.hasOwn(protectedPaths, row.id) };
  if (part !== 'body') result.metadata = row.metadata;
  if (part !== 'metadata') result.body = row.parsed.body.toString('utf8');
  return result;
}

export function objectQuery({ root, type, operation, reference, source = 'effective', part = 'all', sourceScope }) {
  if (type === 'workflow') fail('OBJECT_TYPE_RENAMED', 'Use the cooperation type; migrate existing data with ksf cooperation migrate --apply.', { replacement: 'cooperation', exitCode: 2 });
  if (!Object.hasOwn(types, type) || !['list', 'read', 'check'].includes(operation) ||
      (!['effective', 'system', 'user', ...(operation === 'list' ? ['all'] : [])].includes(source) && !validSourceId(source)) || !['metadata', 'body', 'all'].includes(part)) fail('INVALID_ARGUMENTS', 'Invalid object query.', { exitCode: 2 });
  root = canonicalRoot(root);
  const c = catalog(root, { sourceFilter: sourceScope ?? (validSourceId(source) ? source : undefined) });
  for (const selected of [sourceScope, validSourceId(source) ? source : undefined].filter(Boolean)) {
    if (!c.sources.some(entry => entry.id === selected)) {
      const registryError = c.errors.find(error => error.source === '@registry');
      if (registryError) fail(registryError.code, registryError.message, { source: selected });
      fail('INVALID_ARGUMENTS', 'Unknown linked ability source.', { source: selected, exitCode: 2 });
    }
  }
  if (operation === 'list') {
    const errors = problems(c, { type, source });
    let selected;
    if (source !== 'effective') selected = c.rows.filter(r => r.type === type && !r.errors.length && (source === 'all' || r.source === source));
    else {
      selected = [];
      for (const id of new Set(c.rows.filter(r => r.type === type && r.id).map(r => r.id))) {
        try { selected.push(resolveObject(c, { id })); }
        catch (error) { if (error.code !== 'OBJECT_NOT_FOUND') errors.push({ code: error.code, message: error.message, id }); }
      }
    }
    selected.sort((a, b) => compare(a.id, b.id) || compare(a.source, b.source) || compare(a.path, b.path));
    return { data: { complete: errors.length === 0, scopes: c.scopes.filter(s => s.type === type && (source === 'all' || source === 'effective' || s.source === source)), objects: selected.map(row => {
      let effective = false;
      try { effective = resolveObject(c, { id: row.id }).path === row.path; } catch { /* invalid competing definition */ }
      return { ...summary(row), effective };
    }) }, errors };
  }
  const parsedReference = parseReference(reference, type);
  if (operation === 'check') {
    const rows = c.rows.filter(r => r.id === parsedReference.id && (source === 'effective' || r.source === source));
    const localErrors = problems(c, { type, source }).filter(e => !e.id || e.id === parsedReference.id);
    let row;
    try { row = resolveObject(c, parsedReference, source); }
    catch (error) { localErrors.push({ code: error.code, message: error.message, ...error.details }); }
    const references = row ? referenceResults(c, row) : [];
    localErrors.push(...references.filter(r => r.error).map(r => r.error));
    if (row?.source === 'user') {
      try { upstream(root, row, { verify: true }); }
      catch (error) { localErrors.push({ code: error.code, message: error.message }); }
    }
    return { data: { id: parsedReference.id, valid: localErrors.length === 0 && !!row, ...(row ? { object: summary(row) } : {}), checkedPaths: rows.map(r => r.path), references }, errors: localErrors };
  }
  const row = resolveObject(c, parsedReference, source);
  const references = referenceResults(c, row);
  return { data: { object: view(row, part), references }, errors: references.filter(r => r.error).map(r => r.error) };
}

export function objectMutation({ root, type, operation, id, input = {}, dryRun = false, ifMatch }, { beforePublish, cleanup } = {}) {
  if (type === 'workflow') fail('OBJECT_TYPE_RENAMED', 'Use the cooperation type; migrate existing data with ksf cooperation migrate --apply.', { replacement: 'cooperation', exitCode: 2 });
  if (!Object.hasOwn(types, type) || !['write', 'remove'].includes(operation) || typeof dryRun !== 'boolean') fail('INVALID_ARGUMENTS', 'Invalid object mutation.', { exitCode: 2 });
  if (operation === 'write') validateObjectInput(input);
  root = canonicalRoot(root);
  const parsedId = parseReference(id, type);
  if (parsedId.version) fail('INVALID_ARGUMENTS', 'write/remove accept a plain ID.', { exitCode: 2 });
  if (Object.hasOwn(protectedPaths, id)) fail('OBJECT_PROTECTED', 'Fixed system entries cannot be derived, modified or deleted by object commands.', { id });
  const action = () => {
    const state = loadObjectState({ root, type, operation, id }, input);
    if (ifMatch !== undefined && (typeof ifMatch !== 'string' || ifMatch !== (state.base?.digest ?? 'missing'))) {
      fail('OBJECT_CONFLICT', 'Object changed since it was read. Reload and compare before saving.', { id });
    }
    const plan = planObjectChange(state, { input, dryRun });
    if (!dryRun && plan.changed) commitObjectChange(state, plan, { beforePublish, cleanup });
    return { data: plan.result, errors: [] };
  };
  return dryRun ? action() : withObjectLock(root, action);
}

function loadObjectState(request, input) {
  const { root, operation } = request;
  const c = catalog(root), before = fingerprint(c);
  const state = selectObjectState(c, request);
  const tree = state.sourceDirectory ? readTree(state.sourceDirectory) : null;
  let origin = null;
  if (operation === 'write') {
    validateObjectWrite(state, input);
    origin = state.existing ? upstream(root, state.existing, { verify: true }) : null;
  }
  return { ...state, before, tree, origin };
}

function commitObjectChange(state, plan, { beforePublish, cleanup }) {
  const { root, type, operation, id, existing, system, directory, sourceDirectory, tree, before } = state;
  const { result, encoded, derivedFiles, derived, proposed } = plan;
  const verify = ({ temporary } = {}) => {
    beforePublish?.();
    if (fingerprint(catalog(root)) !== before || (tree && readTree(sourceDirectory, { exclude: temporary ? [temporary] : [] }).fingerprint !== tree.fingerprint)) fail('OBJECT_CONFLICT', 'Objects or resources changed before publication.', { id });
  };
  if (operation === 'remove') {
    removeDirectory(directory, verify, { ...(cleanup ? { cleanup } : {}) });
    result.changed = true; result.removedFromCatalog = true;
    return;
  }
  if (existing) {
    verify();
    publishFile(existing.snapshot, encoded.bytes, { beforeCheck: verify });
    result.changed = true;
    return;
  }
  const parent = safeDirectory(root, types[type].user);
  if (existsSync(directory)) fail('OBJECT_PATH_CONFLICT', 'Destination directory already exists.', { target: proposed.directory });
  const staging = stageDirectory(parent);
  try {
    if (derived) {
      copyTree({ ...tree, files: derivedFiles }, staging, { writable: true });
      const upstreamDirectory = join(staging, '.upstream'); mkdirSync(upstreamDirectory);
      copyTree(tree, join(upstreamDirectory, 'snapshot'));
      const files = tree.files.map(f => ({ path: f.path, sha256: f.digest }));
      const directories = tree.directories.map(d => d.path);
      const baseline = { id, version: system.metadata.version, ksf_version: ksfVersion(root), sourcePath: system.directory, files, directories, digest: sha(JSON.stringify({ files, directories })) };
      writeDurably(join(upstreamDirectory, 'origin.json'), JSON.stringify(baseline, null, 2) + '\n');
    }
    writeDurably(join(staging, types[type].entry), encoded.bytes, { exclusive: !derived });
    verify();
    if (existsSync(directory)) fail('OBJECT_PATH_CONFLICT', 'Destination appeared during object preparation.');
    renameSync(staging, directory); result.changed = true;
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
}
