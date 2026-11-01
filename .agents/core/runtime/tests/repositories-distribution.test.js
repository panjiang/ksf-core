import {fixtureTarget} from './helpers/distribution-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { distributionFixture, instanceEntries } from './helpers/distribution-fixture.js';
import { buildRelease, inspectCoreArchive } from '../src/distribution/release.js';
import { readArchive } from '../src/distribution/archive.js';
import { systemUpdate, systemRollback } from '../src/distribution/system.js';
import { repository } from '../src/services/repositories.js';
import { project } from '../src/services/projects.js';

test('Core package and local instance seed never collect private repositories or their Git data', async t => {
  const f = await distributionFixture(t), sentinel = 'PRIVATE_REPOSITORY_' + randomUUID();
  const folder = join(f.root, 'repositories/private/.git'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'config'), sentinel);
  writeFileSync(join(f.root, 'repositories/private/source.txt'), sentinel);
  const built = await buildRelease({ root: f.root, output: join(f.directory, 'repository-isolation') });
  const platform = built.index.platforms[fixtureTarget];
  const core = inspectCoreArchive(readFileSync(join(built.output, platform.core.name))).entries;
  const workspace = instanceEntries(built.instance);
  for (const entries of [core, workspace]) {
    assert.ok([...entries.keys()].every(path => !path.startsWith('repositories/')));
    assert.ok([...entries.values()].every(entry => !entry.bytes.includes(Buffer.from(sentinel))));
  }
  assert.match(workspace.get('.gitignore').bytes.toString(), /^\/repositories\/$/m);
  assert.equal(existsSync(join(built.template, 'repositories')), false);
});

test('upgrade and rollback preserve actual repositories, project links and personal ignore rules', async t => {
  const f = await distributionFixture(t), root = f.workspace;
  repository({ root, operation: 'create', target: 'fictional-engineering' });
  project({ root, operation: 'write', name: 'Fictional project', data: { body: '# Fictional project' } });
  repository({ root, operation: 'link', target: 'repositories/fictional-engineering', projectName: 'Fictional project' });
  const files = ['.gitignore', '项目/Fictional project/project.md', 'repositories/fictional-engineering/.git/config', 'repositories/fictional-engineering/.git/HEAD'];
  writeFileSync(join(root, 'repositories/fictional-engineering/source.txt'), 'Private engineering artifact');
  files.push('repositories/fictional-engineering/source.txt');
  const before = files.map(path => readFileSync(join(root, path)));
  const next = await f.next();
  await systemUpdate({ root, from: next.coreArchive });
  for (const [index, path] of files.entries()) assert.deepEqual(readFileSync(join(root, path)), before[index]);
  await systemRollback({ root });
  for (const [index, path] of files.entries()) assert.deepEqual(readFileSync(join(root, path)), before[index]);
  assert.equal(repository({ root, operation: 'check', projectName: 'Fictional project' }).data.valid, true);
});
