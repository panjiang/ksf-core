import { fileURLToPath } from 'node:url';
import { hello } from './services/hello.js';
import { types } from './objects/schema.js';
const args = process.argv.slice(2);
const [command, ...options] = args;
const currentRoot = fileURLToPath(new URL('../../../../', import.meta.url));
if (!(command === 'cooperation' && options[0] === 'migrate')) {
  const { assertNoCooperationMigration } = await import('./migrations/guard.js');
  try { assertNoCooperationMigration(currentRoot); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, command, errors: [{ code: error.code, message: error.message }] }) + '\n'); process.exit(1); }
}
const runtimeInfo = () => ({
  nodeVersion: process.version,
  nodePath: process.execPath,
  ksfRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
});

if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(command))) {
  const objectCommands = Object.keys(types).map(type =>
    `  ${`ksf ${type} --help`.padEnd(27)}Manage ${type} objects\n`).join('');
  process.stdout.write('KSF CLI\n\nUsage:\n  ksf hello                   Print a greeting\n  ksf hello --json            Return a greeting and runtime details as JSON\n  ksf runtime verify          Fully verify the bundled and installed runtime\n  ksf runtime verify --json   Return verification details as JSON\n  ksf build                   Generate manifest from build inputs and artifacts\n  ksf build --json            Return generated manifest details as JSON\n  ksf test                    Run quick tests; --suite full for complete verification\n  ksf context --help          Get capability context for the Agent\n  ksf project --help          Manage project root cards and directories\n  ksf metadata --help         Manage Markdown YAML frontmatter\n' + objectCommands + '  ksf --help                  Show this help\n');
  process.stdout.write('  ksf repository --help       Manage independent local project repositories\n');
  process.stdout.write('  ksf commit-message --help   Check commit messages or print the template\n');
  process.stdout.write('  ksf pr-description --help   Check PR descriptions or print the template\n');
  process.stdout.write('  ksf source --help           Associate and share Git ability sources\n');
  process.stdout.write('  ksf config --help           Manage the unified configuration center\n  ksf incubate --help         Configure and finish first-use incubation\n');
  process.stdout.write('  ksf user-data --help        Manage portable KSF system-user settings\n');
  process.stdout.write('  ksf eval --help             Explicit natural-language Agent evaluations\n');
  process.stdout.write('  ksf service --help          Manage the independent background service\n  ksf open                    Start the service and open the workbench\n');
  process.stdout.write('  ksf web --help              Start the local Web server\n');
  process.stdout.write('  ksf app --help              Call packaged application CLI capabilities\n  ksf communication --help    Use local/LAN communication\n');
  process.stdout.write('  ksf assistant --help       Read desktop workbench projections\n');
  process.stdout.write('  ksf route --help            Record and query local session routing\n');
  process.stdout.write('  ksf task --help             Archive Codex task turns and routing\n');
  process.stdout.write('  ksf chat --help             Manage current chat turns and dynamic variables\n');
  process.stdout.write('  ksf launcher recover       Recover an interrupted update without Core or Node\n  ksf release --help          Build and publish the single Core release\n  ksf instance --help         Initialize an instance from the Core template\n  ksf system --help           Check, upgrade and roll back installed Core\n  ksf contribute --help       Review system changes and submit a Core PR\n');
} else if (['release', 'system', 'contribute', 'instance'].includes(command)) {
  const { runDistributionCommand } = await import('./commands/distribution.js');
  const result = await runDistributionCommand(command, options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} else if(command==='incubate'){
  const {runIncubationCommand}=await import('./commands/incubation.js');const result=await runIncubationCommand(options,currentRoot);process.stdout.write(result.stdout);process.exitCode=result.exitCode;
} else if(command==='config'){
  const {runConfigurationCommand}=await import('./commands/configuration.js');const result=await runConfigurationCommand(options,currentRoot);process.stdout.write(result.stdout);process.exitCode=result.exitCode;
} else if (command === 'service'||command==='open') {
  const {runServiceCommand}=await import('./commands/service.js');const result=await runServiceCommand(options,currentRoot,{open:command==='open'});process.stdout.write(result.stdout);process.exitCode=result.exitCode;
} else if (command === 'web') {
  const { runWebCommand } = await import('./commands/web.js');
  process.exitCode = await runWebCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
} else if(command==='app'){
  const {runApplicationCommand}=await import('./commands/application-cli.js');const result=await runApplicationCommand(options,currentRoot);process.stdout.write(result.stdout);process.exitCode=result.exitCode;
} else if(command==='communication'){
  const {runCommunicationCommand}=await import('./commands/communication.js');const result=await runCommunicationCommand(options,currentRoot);process.stdout.write(result.stdout);process.exitCode=result.exitCode;
} else if (command === 'assistant') {
  const { runAssistantCommand } = await import('./commands/assistant.js');
  const result = await runAssistantCommand(options, runtimeInfo().ksfRoot);
  process.stdout.write(result.stdout); process.exitCode = result.exitCode;
} else if (command === 'chat') {
  const { runChatCommand } = await import('./commands/chat.js');
  const result = await runChatCommand(options, runtimeInfo().ksfRoot);
  process.stdout.write(result.stdout); process.exitCode = result.exitCode;
} else if (command === 'task') {
  const { runTaskCommand } = await import('./commands/tasks.js');
  const result = await runTaskCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'route') {
  const { runRouteCommand } = await import('./commands/routes.js');
  const result = await runRouteCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'eval') {
  const { runEvalCommand } = await import('./commands/eval.js');
  const result = await runEvalCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'commit-message') {
  const { runCommitMessageCommand } = await import('./commands/commit-message.js');
  const result = runCommitMessageCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'pr-description') {
  const { runPRDescriptionCommand } = await import('./commands/pr-description.js');
  const result = runPRDescriptionCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'source') {
  const { runSourceCommand } = await import('./commands/sources.js');
  const result = runSourceCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'user-data') {
  const { runUserDataCommand } = await import('./commands/user-data.js');
  const result = runUserDataCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'repository') {
  const { runRepositoryCommand } = await import('./commands/repositories.js');
  const result = runRepositoryCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'project') {
  const { runProjectCommand } = await import('./commands/projects.js');
  const result = runProjectCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'context') {
  const { runContextCommand } = await import('./commands/context.js');
  const result = runContextCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'cooperation') {
  const { runCooperationCommand } = await import('./commands/cooperation.js');
  const result = runCooperationCommand(options, currentRoot);
  process.stdout.write(result.stdout); process.exitCode = result.exitCode;
} else if (command === 'workflow') {
  process.stdout.write(JSON.stringify({ ok: false, command, data: null, errors: [{ code: 'COMMAND_RENAMED', message: 'Use ksf cooperation. For existing data run ksf cooperation migrate --dry-run, then --apply.' }] }) + '\n');
  process.exitCode = 2;
} else if (Object.hasOwn(types, command)) {
  const { runObjectCommand } = await import('./commands/objects.js');
  const result = runObjectCommand(command, options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'metadata') {
  const { runMetadataCommand } = await import('./commands/metadata.js');
  const result = runMetadataCommand(options, fileURLToPath(new URL('../../../../', import.meta.url)));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} else if (command === 'build' && (options.length === 0 || (options.length === 1 && options[0] === '--json'))) {
  try {
    const { buildManifest } = await import('./services/build-manifest.js');
    if ((await import('node:fs')).existsSync(new URL('../../docs/navigation.json', import.meta.url))) {
      const {runDocumentation} = await import('../tools/documentation.mjs');
      const docs = await runDocumentation(currentRoot, {check:true});
      if (!docs.ok) throw Object.assign(new Error('System documentation requires regeneration or correction: '+JSON.stringify(docs.errors)), {code:'DOCUMENTATION_INVALID'});
    }
    const result = await buildManifest(fileURLToPath(new URL('../../../../', import.meta.url)));
    process.stdout.write(options.includes('--json') ? `${JSON.stringify(result)}\n` : `KSF manifest generated: ${result.manifestPath}\n`);
  } catch (failure) {
    const error = { ok: false, error: { code: failure.code ?? 'BUILD_FAILED', message: failure.message } };
    process.stderr.write(options.includes('--json') ? `${JSON.stringify(error)}\n` : `${error.error.code}: ${error.error.message}\n`);
    process.exitCode = 1;
  }
} else if (command === 'test') {
  const { runTestCommand } = await import('./commands/test.js');
  const result = await runTestCommand(options, currentRoot);
  process.stdout.write(result.stdout); process.exitCode = result.exitCode;
} else if (command === 'hello' && options.length <= 1 && options.every(option => option === '--json')) {
  const result = {
    ok: true,
    command: 'hello',
    message: hello(),
    runtime: runtimeInfo(),
  };
  process.stdout.write(options.includes('--json') ? `${JSON.stringify(result)}\n` : `${result.message}\n`);
} else if (command === 'runtime' && options[0] === 'verify' &&
           (options.length === 1 || (options.length === 2 && options[1] === '--json'))) {
  if (process.env.KSF_BOOTSTRAP_VERIFIED !== '1') {
    const error = { ok: false, error: { code: 'BOOTSTRAP_REQUIRED', message: 'Run runtime verification through the ksf launcher.' } };
    process.stderr.write(options.includes('--json') ? `${JSON.stringify(error)}\n` : `${error.error.message}\n`);
    process.exitCode = 1;
  } else {
    const result = { ok: true, command: 'runtime verify', runtime: runtimeInfo() };
    process.stdout.write(options.includes('--json') ? `${JSON.stringify(result)}\n` : 'KSF runtime verified.\n');
  }
} else {
  const error = { ok: false, error: { code: 'INVALID_ARGUMENTS', message: "Unsupported command or option. Run 'ksf --help'." } };
  process.stderr.write(options.includes('--json') ? `${JSON.stringify(error)}\n` : `${error.error.message}\n`);
  process.exitCode = 2;
}
