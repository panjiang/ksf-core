import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { platform, removePathSync } from '../platform/index.js';
import { inputFingerprints, fail } from './catalog.js';
import { retainRuntimeArtifacts } from '../distribution/retention.js';

export function testEnvironment(input = process.env) {
  const env = { ...input, KSF_SKIP_AUTO_UPDATE: '1' };
  delete env.NODE_TEST_CONTEXT;
  // Never inherit a parent runner's selection, debugger, coverage or preload.
  // NODE_OPTIONS is executable configuration; callers pass test options here.
  delete env.NODE_OPTIONS; delete env.NODE_V8_COVERAGE; delete env.KSF_TEST_REUSE;
  env.PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [dirname(platform.tool('tar'))] : []), env.PATH ?? env.Path ?? ''].join(process.platform === 'win32' ? ';' : ':');
  if (process.platform === 'win32') { env.Path = env.PATH; }
  return env;
}
function readJSON(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function writeJSON(path, value) { const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); renameSync(temporary, path); }
// An exclusive file is a barrier: drain earlier work, run it alone, then admit
// later files. Do not backfill past the barrier and starve heavy lifecycle work.
export async function scheduleTests(items, parallel, run, cancelled) {
  const active = new Set();
  for (const item of items) {
    if (cancelled()) break;
    if (item.isolation === 'exclusive') {
      await Promise.all(active);
      if (cancelled()) break;
      await run(item);
    } else {
      while (active.size >= parallel) await Promise.race(active);
      if (cancelled()) break;
      const task = run(item).finally(() => active.delete(task));
      active.add(task);
    }
  }
  await Promise.all(active);
}
export async function executeTestPlan(root, plan, { progress = line => process.stderr.write(line + '\n') } = {}) {
  if (plan.missingDependencies.length) fail('TEST_DEPENDENCIES_MISSING', 'Selected tests have missing locked dependencies. No tests were started.', { missingDependencies: plan.missingDependencies });
  const retention = retainRuntimeArtifacts(root, 'tests');
  for (const error of retention.errors) progress(`Test artifact retention: ${error.code}: ${error.message}`);
  const runId = randomUUID(), base = join(root, '.agents/runtime-data/tests'), directory = join(base, runId), cache = join(base, 'cache');
  mkdirSync(directory, { recursive: true }); mkdirSync(cache, { recursive: true });
  const before = inputFingerprints(root, plan.catalog, plan.tests), results = new Array(plan.tests.length), active = new Set();
  // Keep native Windows staging paths within legacy PowerShell/.NET limits.
  // A profile-root scratch directory is shorter than %LOCALAPPDATA%/Temp plus
  // another run/file hierarchy, and is exclusively owned and removed here.
  const temporaryDirectory = mkdtempSync(join(process.platform==='win32'?homedir():tmpdir(), '.ksft-'));
  const startedAt = new Date().toISOString(), start = performance.now(); let cancelled = false;
  const stop = child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Detached descendants have their own POSIX process groups. Snapshot the
    // owned tree before stopping its root; unrelated processes are excluded.
    const descendants=[];
    if(['darwin','linux'].includes(process.platform)){
      const ps=spawnSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8',timeout:5000});
      const rows=(ps.stdout??'').trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
      const collect=parent=>{for(const [pid,ppid]of rows)if(ppid===parent&&pid!==parent){collect(pid);descendants.push(pid);}};collect(child.pid);
    }
    try { platform.terminate(child, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    for(const pid of descendants)try{process.kill(-pid,'SIGKILL');}catch{try{process.kill(pid,'SIGKILL');}catch{}}
  };
  const onSignal = () => { cancelled = true; for (const child of active) stop(child); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  async function runOne(item, index) {
    const key = before[item.id], previous = readJSON(join(cache, `${key}.json`));
    if (plan.options.reuse && item.cacheable && previous?.schemaVersion === 1 && previous.key === key && previous.result?.status === 'passed' && previous.result.path === item.path) {
      progress(`[REUSE] ${item.path}`); return { ...previous.result, status: 'reused', reusedFrom: previous.runId, durationMs: 0 };
    }
    const began = performance.now(), log = join(directory, `${index}.log`), events = [], stderr = [];
    const temporary = join(temporaryDirectory, String(index)); mkdirSync(temporary);
    let child, timer, timedOut = false, pending = '', channelError = false, summary;
    return await new Promise(resolve => {
      const executable = item.kind === 'powershell' ? 'powershell.exe' : process.execPath;
      const args = item.kind === 'powershell' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, item.path)] : ['--test', '--test-concurrency=1', '--test-reporter=' + new URL('./reporter.js', import.meta.url).href, join(root, item.path)];
      child = spawn(executable, args, { cwd: join(root, plan.catalog.components[item.owner].directory), env: {...testEnvironment(), TMPDIR: temporary, TMP: temporary, TEMP: temporary}, detached: platform.detachedChildren, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      active.add(child); progress(`[RUN] ${item.path}`);
      const consume = line => {
        if (!line) return;
        if (item.kind === 'powershell') { events.push(line); return; }
        try { const event = JSON.parse(line); events.push(event); if (event.type === 'test:summary') summary = event.data; } catch { channelError = true; events.push({ type: 'invalid-channel', text: line.slice(0, 4096) }); }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { pending += chunk; let split; while ((split = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, split)); pending = pending.slice(split + 1); } });
      child.stderr.on('data', bytes => stderr.push(bytes));
      timer = setTimeout(() => { timedOut = true; stop(child); }, item.timeoutMs);
      child.once('error', error => { stderr.push(Buffer.from(error.message)); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); active.delete(child); consume(pending);
        let status = cancelled ? 'cancelled' : timedOut ? 'timed-out' : code === 0 && !channelError && (item.kind === 'powershell' || summary?.counts?.tests > 0) ? 'passed' : 'failed';
        const counts = summary?.counts ?? (item.kind === 'powershell' ? { tests: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'passed' ? 0 : 1, skipped: 0 } : null);
        let logError;
        try { writeFileSync(log, events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n' + Buffer.concat(stderr).toString('utf8')); }
        catch(error) { status='failed';logError={code:error.code,message:error.message}; }
        const result = { id: item.id, path: item.path, owner: item.owner, isolation: item.isolation ?? 'shared', timeoutMs: item.timeoutMs, status, exitCode: code, signal, durationMs: Math.round(performance.now() - began), counts, log };
        if(logError)result.logError=logError;
        progress(`[${status.toUpperCase()}] ${item.path} (${result.durationMs} ms)`);
        if (status !== 'passed') {
          for (const event of events.filter(e => e.type === 'test:fail')) progress(JSON.stringify(event.data).slice(0, 6000));
          if (stderr.length) progress(Buffer.concat(stderr).toString('utf8').slice(-6000));
        }
        resolve(result);
      });
    });
  }
  try {
    const schedule = plan.tests.map((item,index)=>({...item,index})).sort((a,b)=>(b.seconds?.[process.platform]??1)-(a.seconds?.[process.platform]??1)||a.path.localeCompare(b.path));
    const parallel = plan.execution.maxParallelFiles;
    await scheduleTests(schedule, parallel, async item => { results[item.index] = await runOne(item, item.index); }, () => cancelled);
  } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); for (const child of active) stop(child); }
  for (let i = 0; i < results.length; i++) if (!results[i]) results[i] = { id: plan.tests[i].id, path: plan.tests[i].path, owner: plan.tests[i].owner, status: 'not-executed', durationMs: 0 };
  const after = inputFingerprints(root, plan.catalog, plan.tests), changed = plan.tests.filter(item => before[item.id] !== after[item.id]).map(item => item.path);
  let cleanupError;
  try { removePathSync(temporaryDirectory, { recursive: true, force: true }); } catch(error) { cleanupError={code:error.code,message:error.message};progress('Owned temporary directory retained: '+temporaryDirectory); }
  const ok = !cancelled && !changed.length && !cleanupError && results.every(result => ['passed', 'reused'].includes(result.status));
  if (ok) for (let i = 0; i < results.length; i++) if (plan.tests[i].cacheable && results[i].status === 'passed') writeJSON(join(cache, `${before[plan.tests[i].id]}.json`), { schemaVersion: 1, key: before[plan.tests[i].id], runId, result: results[i] });
  const result = { schemaVersion: 1, runId, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start), status: ok ? plan.tests.length ? 'passed' : plan.status : cancelled ? 'cancelled' : changed.length ? 'inputs-changed' : 'failed', complete: ok, platform: process.platform, architecture: process.arch, nodeVersion: process.version, catalogDigest: plan.catalog.digest, suite: plan.suite, scope: plan.scope, component: plan.component, shard: plan.options.shard ?? null, selectedFiles: plan.selectedFiles, assignedFiles: plan.tests.map(t => t.path), requiredFullComponents: plan.requiredFullComponents, excludedPlatform: plan.excludedPlatform, inputFingerprints: before, changedInputs: changed, results, summary: { executed: results.filter(r => !['reused', 'not-executed'].includes(r.status)).length, reused: results.filter(r => r.status === 'reused').length, failed: results.filter(r => !['passed', 'reused'].includes(r.status)).length, platformNotApplicable: plan.excludedPlatform.length }, reportPath: join(directory, 'report.json') };
  result.execution=plan.execution;result.gaps=plan.gaps; result.temporaryDirectory = temporaryDirectory; result.cleanupError=cleanupError??null;
  writeJSON(result.reportPath, result);
  const retained = retainRuntimeArtifacts(root, 'tests', { keepRunId: runId });
  for (const error of retained.errors) progress(`Test artifact retention: ${error.code}: ${error.message}`);
  return { ok, result };
}
