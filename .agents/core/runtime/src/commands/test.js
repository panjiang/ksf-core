import { parseTestOptions, createTestPlan } from '../testing/planner.js';
import { executeTestPlan } from '../testing/runner.js';

export const testHelp = `Usage: ksf test [options]
Run owned deterministic tests with the bundled Node. Default: quick, all first-party components.

  --suite quick|full       Quick units/light integration, or complete selected components
  --component <name>       core, web, sdk, or app:<application-id>
  --changed               Include staged, working, untracked, deleted and renamed inputs
  --base <Git-ref>         With --changed: compare from the common ancestor
  --files <paths...>       Exact registered tests; exclusive with --component/--changed
  --plan                   Inspect selection/dependencies without loading tests
  --json                   One JSON result on stdout; diagnostics on stderr
  --reuse                  Explicit local quick success reuse; never full or CI
  --shard <index/total>     Deterministic, duration-balanced file partition
  --help, -h               Show this help

Paths are relative to this KSF root, not the caller's current directory.
No dependency installation, managed builds, live AI, deployment or daily-service restart.
Exit: 0 passed/not-applicable; 1 failed/incomplete; 2 invalid arguments.
`;
export async function runTestCommand(args, root) {
  const json = args.includes('--json');
  const emit = (ok, data, errors = []) => JSON.stringify({ ok, command: 'test', operation: null, data, errors }) + '\n';
  try {
    const options = parseTestOptions(args);
    if (options.help) return { exitCode: 0, stdout: testHelp };
    const plan = createTestPlan(root, options);
    const publicPlan = { suite: plan.suite, scope: plan.scope, component: plan.component, platform: plan.platform, status: plan.status, execution:plan.execution, changes: plan.changes, reasons: plan.reasons, gaps: plan.gaps, requiredFullComponents: plan.requiredFullComponents, selectedFiles: plan.selectedFiles, assignedFiles: plan.tests.map(t => t.path), excludedPlatform: plan.excludedPlatform, missingDependencies: plan.missingDependencies, catalogDigest: plan.catalog.digest };
    if (options.plan) return { exitCode: 0, stdout: json ? emit(true, { phase: 'plan', ...publicPlan }) : JSON.stringify(publicPlan, null, 2) + '\n' };
    const { ok, result } = await executeTestPlan(root, plan);
    const errors = ok ? [] : [{ code: result.changedInputs.length ? 'TEST_INPUT_CHANGED' : 'TEST_FAILED', message: 'Selected test coverage is incomplete. Inspect the per-file report.' }];
    return { exitCode: ok ? 0 : 1, stdout: json ? emit(ok, { phase: 'run', ...result }, errors) : `Test ${result.status}: ${result.summary.executed} executed, ${result.summary.reused} reused, ${result.summary.failed} failed; ${result.durationMs} ms\nReport: ${result.reportPath}\n` };
  } catch (error) {
    const details = { code: error.code ?? 'TEST_EXECUTION_FAILED', message: error.message, ...(error.target ? { target: error.target } : {}) };
    return { exitCode: error.exitCode ?? 1, stdout: json ? emit(false, error.missingDependencies ? { missingDependencies: error.missingDependencies } : null, [details]) : `${details.code}: ${details.message}${details.target ? ' (' + details.target + ')' : ''}\n` };
  }
}
