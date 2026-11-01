import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import YAML from '../src/vendor/yaml/dist/index.js';

function repositoryWorkflows(t) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const directory = join(root, '.agents/core/distribution/repository/.github/workflows');
  return directory;
}

test('CI prepares locked toolchains once per platform and restores them before full shards', t => {
  const directory = repositoryWorkflows(t); if (!directory) return;
  const verification = YAML.parse(readFileSync(join(directory, 'verification.yml'), 'utf8'));
  const setup = verification.jobs.platform.steps, full = verification.jobs.full.steps;
  for (const part of ['applications/sdk', 'applications/projects', 'runtime/web']) {
    assert.ok(setup.some(s => s['working-directory'] === '.agents/core/'+part && /npm ci/.test(s.run ?? '')));
  }
  assert.ok(setup.findIndex(s => /npm run build/.test(s.run ?? '')) < setup.findIndex(s => /test --suite quick/.test(s.run ?? '')));
  assert.ok(full.findIndex(s => /tar -xf prepared.tar/.test(s.run ?? '')) < full.findIndex(s => /test --suite full --shard/.test(s.run ?? '')));
  assert.ok(!full.some(s => /npm (?:test|ci)|release build|npm run build/.test(s.run ?? '')));
  for (const step of [...setup,...full]) assert.ok(!step.env?.NODE_OPTIONS);
  const check = YAML.parse(readFileSync(join(directory, 'check.yml'), 'utf8'));
  assert.equal(check.jobs.required.if, "always() && github.repository == 'yinbaiyuan/ksf-core'");assert.deepEqual(check.jobs.required.needs, ['plan','verification']);
  assert.ok(!check.on.pull_request.paths && !check.on.push.paths);
});

test('CI verifies the shipped runtime through a launcher without forging bootstrap proof', t => {
  const directory = repositoryWorkflows(t); if (!directory) return;
  let checks = 0;
  for (const name of readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
    const workflow = YAML.parse(readFileSync(join(directory, name), 'utf8'));
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!/runtime\s+verify\b/.test(step.run ?? '')) continue;
        checks++;
        const command = step.run.replaceAll('\\', '/');
        assert.doesNotMatch(command, /\bnode\s+.*cli\.js\s+runtime\s+verify\b/, `${name}/${jobName}: invoke the launcher for runtime verification`);
        assert.match(command, /\.agents\/ksf(?:\.ps1)?\s+runtime\s+verify\b/, `${name}/${jobName}: invoke a KSF launcher`);
        assert.doesNotMatch(command, /KSF_BOOTSTRAP_VERIFIED/, `${name}/${jobName}: the launcher must create bootstrap proof`);
      }
    }
  }
  assert.ok(checks > 0, 'Repository workflows must verify the shipped runtime.');
});

test('CI Node environment flags can start the bundled runtime before selecting tests', t => {
  const directory = repositoryWorkflows(t); if (!directory) return;
  let checked = 0;
  for (const name of readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
    const workflow = YAML.parse(readFileSync(join(directory, name), 'utf8'));
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const options = step.env?.NODE_OPTIONS ?? job.env?.NODE_OPTIONS;
        if (!options) continue;
        const resolved = options.replaceAll('${{ matrix.shard }}', '1/1');
        assert.doesNotMatch(resolved, /\$\{\{/, `${name}/${jobName}: supply a matrix example for new Node flags`);
        const result = spawnSync(process.execPath, ['--eval', ''], {
          env: {...process.env, NODE_OPTIONS: resolved}, encoding: 'utf8', timeout: 15000,
        });
        assert.equal(result.status, 0, `${name}/${jobName}/${step.name}: ${result.stderr || result.error?.message}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 0, "Test selection must use explicit CLI flags, never NODE_OPTIONS.");
});
