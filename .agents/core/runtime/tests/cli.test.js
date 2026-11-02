import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../', import.meta.url));
function ownedFixture(root, files) {
  const base = join(root, '.agents/core/runtime');
  cpSync(join(runtime, 'src'), join(base, 'src'), { recursive: true });
  cpSync(join(runtime, 'package.json'), join(base, 'package.json'));
  mkdirSync(join(base, 'testing'), { recursive: true });
  for (const path of ['tests', 'web/tests']) mkdirSync(join(base, path), { recursive: true });
  const components = {core:{directory:'.agents/core/runtime',testRoots:['.agents/core/runtime/tests']},web:{directory:'.agents/core/runtime/web',testRoots:['.agents/core/runtime/web/tests']}};
  const tests = files.map(([path,code]) => {writeFileSync(join(base,path),code);const owner=path.startsWith('web/')?'web':'core';return {id:path,path:'.agents/core/runtime/'+path,owner,covers:[owner],suite:'quick',platforms:['darwin','win32','linux'],cacheable:false,inputs:[],timeoutMs:10000,requirements:[],seconds:{darwin:1,win32:1}};});
  if (!tests.some(t=>t.owner==='web')) components.web.noTestsReason='Empty synthetic component';
  writeFileSync(join(base,'testing/catalog.json'),JSON.stringify({schemaVersion:1,components,risks:[],tests}));
  return join(base,'src/cli.js');
}

test('CLI documents the JavaScript test command', () => {
  const result = spawnSync(process.execPath, [join(runtime, 'src/cli.js'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ksf test\s+Run quick tests/);
});

test('CLI documents the manifest build command', () => {
  const result = spawnSync(process.execPath, [join(runtime, 'src/cli.js'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ksf build\s+Generate manifest/);
});

test('test command forwards a failing test runner exit code without global Node', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'ksf js test command '));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const entry = ownedFixture(fixture,[['tests/failing.test.js',
    'import { test } from "node:test"; import assert from "node:assert/strict";\n' +
    'test("deliberate runner failure", () => assert.fail("EXPECTED_TEST_FAILURE"));\n']]);
  const result = spawnSync(process.execPath, [entry, 'test'], {
    // The fixture owns its complete tiny suite; outer CI sharding must not select it.
    encoding: 'utf8', env: { ...process.env, PATH: '', NODE_OPTIONS: '' }, timeout: 15_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EXPECTED_TEST_FAILURE/);
});

test('test command rejects unsupported options', () => {
  const result = spawnSync(process.execPath, [join(runtime, 'src/cli.js'), 'test', '--unsupported'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /INVALID_ARGUMENTS/);
});

test('test command includes both owned suites and excludes vendored tests and fixture programs', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'ksf owned test suites '));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const entry=ownedFixture(fixture,[['tests/core.test.js','import {test} from "node:test"; test("OWNED_CORE_SUITE",()=>{});'],['web/tests/view.test.ts','import {test} from "node:test"; const label:string="OWNED_WEB_SUITE"; test(label,()=>{});']]);
  mkdirSync(join(fixture,'native/upstream'),{recursive:true});
  writeFileSync(join(fixture,'native/upstream/foreign.test.js'),'throw Error("VENDORED_TEST_MUST_NOT_RUN");');
  writeFileSync(join(fixture,'.agents/core/runtime/tests/acceptance-fixture.mjs'),'throw Error("FIXTURE_MUST_NOT_RUN");');
  const result = spawnSync(process.execPath, [entry, 'test'], {
    // The fixture owns its complete tiny suite; outer CI sharding must not select it.
    encoding: 'utf8', env: { ...process.env, PATH: '', NODE_OPTIONS: '' }, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /core.test.js/);
  assert.match(result.stderr, /view.test.ts/);
  assert.doesNotMatch(result.stdout + result.stderr, /VENDORED_TEST_MUST_NOT_RUN|FIXTURE_MUST_NOT_RUN/);
});
