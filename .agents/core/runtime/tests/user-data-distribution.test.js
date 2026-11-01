import {fixtureTarget} from './helpers/distribution-fixture.js';
import {gitBinary} from './helpers/platform.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { distributionFixture, repository, instanceEntries } from './helpers/distribution-fixture.js';
import { readUserData, writeUserData } from '../src/services/user-data.js';
import { systemRead, systemUpdate, systemRollback } from '../src/distribution/system.js';
import { buildRelease } from '../src/distribution/release.js';
import { readArchive } from '../src/distribution/archive.js';

test('Core upgrade and rollback preserve portable settings and identity while system operations consume settings overrides', async t => {
  const f = await distributionFixture(t);
  writeUserData({ root: f.workspace, namespace: 'settings', values: { updates: { request_timeout_seconds: 20, check_interval_seconds: 600 } }, ifMatch: 'missing' });
  writeUserData({ root: f.workspace, namespace: 'identity', values: { name: 'Example Author', email: 'author@example.invalid', namespace: 'example-author' }, ifMatch: 'missing' });
  const path = join(f.workspace, '.agents/user-data/settings.json'), before = readFileSync(path);
  const identityPath = join(f.workspace, '.agents/user-data/identity.json'), identityBefore = readFileSync(identityPath);
  const status = await systemRead({ root: f.workspace });
  assert.equal(status.checkIntervalSeconds, 600); assert.equal(status.requestTimeoutSeconds, 20);
  const next = await f.next();
  await systemUpdate({ root: f.workspace, from: next.coreArchive });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readFileSync(identityPath), identityBefore);
  await systemRollback({ root: f.workspace });
  assert.deepEqual(readFileSync(path), before); assert.equal(readUserData({ root: f.workspace, namespace: 'settings' }).revision, 1);
  assert.deepEqual(readFileSync(identityPath), identityBefore);
});
test('release reads only Core defaults and generates an empty user-data directory without publishing source user settings', async t => {
  const f = await distributionFixture(t), canary = `PRIVATE_USER_SETTINGS_${randomUUID()}`;
  const path = join(f.root, '.agents/user-data/settings.json'); mkdirSync(dirname(path), { recursive: true });
  // Deliberately invalid: a build must not even parse this private configuration.
  writeFileSync(path, canary);
  const identityPath = join(f.root, '.agents/user-data/identity.json'); writeFileSync(identityPath, canary);
  const built = await buildRelease({ root: f.root, output: join(f.directory, 'empty-user-data-template') });
  const core = readArchive(readFileSync(join(built.output, `ksf-core-0.1.0-${fixtureTarget}.tar.gz`)));
  const workspace = instanceEntries(built.instance);
  assert.equal(workspace.get('.agents/user-data/.gitkeep').bytes.length, 0);
  assert.equal(core.has('.agents/user-data/.gitkeep'), false);
  assert.equal(workspace.has('.agents/user-data/settings.json'), false);
  assert.equal(workspace.has('.agents/user-data/identity.json'), false);
  assert.ok([...workspace.values()].every(file => !file.bytes.includes(Buffer.from(canary))));
  assert.equal(readFileSync(path, 'utf8'), canary);
  assert.equal(readFileSync(identityPath, 'utf8'), canary);
});
test('Core ignores system-user data; the user template tracks it and ignores only its temporary writes and local runtime data', async t => {
  const f = await distributionFixture(t);
  for (const [name, ignore] of [['core-policy', '.gitignore'], ['instance-policy', '.agents/core/distribution/template/.gitignore']]) {
    const root = join(f.directory, name); mkdirSync(root);
    // Installed instances intentionally have the user policy at their root.
    // In that mode use the isolated Core fixture for the Core-side assertion;
    // a Core checkout still tests its actual root policy.
    const source = name === 'core-policy' && existsSync(join(repository, '.agents/core/release.json')) ? f.root : repository;
    writeFileSync(join(root, '.gitignore'), readFileSync(join(source, ignore)));
    assert.equal(spawnSync(gitBinary, ['init', '--template=', root]).status, 0);
    const check = path => spawnSync(gitBinary, ['-C', root, 'check-ignore', '-q', path]).status;
    assert.equal(check('.agents/user-data/settings.json'), name === 'core-policy' ? 0 : 1);
    assert.equal(check('.agents/user-data/identity.json'), name === 'core-policy' ? 0 : 1);
    assert.equal(check('.agents/runtime-data/user-data/settings.lock'), 0);
    if (name === 'instance-policy') assert.equal(check('.agents/user-data/settings.json.abc.tmp'), 0);
  }
});
