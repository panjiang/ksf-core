import {configuration} from './configuration.js';
import {repositoryExports, projectedPath} from './repository-exports.js';
import {platform} from '../platform/index.js';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { checkedPath, readJSON, textBytes, writeAtomic, writeJSON } from './files.js';
import { digestObject, isSHA, sha256 } from '../shared/hash.js';
import { fail } from './errors.js';
import { isRepository, isBranch, isRevision } from './git-values.js';
import { committedSource, contributionBaseline, contributionPath as eligible, isLocalCommit } from './committed-source.js';
import { GitHubAPI, treeFromChanges } from './github.js';
import { matchesBaseline, resolveBaseline } from './baseline.js';
import { contributionCommitMessage, checkCommitMessage } from '../services/commit-message.js';
import { requirePRDescription, checkPRDescription, contributionPRBody } from '../services/pr-description.js';

function publicDiff(path, base, bytes, baseMode, mode) {
  if ((base !== null && !textBytes(base)) || (bytes !== null && !textBytes(bytes))) return `Binary change: ${path}\n`;
  const temporary = mkdtempSync(join(tmpdir(), 'ksf-contribution-diff-'));
  try {
    writeAtomic(join(temporary, 'before'), base ?? Buffer.alloc(0)); writeAtomic(join(temporary, 'after'), bytes ?? Buffer.alloc(0));
    const diff = spawnSync(platform.tool('diff'), ['-u', '-L', base === null ? '/dev/null' : `a/${path}`, '-L', bytes === null ? '/dev/null' : `b/${path}`, join(temporary, 'before'), join(temporary, 'after')], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
    });
    if (![0, 1].includes(diff.status)) fail('DIFF_FAILED', 'Could not prepare the public diff.');
    return (baseMode !== mode ? `Mode ${baseMode?.toString(8) ?? 'absent'} -> ${mode?.toString(8) ?? 'absent'}: ${path}\n` : '') + diff.stdout;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export async function prepareContribution({ root, paths, all = false, title, body, prBody, dryRun = false, api, fetcher }) {
  if ((!all && (!Array.isArray(paths) || !paths.length)) || (all && paths?.length)) fail('CONTRIBUTION_SELECTION_REQUIRED', 'Choose --paths or --all after reviewing the system changes.');
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\r\n]/.test(title) || typeof body !== 'string' || body.length > 60000) fail('CONTRIBUTION_INVALID', 'Invalid contribution title or description.');
  const commitMessage = contributionCommitMessage(title, body);
  const prDescription = requirePRDescription(title, prBody);
  if (paths?.some(path => !eligible(path))) fail('CONTRIBUTION_PATH_INVALID', 'Contributions may select only system source files.');
  const source = committedSource(root), { manifest: receipt, baseline } = contributionBaseline(source);
  const manifest = await resolveBaseline(receipt, { api, fetcher });
  const selected = all ? [...new Set([...Object.keys(manifest.files), ...source.entries.keys()])].filter(eligible) : [...new Set(paths)];
  if (selected.some(path => !eligible(path))) fail('CONTRIBUTION_PATH_INVALID', 'Contributions may select only system files; generated manifests, private directories and Git data are excluded.');
  const changes = [], destinations = new Map();
  for (const batch of source.readBatches(selected.sort())) for (const [path, file] of batch) {
    const original = manifest.files[path], bytes = file?.bytes ?? null, mode = file?.mode ?? null;
    const checksum = bytes === null ? null : sha256(bytes);
    if (matchesBaseline(file, original ?? null)) continue;
    const sourcePath = original?.source_path ?? path;
    if (!eligible(sourcePath)) fail('CONTRIBUTION_PATH_INVALID', 'The release maps a selected file outside Core source.');
    const sourceMode = mode ?? original?.mode ?? 0o644;
    const originalBytes = original ? await manifest.read(path) : null;
    const change = { workspace_path: path, source_path: sourcePath, workspace_mode: mode,
      operation: bytes === null ? 'delete' : original ? 'update' : 'add',
      before_sha256: originalBytes === null ? null : sha256(originalBytes), before_mode: original?.mode ?? null, after_sha256: checksum,
      mode: sourceMode, content: bytes === null ? null : bytes.toString('base64'),
      diff: publicDiff(sourcePath, originalBytes, bytes, original?.mode ?? null, bytes === null ? null : sourceMode) };
    if (destinations.has(sourcePath)) {
      const previous = destinations.get(sourcePath);
      if (previous.after_sha256 !== change.after_sha256 || previous.mode !== change.mode) fail('CONTRIBUTION_MAPPING_CONFLICT', `Two workspace files propose different content for ${sourcePath}.`);
      continue;
    }
    destinations.set(sourcePath, change); changes.push(change);
    const exportPath = repositoryExports[path];
    if (exportPath) {
      const base = await manifest.readSource(exportPath), before = base?.bytes ?? null;
      if (bytes === null ? before !== null : before === null || !bytes.equals(before) || mode !== base.mode) {
        const projected = { ...change, source_path: exportPath,
          operation: bytes === null ? 'delete' : before === null ? 'add' : 'update',
          before_sha256: before === null ? null : sha256(before), before_mode: base?.mode ?? null,
          diff: publicDiff(exportPath, before, bytes, base?.mode ?? null, mode) };
        if (destinations.has(exportPath)) fail('CONTRIBUTION_MAPPING_CONFLICT', `Duplicate repository export: ${exportPath}.`);
        destinations.set(exportPath, projected); changes.push(projected);
      }
    }
  }
  if (committedSource(root).headCommit !== source.sourceCommit) fail('CONTRIBUTION_STALE', 'HEAD changed during preparation; prepare again.');
  if (!changes.length) fail('CONTRIBUTION_EMPTY', 'HEAD has no selected system changes relative to its original Core baseline.', {
    sourceCommit: source.sourceCommit, core: manifest.core, version: manifest.version, baseline, comparedFiles: selected.length, changes: [],
  });
  const publicPRBody = contributionPRBody(prDescription, manifest.version, manifest.core.revision);
  requirePRDescription(title, publicPRBody);
  const plan = { schema_version: 5, target: { repository: manifest.core.repository, branch: configuration(root).core_branch }, id: randomUUID(), created_at: new Date().toISOString(), sourceCommit: source.sourceCommit,
    baseline, core: manifest.core, version: manifest.version, title, body, commitMessage, prDescription, prBody: publicPRBody, changes };
  const digest = digestObject(plan), directory = `.agents/runtime-data/contributions/${plan.id}`;
  const warnings = await previousContributionWarnings(root, plan, api, fetcher);
  if (!dryRun) {
    writeJSON(checkedPath(root, `${directory}/plan.json`), { ...plan, digest });
    writeAtomic(checkedPath(root, `${directory}/review.diff`), changes.map(c => c.diff).join('\n'));
  }
  return { ...plan, digest, dryRun, warnings, reviewPath: dryRun ? null : `${directory}/review.diff` };
}
export function readContribution({ root, id }) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('CONTRIBUTION_INVALID', 'Invalid contribution ID.');
  const stored = readJSON(root, `.agents/runtime-data/contributions/${id}/plan.json`), { digest, ...plan } = stored;
  if (!isSHA(digest) || digestObject(plan) !== digest || ![1, 2, 3, 4, 5].includes(plan.schema_version) || plan.id !== id ||
      !isRepository(plan.core?.repository) || !isBranch(plan.core?.branch) || !isRevision(plan.core?.revision) ||
      !Array.isArray(plan.changes) || !plan.changes.length) fail('CONTRIBUTION_TAMPERED', 'The prepared contribution changed; prepare and review it again.');
  if (plan.schema_version === 5 && (!isRepository(plan.target?.repository) || plan.target.repository !== plan.core.repository || !isBranch(plan.target?.branch))) fail('CONTRIBUTION_INVALID', 'Invalid frozen upstream target.');
  if (plan.schema_version >= 2 && (!isLocalCommit(plan.sourceCommit) || !isSHA(plan.baseline?.manifest_sha256) ||
      ![2, 3, 4, 5].includes(plan.baseline?.schema_version))) fail('CONTRIBUTION_INVALID', 'Invalid committed contribution source or baseline.');
  if (plan.schema_version >= 3 && (typeof plan.commitMessage !== 'string' || !checkCommitMessage(plan.commitMessage).valid ||
      plan.commitMessage !== contributionCommitMessage(plan.title, plan.body))) fail('CONTRIBUTION_INVALID', 'Invalid frozen commit message.');
  if (plan.schema_version >= 4 && (!checkPRDescription(plan.title, plan.prDescription).valid ||
      !checkPRDescription(plan.title, plan.prBody).valid ||
      plan.prBody !== contributionPRBody(plan.prDescription, plan.version, plan.core.revision))) fail('CONTRIBUTION_INVALID', 'Invalid frozen PR description or provenance.');
  const destinations = new Set();
  for (const change of plan.changes) {
    if (!change || !eligible(change.workspace_path) || !(eligible(change.source_path) || (plan.schema_version === 5 && projectedPath(change.workspace_path, change.source_path))) || ![0o644, 0o755].includes(change.mode) ||
        destinations.has(change.source_path) || !['add', 'update', 'delete'].includes(change.operation) ||
        !(change.before_sha256 === null || isSHA(change.before_sha256)) ||
        (plan.schema_version >= 2 && ![null, 0o644, 0o755].includes(change.before_mode)) ||
        (change.content === null ? change.after_sha256 !== null || change.operation !== 'delete' :
          !isSHA(change.after_sha256) || change.operation === 'delete') ||
        (change.content !== null && (typeof change.content !== 'string' || sha256(Buffer.from(change.content, 'base64')) !== change.after_sha256))) fail('CONTRIBUTION_INVALID', 'Invalid prepared system change.');
    destinations.add(change.source_path);
  }
  return { ...plan, digest };
}

const blobID = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
async function remoteTree(github, repository, sha) {
  const tree = await github.request('GET', `/repos/${repository}/git/trees/${sha}?recursive=1`);
  if (tree?.sha !== sha || tree.truncated !== false || !Array.isArray(tree.tree)) {
    fail('CONTRIBUTION_BASELINE_UNVERIFIED', 'Could not read the complete original Core tree.');
  }
  const entries = new Map();
  for (const entry of tree.tree) {
    if (typeof entry?.path !== 'string' || entries.has(entry.path) || !isRevision(entry.sha)) fail('GITHUB_RESPONSE_INVALID', 'Invalid Core tree entry.');
    entries.set(entry.path, entry);
  }
  return entries;
}
async function verifyRemoteBaseline(github, plan) {
  const base = await github.request('GET', `/repos/${plan.core.repository}/git/commits/${plan.core.revision}`);
  if (base?.sha !== plan.core.revision || !isRevision(base.tree?.sha)) fail('CONTRIBUTION_BASELINE_UNVERIFIED', 'The original Core commit could not be verified.');
  const entries = await remoteTree(github, plan.core.repository, base.tree.sha);
  for (const change of plan.changes) {
    const original = entries.get(change.source_path);
    if (change.before_sha256 === null) {
      if (original) fail('CONTRIBUTION_BASELINE_MISMATCH', `The original Core already contains ${change.source_path}.`);
      continue;
    }
    if (!original || original.type !== 'blob' || !['100644', '100755'].includes(original.mode) ||
        (change.before_mode != null && Number.parseInt(original.mode, 8) % 0o1000 !== change.before_mode)) {
      fail('CONTRIBUTION_BASELINE_MISMATCH', `The original Core file or mode differs: ${change.source_path}.`);
    }
    const blob = await github.request('GET', `/repos/${plan.core.repository}/git/blobs/${original.sha}`);
    if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') fail('CONTRIBUTION_BASELINE_UNVERIFIED', 'Could not read the original Core blob.');
    const bytes = Buffer.from(blob.content, 'base64');
    if (blob.sha !== original.sha || blobID(bytes) !== original.sha || sha256(bytes) !== change.before_sha256) {
      fail('CONTRIBUTION_BASELINE_MISMATCH', `The original Core content differs: ${change.source_path}.`);
    }
  }
  return { base, entries };
}
function verifyLocalSource(root, plan, published) {
  const source = committedSource(root, { commit: plan.sourceCommit }), { manifest, baseline } = contributionBaseline(source);
  if ((!published && source.headCommit !== plan.sourceCommit) || baseline.manifest_sha256 !== plan.baseline.manifest_sha256 || baseline.schema_version !== plan.baseline.schema_version ||
      manifest.core.revision !== plan.core.revision || manifest.core.repository !== plan.core.repository || manifest.core.branch !== plan.core.branch ||
      manifest.version !== plan.version) fail('CONTRIBUTION_STALE', 'HEAD or its release baseline changed; prepare and review again.');
  for (const change of plan.changes) {
    const file = source.read(change.workspace_path), original = manifest.files?.[change.workspace_path];
    // Compact receipts bind the immutable Core identity. The frozen preimage is
    // checked against that remote Core before any write, including for dry-run
    // plans whose local verification must not need a network request.
    if ([4, 5].includes(manifest.schema_version) || plan.schema_version === 5) {
      if ((file ? sha256(file.bytes) : null) !== change.after_sha256 || (file?.mode ?? null) !== change.workspace_mode ||
          (change.source_path !== change.workspace_path && !projectedPath(change.workspace_path, change.source_path)) || change.mode !== (file?.mode ?? change.before_mode ?? 0o644) ||
          change.operation !== (!file ? 'delete' : change.before_sha256 === null ? 'add' : 'update')) {
        fail('CONTRIBUTION_STALE', 'The prepared content does not match the recorded local commit.');
      }
      continue;
    }
    if ((file ? sha256(file.bytes) : null) !== change.after_sha256 || (file?.mode ?? null) !== change.workspace_mode ||
        (original?.sha256 ?? null) !== change.before_sha256 || (original?.mode ?? null) !== change.before_mode ||
        (original?.source_path ?? change.workspace_path) !== change.source_path ||
        change.mode !== (file?.mode ?? original?.mode ?? 0o644) ||
        change.operation !== (!file ? 'delete' : original ? 'update' : 'add')) fail('CONTRIBUTION_STALE', 'The prepared content does not match the recorded local commit and baseline.');
  }
}
async function verifyLegacyTree(github, repository, treeSHA, entries, changes) {
  const expected = new Map([...entries].filter(([, entry]) => entry.type !== 'tree').map(([path, entry]) => [path, `${entry.mode}:${entry.type}:${entry.sha}`]));
  for (const change of changes) {
    if (change.content === null) expected.delete(change.source_path);
    else expected.set(change.source_path, `${change.mode === 0o755 ? '100755' : '100644'}:blob:${blobID(Buffer.from(change.content, 'base64'))}`);
  }
  const actual = [...await remoteTree(github, repository, treeSHA)].filter(([, entry]) => entry.type !== 'tree');
  if (actual.length !== expected.size || actual.some(([path, entry]) => expected.get(path) !== `${entry.mode}:${entry.type}:${entry.sha}`)) {
    fail('CONTRIBUTION_BRANCH_CHANGED', 'The legacy contribution no longer matches its frozen system changes.');
  }
}
export async function submitContribution({ root, id, reviewed, dryRun = false, api, reconcileOnly = false }) {
  const plan = readContribution({ root, id }), legacy = plan.schema_version < 5;
  const targetBranch = plan.target?.branch ?? plan.core.branch;
  if (reviewed !== plan.digest) fail('CONTRIBUTION_REVIEW_REQUIRED', 'Supply the digest of the contribution preview using --reviewed.');
  const statePath = `.agents/runtime-data/contributions/${id}/submitted.json`;
  const previous = readJSON(root, statePath, true);
  if (previous && previous.digest !== plan.digest) fail('CONTRIBUTION_TAMPERED', 'Published contribution state does not match the reviewed plan.');
  if (previous && previous.branch !== `contrib-${id}`) fail('CONTRIBUTION_TAMPERED', 'Published contribution branch does not match this plan.');
  if (previous && (!isRepository(previous.repository) || previous.target !== plan.core.repository)) fail('CONTRIBUTION_TAMPERED', 'Invalid saved contribution repository or target.');
  if (previous && (!isRevision(previous.commit) || (previous.tree !== undefined && !isRevision(previous.tree)))) fail('CONTRIBUTION_TAMPERED', 'Invalid saved contribution commit or tree.');
  if (previous?.url && (!Number.isSafeInteger(previous.number) || previous.number < 1 || !isRevision(previous.commit) ||
      previous.url !== `https://github.com/${plan.core.repository}/pull/${previous.number}`)) fail('CONTRIBUTION_TAMPERED', 'Saved PR identity is invalid.');
  if (legacy && !previous) fail('CONTRIBUTION_LEGACY_PLAN', 'Legacy previews cannot publish; prepare again from the latest local commit.');
  if (!legacy) verifyLocalSource(root, plan, !!previous);
  if (dryRun) return { id, digest: plan.digest, sourceCommit: plan.sourceCommit ?? null, dryRun, repository: plan.core.repository, base: targetBranch,
    files: plan.changes.map(c => ({ path: c.source_path, operation: c.operation })), title: plan.title,
    commitMessage: plan.commitMessage ?? null, prBody: plan.prBody ?? null,
    wouldPublish: !legacy, reconcileOnly: legacy, remoteVerified: false };
  const github = api ?? new GitHubAPI();
  const { base, entries: baseEntries } = await verifyRemoteBaseline(github, plan);
  // A legacy plan can only reconcile an existing PR. Its saved source is
  // independent of which account currently has read access to that PR.
  if (!legacy && !previous && !reconcileOnly) {
    const duplicates = previousPlans(root, plan).filter(match => match.sameContent);
    if (duplicates.length) {
      const match = duplicates[0], existing = await submitContribution({ root, id: match.plan.id, reviewed: match.plan.digest, api: github, reconcileOnly: true });
      return { ...existing, duplicate: true, requestedId: id, warning: 'These system changes already have a PR; the existing PR was verified and no duplicate was created.' };
    }
  }
  const readerOnly = legacy || reconcileOnly;
  if (reconcileOnly && !previous) fail('CONTRIBUTION_PREVIOUS_ATTEMPT', 'An earlier plan may have been published; resume that contribution ID before creating another PR.', { id });
  const profile = readerOnly ? { login: previous.repository.split('/')[0] } : await github.request('GET', '/user');
  const owner = plan.core.repository.split('/')[0];
  if (typeof profile.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(profile.login)) fail('GITHUB_RESPONSE_INVALID', 'Invalid authenticated GitHub login.');
  if (!readerOnly && !previous) {
    // Persist intent before the first possible write (including fork/blob/ref).
    // An unknown response must remain discoverable from a newly prepared ID.
    writeJSON(checkedPath(root, `.agents/runtime-data/contributions/${id}/attempted.json`), { id, digest: plan.digest });
  }
  let repository = readerOnly ? previous.repository : plan.core.repository;
  if (readerOnly ? repository.toLowerCase() !== plan.core.repository.toLowerCase() : profile.login.toLowerCase() !== owner.toLowerCase()) {
    if (!readerOnly) repository = `${profile.login}/${plan.core.repository.split('/')[1]}`;
    let fork = await github.request('GET', `/repos/${repository}`, undefined, { optional: true });
    if (!fork && !previous && !readerOnly) {
      verifyLocalSource(root, plan, false);
      await github.request('POST', `/repos/${plan.core.repository}/forks`, {});
      for (let attempt = 0; attempt < 6 && !fork; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
        fork = await github.request('GET', `/repos/${repository}`, undefined, { optional: true });
      }
    }
    if (!fork || fork.parent?.full_name?.toLowerCase() !== plan.core.repository.toLowerCase()) fail('FORK_INVALID', 'The account repository is not a fork of the configured Core; no files were pushed.');
  }
  if (previous && (previous.repository !== repository || previous.target !== plan.core.repository || !isRevision(previous.commit) ||
      (previous.tree !== undefined && !isRevision(previous.tree)))) fail('CONTRIBUTION_TAMPERED', 'Saved contribution source identity is invalid.');
  const branch = `contrib-${id}`, head = `${profile.login}:${branch}`;
  let pr;
  if (previous?.url) {
    pr = await github.request('GET', `/repos/${plan.core.repository}/pulls/${previous.number}`, undefined, { optional: true });
    if (!pr) fail('CONTRIBUTION_PR_MISSING', 'The saved PR is no longer available; no replacement was created.');
  } else {
    const matches = await github.request('GET', `/repos/${plan.core.repository}/pulls?state=all&head=${encodeURIComponent(head)}&base=${encodeURIComponent(targetBranch)}&per_page=100`);
    if (!Array.isArray(matches)) fail('GITHUB_RESPONSE_INVALID', 'Invalid PR lookup response.');
    const selected = matches.filter(p => p.head?.ref === branch && p.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
      p.base?.ref === targetBranch && p.base?.repo?.full_name?.toLowerCase() === plan.core.repository.toLowerCase());
    if (selected.length > 1) fail('CONTRIBUTION_PR_CONFLICT', 'Multiple PRs refer to this contribution; inspect them before retrying.');
    if (selected.length) pr = await github.request('GET', `/repos/${plan.core.repository}/pulls/${selected[0].number}`);
  }
  const validatePR = value => {
    if (!Number.isSafeInteger(value?.number) || value.number < 1 || value.html_url !== `https://github.com/${plan.core.repository}/pull/${value.number}` ||
        value.head?.ref !== branch || value.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() || !isRevision(value.head?.sha) ||
        value.base?.ref !== targetBranch || value.base?.repo?.full_name?.toLowerCase() !== plan.core.repository.toLowerCase() ||
        !['open', 'closed'].includes(value.state)) fail('CONTRIBUTION_PR_CHANGED', 'The PR no longer matches this contribution source and target.');
  };
  if (pr) validatePR(pr);
  if (reconcileOnly && !pr) fail('CONTRIBUTION_PREVIOUS_ATTEMPT', 'The previous publication has no verified PR yet; resume its original contribution ID.', { id });
  if (legacy && !pr) fail('CONTRIBUTION_LEGACY_PLAN', 'No existing PR was found for this legacy plan; no new remote objects were created.');
  let ref = await github.request('GET', `/repos/${repository}/git/ref/heads/${branch}`, undefined, { optional: true });
  if (previous && ref && ref.object?.sha !== previous.commit) fail('CONTRIBUTION_BRANCH_CHANGED', 'The contribution branch changed remotely; it will not be overwritten.');
  if (previous && !ref && !(pr && pr.state === 'closed')) fail('CONTRIBUTION_BRANCH_MISSING', 'The open contribution branch is missing; it will not be recreated.');
  const reused = !!pr;
  // Saved modern trees and legacy PR reconciliation both use reads only.
  if (!legacy && !previous) verifyLocalSource(root, plan, false);
  const tree = readerOnly ? null : previous?.tree ? { sha: previous.tree } : await treeFromChanges(github, repository, plan.changes, base.tree.sha);
  if (!readerOnly && !isRevision(tree?.sha)) fail('GITHUB_RESPONSE_INVALID', 'Invalid contribution tree response.');
  let commit = ref?.object?.sha ?? previous?.commit;
  let legacyTree;
  if (ref) {
    const existing = await github.request('GET', `/repos/${repository}/git/commits/${ref.object.sha}`);
    if (plan.schema_version >= 3 && existing.message !== plan.commitMessage) fail('CONTRIBUTION_BRANCH_CHANGED', 'The remote commit message differs from the reviewed message.');
    if ((!readerOnly && existing.tree.sha !== tree.sha) || existing.parents?.length !== 1 || existing.parents[0].sha !== plan.core.revision) fail('CONTRIBUTION_BRANCH_CHANGED', 'The contribution branch was changed remotely; it will not be overwritten.');
    if (readerOnly) { await verifyLegacyTree(github, repository, existing.tree.sha, baseEntries, plan.changes); legacyTree = existing.tree.sha; }
  } else if (previous) {
    const existing = await github.request('GET', `/repos/${repository}/git/commits/${commit}`);
    if (plan.schema_version >= 3 && existing.message !== plan.commitMessage) fail('CONTRIBUTION_BRANCH_CHANGED', 'The remote commit message differs from the reviewed message.');
    if ((!readerOnly && existing.tree.sha !== tree.sha) || existing.parents?.length !== 1 || existing.parents[0].sha !== plan.core.revision) fail('CONTRIBUTION_BRANCH_CHANGED', 'The merged contribution commit differs from the reviewed contribution.');
    if (readerOnly) { await verifyLegacyTree(github, repository, existing.tree.sha, baseEntries, plan.changes); legacyTree = existing.tree.sha; }
  } else if (pr) {
    fail('CONTRIBUTION_BRANCH_MISSING', 'A PR exists without a recoverable contribution branch; inspect it before retrying.');
  } else {
    verifyLocalSource(root, plan, false);
    const created = await github.request('POST', `/repos/${repository}/git/commits`, { message: plan.commitMessage,
      tree: tree.sha, parents: [plan.core.revision] });
    if (!isRevision(created?.sha)) fail('GITHUB_RESPONSE_INVALID', 'Invalid contribution commit response.');
    verifyLocalSource(root, plan, false);
    ref = await github.request('POST', `/repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: created.sha });
    if (ref?.object?.sha !== created.sha) fail('GITHUB_RESPONSE_INVALID', 'Created branch does not match the contribution commit.');
    commit = ref.object.sha;
  }
  if (pr && pr.head.sha !== commit) fail('CONTRIBUTION_PR_CHANGED', 'The PR head differs from the verified contribution commit.');
  const state = { id, digest: plan.digest, repository, branch, commit, tree: tree?.sha ?? legacyTree, target: plan.core.repository };
  if (!pr) writeJSON(checkedPath(root, statePath), state);
  if (!pr && !previous) verifyLocalSource(root, plan, false);
  if (!pr) pr = await github.request('POST', `/repos/${plan.core.repository}/pulls`, { title: plan.title, head, base: targetBranch,
    body: plan.prBody, draft: true });
  validatePR(pr);
  if (pr.head.sha !== commit) fail('CONTRIBUTION_PR_CHANGED', 'Created PR does not match the verified contribution commit.');
  const final = { ...state, number: pr.number, url: pr.html_url, draft: pr.draft === true,
    state: pr.state, merged: pr.merged === true || !!pr.merged_at, reused,
    ...(reused ? { warning: 'This contribution already has a PR; its current remote state was verified.' } : {}) };
  if (!readerOnly) writeJSON(checkedPath(root, statePath), final);
  return legacy ? { ...final, legacy: true, reconcileOnly: true } : final;
}

function contributionContent(plan) {
  // The immutable Core commit already fixes original permissions. Omitting the
  // redundant before_mode also recognizes old PRs without inventing a local
  // sourceCommit for their schema-1 plans.
  return digestObject({ core: { repository: plan.core.repository, branch: plan.core.branch, revision: plan.core.revision },
    changes: plan.changes.map(c => ({ path: c.source_path, before: c.before_sha256,
      after: c.after_sha256, mode: c.mode })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
}
function previousPlans(root, plan) {
  const directory = checkedPath(root, '.agents/runtime-data/contributions');
  if (!existsSync(directory)) return [];
  const found = [], content = contributionContent(plan);
  for (const id of readdirSync(directory).sort()) {
    if (id === plan.id || !/^[a-f0-9-]{36}$/.test(id)) continue;
    const state = readJSON(root, `.agents/runtime-data/contributions/${id}/submitted.json`, true);
    const attempted = readJSON(root, `.agents/runtime-data/contributions/${id}/attempted.json`, true);
    if (!state && !attempted) continue;
    const previous = readContribution({ root, id });
    if (attempted && (attempted.id !== id || attempted.digest !== previous.digest)) fail('CONTRIBUTION_TAMPERED', 'A previous publication attempt does not match its reviewed plan.');
    if (previous.core.repository !== plan.core.repository) continue;
    const sameContent = contributionContent(previous) === content;
    if (sameContent || previous.sourceCommit === plan.sourceCommit) found.push({ plan: previous, sameContent });
  }
  return found;
}
async function previousContributionWarnings(root, plan, api, fetcher) {
  const warnings = [];
  for (const previous of previousPlans(root, plan)) {
    try {
      const state = await submitContribution({ root, id: previous.plan.id, reviewed: previous.plan.digest,
        api: api ?? new GitHubAPI({ readOnly: true, fetcher }), reconcileOnly: true });
      warnings.push({ code: 'CONTRIBUTION_PREVIOUS_PR', id: state.id, url: state.url, state: state.state, merged: state.merged,
        draft: state.draft, sameSourceCommit: previous.plan.sourceCommit === plan.sourceCommit, sameContent: previous.sameContent, remoteVerified: true,
        message: previous.sameContent ? 'These system changes were already submitted; use the existing PR.' : 'This local commit already has a PR for another selection of system changes.' });
    } catch (error) {
      warnings.push({ code: 'CONTRIBUTION_PREVIOUS_PR_UNKNOWN', id: previous.plan.id, sameContent: previous.sameContent,
        remoteVerified: false, reason: error.code ?? 'GITHUB_REQUEST_FAILED', message: 'An earlier publication exists but its current remote state could not be verified; preserve and inspect the earlier contribution.' });
    }
  }
  return warnings;
}
