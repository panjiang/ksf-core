import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { gitExecutable } from '../platform/index.js';
import { fail, loadCatalog, matchesInput, safePath, slash, missingRequirements } from './catalog.js';

export function parseTestOptions(args) {
  const options = { suite: 'quick' }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--suite', '--component', '--changed', '--base', '--files', '--plan', '--json', '--reuse', '--shard', '--help', '-h'].includes(key) || seen.has(key)) fail('INVALID_ARGUMENTS', `Unknown or repeated test option: ${key}.`, { exitCode: 2 });
    seen.add(key);
    const name = key.slice(2);
    if (['--changed', '--plan', '--json', '--reuse'].includes(key)) options[name] = true;
    else if (['--help', '-h'].includes(key)) options.help = true;
    else if (key === '--files') {
      options.files = [];
      while (args[i + 1] && !args[i + 1].startsWith('--')) options.files.push(args[++i]);
      if (!options.files.length) fail('INVALID_ARGUMENTS', '--files requires one or more registered test files.', { exitCode: 2 });
    } else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS', `${key} requires a value.`, { exitCode: 2 });
      options[name] = args[++i];
    }
  }
  const ci = process.env.CI && !/^(?:false|0)$/i.test(process.env.CI) || process.env.GITHUB_ACTIONS === 'true';
  if (options.help && args.length !== 1 || !['quick', 'full'].includes(options.suite) || options.base && !options.changed || options.files && (options.changed || options.component) || options.reuse && (options.suite !== 'quick' || ci)) fail('INVALID_ARGUMENTS', 'Invalid test option combination. See ksf test --help.', { exitCode: 2 });
  if (options.shard) {
    const m = /^(\d+)\/(\d+)$/.exec(options.shard);
    if (!m || +m[1] < 1 || +m[2] < +m[1] || +m[2] > 64) fail('INVALID_ARGUMENTS', '--shard must be index/total with 1 <= index <= total <= 64.', { exitCode: 2 });
  }
  return options;
}
export function changedPaths(root, base) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  const git = args => {
    const result = spawnSync(gitExecutable, ['--literal-pathspecs', '-C', root, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, env });
    if (result.error || result.status !== 0) fail('TEST_DIFF_UNAVAILABLE', 'Cannot determine changes. Check Git/base or use an explicit component without --changed.');
    return result.stdout;
  };
  if (realpathSync.native(git(['rev-parse', '--show-toplevel']).trim()) !== realpathSync.native(root)) fail('TEST_DIFF_UNAVAILABLE', 'The KSF root must own its Git worktree.');
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const reference = base ? git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim() : head;
  const comparison = base ? git(['merge-base', head, reference]).trim() : head;
  const records = git(['diff', '--name-status', '-z', '--find-renames', comparison, '--']).split('\0').filter(Boolean), paths = [];
  for (let i = 0; i < records.length;) { const status = records[i++]; paths.push(records[i++]); if (/^[RC]/.test(status)) paths.push(records[i++]); }
  paths.push(...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  return { base: comparison, head, paths: [...new Set(paths.filter(Boolean).map(slash))].sort() };
}
export function assignShards(tests, count, platform = process.platform) {
  const bins = Array.from({ length: count }, () => ({ seconds: 0, files: [] }));
  for (const item of [...tests].sort((a, b) => (b.seconds?.[platform] ?? 1) - (a.seconds?.[platform] ?? 1) || a.id.localeCompare(b.id))) {
    const index = bins.reduce((best, bin, n) => bin.seconds < bins[best].seconds ? n : best, 0);
    bins[index].files.push(item); bins[index].seconds += item.seconds?.[platform] ?? 1;
  }
  return bins.map(bin => bin.files.sort((a, b) => a.path.localeCompare(b.path)));
}
export function createTestPlan(root, options, { platform = process.platform, changes } = {}) {
  const catalog = loadCatalog(root);
  if (options.component && !catalog.components[options.component]) fail('INVALID_ARGUMENTS', `Unknown component: ${options.component}.`, { exitCode: 2 });
  const diff = options.changed ? changes ?? changedPaths(root, options.base) : null;
  let tests = catalog.tests, reasons = [], requiredFullComponents = [];
  if (options.component) tests = tests.filter(t => t.owner === options.component || t.covers.includes(options.component));
  if (options.files) {
    const paths = options.files.map(path => safePath(root, path).rel);
    for (const path of paths) if (!tests.some(t => t.path === path)) fail('INVALID_ARGUMENTS', 'File is not a registered test.', { target: path, exitCode: 2 });
    tests = tests.filter(t => paths.includes(t.path));
    if (options.suite === 'quick' && tests.some(t => t.suite === 'full')) fail('INVALID_ARGUMENTS', 'A selected file requires --suite full.', { exitCode: 2 });
  }
  if (diff) {
    const affected = new Set(), matched = new Set();
    for (const path of diff.paths) {
      let known = false;
      for (const item of catalog.tests) if ([item.path, ...item.inputs].some(input => matchesInput(path, input))) { matched.add(item.id); affected.add(item.owner); known = true; }
      for (const rule of catalog.risks) if (rule.paths.some(pattern => matchesInput(path, pattern))) { rule.components.forEach(c => { affected.add(c); requiredFullComponents.push(c); }); known = true; reasons.push({ path, reason: rule.reason }); }
      if (!known) {
        const owners = Object.entries(catalog.components).filter(([, c]) => matchesInput(path, c.directory));
        if (owners.length || path.startsWith('.github/') || path === 'AGENTS.md' || path.startsWith('.agents/ksf')) {
          const fallback = owners.length ? owners.map(([id]) => id) : Object.keys(catalog.components);
          fallback.forEach(c => { affected.add(c); requiredFullComponents.push(c); });
          for (const item of catalog.tests) if (fallback.includes(item.owner) || item.covers.some(c => fallback.includes(c))) matched.add(item.id);
          reasons.push({ path, reason: 'Unmapped owned input: conservatively include its component and require full verification.' });
        }
      }
    }
    tests = tests.filter(t => options.suite === 'full' ? affected.has(t.owner) || t.covers.some(c => affected.has(c)) : matched.has(t.id) || t.covers.some(c => affected.has(c)));
    if (options.component) requiredFullComponents = requiredFullComponents.filter(c => c === options.component);
  }
  if (options.suite === 'quick') tests = tests.filter(t => t.suite === 'quick');
  const excludedPlatform = tests.filter(t => !t.platforms.includes(platform));
  tests = tests.filter(t => t.platforms.includes(platform));
  const selected = tests;
  if (options.shard) { const [index, count] = options.shard.split('/').map(Number); tests = assignShards(tests, count, platform)[index - 1]; }
  const gaps=Object.entries(catalog.components).filter(([id,c])=>c.coverageNotes&&(!options.component||id===options.component)).map(([component,c])=>({component,message:c.coverageNotes}));
  const execution={maxParallelFiles:Math.max(1,Math.min(options.suite==='quick'?4:2,availableParallelism())),exclusiveFiles:tests.filter(t=>t.isolation==='exclusive').map(t=>t.path)};
  return { catalog, options, execution, suite: options.suite, scope: options.files ? 'files' : options.changed ? 'changed' : options.component ? 'component' : 'all', component: options.component ?? null, platform, changes: diff, reasons, gaps, requiredFullComponents: [...new Set(requiredFullComponents)].sort(), selectedFiles: selected.map(t => t.path), tests, excludedPlatform: excludedPlatform.map(t => ({ path: t.path, platforms: t.platforms })), missingDependencies: missingRequirements(root, catalog, tests), status: tests.length ? 'ready' : options.shard && selected.length ? 'empty-shard' : 'not-applicable' };
}
