import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, matchesGlob } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

export const catalogPath = '.agents/core/runtime/testing/catalog.json';
export const fail = (code, message, details = {}) => { throw Object.assign(new Error(message), { code, ...details }); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const slash = value => value.replaceAll('\\', '/');
export function safePath(root, path) {
  const full = resolve(root, path), rel = slash(relative(root, full));
  if (!rel || rel.startsWith('../') || rel === '..' || rel.split('/').includes('.git')) fail('TEST_PATH_INVALID', 'Test paths must stay inside this KSF root.', { target: path });
  let current = root;
  for (const part of rel.split('/')) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('TEST_PATH_INVALID', 'Test inputs cannot traverse symlinks.', { target: path }); }
  return { full, rel };
}
const ignored = new Set(['node_modules', '.build', '.git', '.vite', 'coverage', 'test-results', '.impeccable', '.DS_Store']);
export function walk(root, path) {
  const { full, rel } = safePath(root, path);
  if (!existsSync(full)) return [];
  const stat = lstatSync(full);
  if (stat.isFile()) return [rel];
  if (!stat.isDirectory()) fail('TEST_INPUT_INVALID', 'Unsupported test input.', { target: rel });
  return readdirSync(full).sort().filter(name => !ignored.has(name)).flatMap(name => walk(root, `${rel}/${name}`));
}
export function loadCatalog(root) {
  let catalog;
  try { catalog = JSON.parse(readFileSync(join(root, catalogPath), 'utf8')); }
  catch (error) { fail('TEST_CATALOG_INVALID', `Cannot read the owned test catalog: ${error.message}`); }
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.tests) || !catalog.components || !Array.isArray(catalog.risks)) fail('TEST_CATALOG_INVALID', 'Unsupported test catalog.');
  const ids = new Set(), files = new Set(), discovered = new Set();
  for (const [id, component] of Object.entries(catalog.components)) {
    if (!component.directory || !Array.isArray(component.testRoots)) fail('TEST_CATALOG_INVALID', `Invalid component ${id}.`);
    safePath(root, component.directory);
    for (const directory of component.testRoots) for (const path of walk(root, directory)) if (/\.test\.(?:[cm]?js|ts)$/.test(path) || path.endsWith('.ps1') && !path.includes('/helpers/')) discovered.add(path);
  }
  for (const item of catalog.tests) {
    if (!item.id || ids.has(item.id) || files.has(item.path) || !catalog.components[item.owner] || !['quick', 'full'].includes(item.suite) || !Array.isArray(item.inputs) || !Array.isArray(item.covers) || item.covers.some(id => !catalog.components[id]) || !Array.isArray(item.platforms) || !item.platforms.length || !Number.isInteger(item.timeoutMs) || item.timeoutMs < 1) fail('TEST_CATALOG_INVALID', `Invalid or duplicate test declaration: ${item.id ?? item.path}.`);
    if (item.isolation !== undefined && !['shared', 'exclusive'].includes(item.isolation)) fail('TEST_CATALOG_INVALID', `Unknown test resource policy: ${item.id}.`);
    ids.add(item.id); files.add(item.path);
    const { full } = safePath(root, item.path);
    if (!existsSync(full) || !lstatSync(full).isFile()) fail('TEST_CATALOG_STALE', 'A registered test file is missing.', { target: item.path });
    if (!discovered.has(item.path)) fail('TEST_CATALOG_INVALID', 'A registered file is outside owned test roots.', { target: item.path });
    for (const input of item.inputs) safePath(root, input);
  }
  for (const path of discovered) if (!files.has(path)) fail('TEST_UNREGISTERED', 'A first-party test has no declaration. Register its coverage and profile.', { target: path });
  for (const [id, component] of Object.entries(catalog.components)) if (!catalog.tests.some(t => t.owner === id || t.covers.includes(id)) && !component.noTestsReason) fail('TEST_CATALOG_INVALID', `Component ${id} must declare tests, delegated coverage, or an explicit no-test reason.`);
  return { ...catalog, digest: sha256(JSON.stringify(catalog)) };
}
export function inputFingerprints(root, catalog, tests) {
  const paths = new Map(), roots = new Map();
  const digestInput = input => {
    if (!roots.has(input)) {
      const files = walk(root, input);
      roots.set(input, sha256(JSON.stringify(files.map(path => {
        if (!paths.has(path)) paths.set(path, [lstatSync(join(root, path)).mode & 0o777, sha256(readFileSync(join(root, path)))]);
        return [path, paths.get(path)];
      }))));
    }
    return roots.get(input);
  };
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:CI|TZ|LANG|LC_|NODE_|KSF_|GIT_|PATH$|Path$|SystemRoot$)/i.test(key) && !/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(key)).sort(([a], [b]) => a.localeCompare(b)));
  const runtime = [process.version, process.platform, process.arch, sha256(readFileSync(process.execPath)), environment, sha256(readFileSync(join(root, catalogPath)))];
  // Locks alone do not prove the installed toolchain. Include its actual bytes,
  // including native packages and local SDK links. Memoize shared directories.
  const dependencyTrees = new Map();
  function dependencies(directory, ancestors = new Set()) {
    if (!existsSync(directory)) return 'missing';
    const actual = realpathSync.native(directory);
    if (ancestors.has(actual)) return 'cycle';
    if (!dependencyTrees.has(actual)) {
      const next = new Set([...ancestors, actual]), records = [];
      for (const name of readdirSync(actual).sort()) {
        if (['.cache', '.vite', '.bin'].includes(name)) continue;
        const path = join(actual, name), stat = statSync(path);
        records.push([name, stat.isDirectory() ? dependencies(path, next) : sha256(readFileSync(path))]);
      }
      dependencyTrees.set(actual, sha256(JSON.stringify(records)));
    }
    return dependencyTrees.get(actual);
  }
  const toolchains = [...new Set(Object.values(catalog.components).map(c => c.directory).filter(path => existsSync(join(root, path, 'package.json'))))].sort().map(path => [path, ['package.json','package-lock.json'].map(name=>existsSync(join(root,path,name))?sha256(readFileSync(join(root,path,name))):'missing'), dependencies(join(root, path, 'node_modules'))]);
  return Object.fromEntries(tests.map(item => [item.id, sha256(JSON.stringify([catalog.digest, runtime, toolchains, [...new Set([item.path, ...item.inputs])].sort().map(input => [input, digestInput(input)])]))]));
}
export function missingRequirements(root, catalog, tests) {
  const missing = [];
  for (const item of tests) {
    for (const requirement of item.requirements ?? []) {
      const name = typeof requirement === 'string' ? requirement : requirement.name;
      const directory = join(root, catalog.components[requirement.component ?? item.owner].directory);
      const require = createRequire(join(directory, 'package.json'));
      try { require.resolve(name); } catch { missing.push({ component: item.owner, dependency: name, directory: slash(relative(root, directory)), action: 'Install this component’s locked dependencies before testing.' }); }
    }
  }
  return [...new Map(missing.map(m => [JSON.stringify(m), m])).values()];
}
export const matchesInput = (path, pattern) => path === pattern || path.startsWith(pattern + '/') || matchesGlob(path, pattern);
