import { parseOptions, optionSpecs, hasJsonFlag } from '../shared/options.js';
import { resolve } from 'node:path';
import { DistributionError, invalid } from '../distribution/errors.js';
import { readCommitText } from '../services/commit-message.js';
import { readPRText } from '../services/pr-description.js';

const specs = {
  release: {
    build: { options: ['output', 'platform', 'allow-dirty', 'dry-run'], usage: 'build [--output <directory>] [--platform <platform>] [--allow-dirty] [--dry-run]' },
    publish: { target: true, options: ['dry-run'], usage: 'publish <release-directory> [--dry-run]' },
  },
  instance: {
    init: { options: ['revision', 'dry-run'], usage: 'init [--revision <Core commit>] [--dry-run]' },
  },
  system: {
    read: { options: [], usage: 'read' },
    check: { options: ['source'], usage: 'check [--source <Release URL or index file>]' },
    update: { options: ['source', 'from', 'dry-run'], usage: 'update [--source <URL or index file> | --from <Core archive>] [--dry-run]' },
    sync: { options: ['quiet'], usage: 'sync [--quiet]' },
    rollback: { options: ['dry-run'], usage: 'rollback [--dry-run]' },
    cleanup: { options: ['apply', 'dry-run'], usage: 'cleanup [--apply | --dry-run]' },
  },
  contribute: {
    prepare: { options: ['paths', 'all', 'title', 'body', 'body-file', 'pr-body', 'pr-body-file', 'dry-run'], usage: 'prepare (--paths <system-file...> | --all) --title <type(scope): summary> (--body <commit-body> | --body-file <file>) (--pr-body <PR-body> | --pr-body-file <file>) [--dry-run]' },
    read: { target: true, options: [], usage: 'read <contribution-id>' },
    submit: { target: true, options: ['reviewed', 'dry-run'], usage: 'submit <contribution-id> --reviewed <preview-digest> [--dry-run]' },
  },
};
const booleans = new Set(['json', 'help', 'allow-dirty', 'dry-run', 'all', 'quiet', 'apply']);
export function distributionHelp(command, operation) {
  const selected = operation ? [specs[command][operation]] : Object.values(specs[command]);
  const notes = {
    release: 'Build and publish one ksf-core product and its release index.\nA local ksf/ directory is an initialized instance for inspection; it is not a second release artifact.\nOfficial publishing rejects dirty/development packages and requires GitHub authorization.\n',
    instance: 'Initialize a private instance created from the Core template.\nVerify its original tree against exact Core commits, seed missing user files, record the immutable baseline, and use main for personal work.\nNever replaces existing personal content or changes the Git remote.\n',
    system: 'Read, check, update and roll back copied or template-created workspaces.\nVersion checks and installation require an explicit command; startup never invokes sync.\nUpdates use explicit release baselines and never merge personal Git history.\n--source accepts HTTPS, absolute/local index files and loopback HTTP.\n--from selects a verified Core archive; original baselines are resolved online.\nUser directories and .gitignore are never update targets.\nConflicts preserve the current system. Use .agents/ksf for recovery.\n',
    contribute: 'Select committed HEAD system changes against its original Core baseline.\nGit, a local HEAD and network access to the recorded Core are required; index and working changes are ignored.\nPersonal files, history and local commit IDs are never published.\n--paths takes root-relative literal system paths, not globs.\nPrepare requires a reviewed conventional title and 原因／变更／验证 body (--body or --body-file).\nA separate PR description is required (--pr-body or --pr-body-file), with four Markdown sections.\nSchema-5 plans freeze the full commit message, PR body, provenance and upstream core-main target.\nSchema-1/2/3/4 plans remain readable and can only reconcile existing publication records.\nRetries never overwrite remote PR descriptions.\nPrepare warns about prior PRs for the same local commit or system content.\nIdentical content reuses its verified PR; unknown prior attempts must be reconciled.\nSubmission creates a draft Core PR; it requires GitHub authorization.\n',
  };
  return `KSF ${command}${operation ? ` ${operation}` : ''}\n\nUsage:\n` + selected.map(s => `  ksf ${command} ${s.usage} [--json]`).join('\n') + '\n\n' + notes[command] +
    'Paths are relative to the KSF root; -- ends option parsing.\n--dry-run previews without publishing or changing live system files.\nUse --help or -h alone at command or operation level.\n';
}
export function parseDistributionArgs(command, args) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) return { help: true };
  const [operation, ...rest] = args, spec = specs[command]?.[operation];
  if (!spec) invalid(`Unsupported ${command} operation.`);
  const parsed = { operation };
  const overrides = Object.fromEntries([...booleans].map(name => [name, { kind: 'flag' }]));
  overrides.paths = { kind: 'many', missing: '--paths requires one or more literal system paths.',
    validate(values) { if (values.some(p => !p)) invalid('--paths requires one or more literal system paths.'); } };
  const seen = parseOptions(rest, { result: parsed, invalid,
    options: optionSpecs(['json', 'help', ...spec.options], overrides),
    target(token) {
      if (parsed.target !== undefined) invalid('Only one target is allowed.');
      parsed.target = token;
    },
  });
  if (parsed.help) {
    if (seen.size !== 1 || parsed.target !== undefined) invalid('Use --help without other arguments.');
    return parsed;
  }
  if (spec.target !== (parsed.target !== undefined) && (spec.target || parsed.target !== undefined)) invalid(spec.target ? 'A target is required.' : 'This operation does not accept a target.');
  if (parsed.source !== undefined && parsed.from !== undefined) invalid('--source and --from are mutually exclusive.');
  if (parsed.apply && parsed.dryRun) invalid('--apply and --dry-run are mutually exclusive.');
  if (parsed.quiet && parsed.json) invalid('--quiet and --json are mutually exclusive.');
  if (command === 'contribute' && operation === 'prepare' && (!!parsed.paths === !!parsed.all)) invalid('Choose exactly one of --paths or --all.');
  if (command === 'contribute' && operation === 'prepare') {
    if (!parsed.title) invalid('--title requires a conventional commit title.');
    if ((parsed.body !== undefined) === (parsed.bodyFile !== undefined)) invalid('Choose exactly one of --body or --body-file.');
    if ((parsed.prBody !== undefined) === (parsed.prBodyFile !== undefined)) invalid('Choose exactly one of --pr-body or --pr-body-file.');
  }
  if (command === 'contribute' && operation === 'submit' && !parsed.reviewed) invalid('--reviewed requires the digest of a prepared contribution.');
  return parsed;
}
function publicData(data) {
  return data?.changes ? { ...data, changes: data.changes.map(({ content, ...change }) => change) } : data;
}
export async function runDistributionCommand(command, args, root) {
  const response = { ok: false, command, operation: Object.hasOwn(specs[command], args[0]) ? args[0] : null, data: null, errors: [] };
  let exitCode = 0, quiet = false;
  try {
    const parsed = parseDistributionArgs(command, args); quiet = parsed.quiet === true;
    if (parsed.help) return { stdout: distributionHelp(command, parsed.operation), stderr: '', exitCode: 0 };
    let data;
    if (command === 'system' && parsed.operation === 'cleanup') {
      const { cleanupRuntimeArtifacts } = await import('../distribution/retention.js');
      data = cleanupRuntimeArtifacts({ root, apply: parsed.apply === true });
      if (data.errors.length) throw new DistributionError('CLEANUP_INCOMPLETE', 'Some artifacts were retained after cleanup errors.', data);
    } else if (command === 'system') {
      const system = await import('../distribution/system.js');
      const methods = { read: system.systemRead, check: system.systemCheck, update: system.systemUpdate, rollback: system.systemRollback, sync: system.systemSync };
      data = await methods[parsed.operation]({ root, ...parsed });
    } else if (command === 'contribute') {
      const contribution = await import('../distribution/contribute.js');
      const methods = { prepare: contribution.prepareContribution, read: contribution.readContribution, submit: contribution.submitContribution };
      if (parsed.bodyFile !== undefined) parsed.body = readCommitText(root, parsed.bodyFile);
      if (parsed.prBodyFile !== undefined) parsed.prBody = readPRText(root, parsed.prBodyFile);
      data = await methods[parsed.operation]({ root, ...parsed, id: parsed.target });
    } else if (command === 'instance') {
      const { initializeInstance } = await import('../distribution/instance.js');
      data = await initializeInstance({ root, ...parsed });
    } else if (parsed.operation === 'build') {
      const { buildRelease } = await import('../distribution/release.js');
      data = await buildRelease({ root, ...parsed });
    } else {
      const { publishRelease } = await import('../distribution/publish.js');
      data = await publishRelease({ root, directory: resolve(root, parsed.target), dryRun: parsed.dryRun });
    }
    response.ok = true; response.data = publicData(data);
  } catch (error) {
    response.errors = [{ code: error.code ?? 'DISTRIBUTION_FAILED', message: error.message }];
    if (error.data) response.data = publicData(error.data);
    exitCode = error instanceof DistributionError ? error.exitCode : 1;
  }
  if (quiet) return { stdout: '', stderr: response.ok ? response.data?.changed ? `KSF: updated Core to ${response.data.to ?? response.data.latest}.\n` : '' :
    `KSF: explicit sync failed (${response.errors[0].code}); inspect the installed system state.\n`, exitCode };
  const json = hasJsonFlag(args);
  return { stdout: json ? JSON.stringify(response) + '\n' :
    [response.data ? JSON.stringify(response.data, null, 2) : '', ...response.errors.map(e => `${e.code}: ${e.message}`)].filter(Boolean).join('\n') + '\n', stderr: '', exitCode };
}
