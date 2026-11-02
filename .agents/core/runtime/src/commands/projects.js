import { parseOptions, optionSpecs, hasJsonFlag } from '../shared/options.js';
import { parseInput } from '../metadata/input.js';
import { MetadataError, invalid } from '../metadata/errors.js';
import { readInputFile } from '../services/metadata.js';
import { project, errorItem } from '../services/projects.js';
import { runProjectManagementCommand } from './project-management.js';

const supported = {
  list: ['scope', 'json', 'help'], read: ['scope', 'part', 'json', 'help'],
  write: ['scope', 'data', 'from', 'dry-run', 'json', 'help'],
  remove: ['scope', 'dry-run', 'json', 'help'], check: ['scope', 'json', 'help'],
  archive: ['reason', 'dry-run', 'json', 'help'], restore: ['status', 'dry-run', 'json', 'help'], recover: ['dry-run', 'json', 'help'],
};
const usages = {
  list: 'list [--scope current|archived|all] [--json]',
  read: 'read <name> [--scope current|archived] [--part metadata|body|all] [--json]',
  write: 'write <name> [--scope current|archived] (--data <JSON> | --from <file>) [--dry-run] [--json]',
  remove: 'remove <name> [--scope current|archived] [--dry-run] [--json]',
  check: 'check [name] [--scope current|archived|all] [--json]',
  archive: 'archive <name> --reason <text> [--dry-run] [--json]',
  restore: 'restore <name> [--status <text>] [--dry-run] [--json]',
  recover: 'recover <operation-id> [--dry-run] [--json]',
};

export function projectHelp(operation) {
  return `KSF project${operation ? ` ${operation}` : ''}\n\nUsage:\n` +
    (operation ? [usages[operation]] : [...Object.values(usages), 'management read|check|write <name> [--help]']).map(usage => `  ksf project ${usage}`).join('\n') + '\n\n' +
    'Targets are directory names under 项目/ (current) or 档案/项目/ (archived). Default scope: current.\n' +
    'read defaults to all; list returns root-card summaries without bodies.\n' +
    'write accepts {"metadata": {...}, "body": "..."}; creation requires body.\n' +
    'Metadata merges top-level fields; a supplied body replaces the full body.\n' +
    'remove deletes the ENTIRE project directory, including all resources.\n' +
    'Optional metadata.routing sets preferred abilities and knowledge entries.\n' +
    'check validates root cards and configured routing references; it does not select abilities or verify business facts.\n' +
    '--from paths are relative to the KSF root; absolute input paths are accepted.\n' +
    '--dry-run previews without writes. Use -- before a name starting with a hyphen.\n' +
    'Use --help or -h alone at command or operation level.\n';
}

export function parseProjectArgs(args) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) return { help: true };
  const [operation, ...rest] = args;
  if (!Object.hasOwn(supported, operation)) invalid('Expected project list, read, write, remove, check, archive, restore or recover.');
  const parsed = { operation };
  const seen = parseOptions(rest, { result: parsed, invalid,
    options: optionSpecs(supported[operation]),
    target(token) {
      if (parsed.name !== undefined) invalid('Only one project name is allowed.');
      parsed.name = token;
    },
    messages: { unknown: 'Unknown project option.', unsupported: name => `Option --${name} is not supported by project ${operation}.` },
  });
  if (parsed.help) {
    if (seen.size !== 1 || parsed.name !== undefined) invalid('Use --help without a target or other options.');
    return parsed;
  }
  if (operation === 'list' && parsed.name !== undefined) invalid('Project list does not accept a target.');
  if (!['list', 'check'].includes(operation) && parsed.name === undefined) invalid('A project name is required.');
  if (parsed.scope !== undefined && (!['current', 'archived', 'all'].includes(parsed.scope) || (parsed.scope === 'all' && (!['list', 'check'].includes(operation) || parsed.name !== undefined)))) invalid('Invalid project scope.');
  if (operation === 'archive' && !parsed.reason?.trim()) invalid('Archive requires a nonempty --reason.');
  if (parsed.status !== undefined && !parsed.status.trim()) invalid('--status must be nonempty.');
  if (parsed.part !== undefined && !['metadata', 'body', 'all'].includes(parsed.part)) invalid('--part must be metadata, body or all.');
  if (operation === 'write' && seen.has('data') === seen.has('from')) invalid('Specify exactly one of --data or --from.');
  return parsed;
}

function render(result) {
  const lines = [];
  const { operation, data } = result;
  if (data) {
    if (operation === 'list' || (operation === 'check' && data.projects)) {
      lines.push(`Projects: ${data.complete ? 'complete' : 'incomplete'}`);
      if (!data.projects.length) lines.push('(empty)');
      for (const row of data.projects) lines.push(`- ${row.name}${row.title ? `: ${row.title}` : ''} (${row.path})` +
        (operation === 'check' ? `; ${row.valid ? 'valid' : 'invalid'}` : '') +
        (row.description !== null && row.description !== undefined ? `\n  Description: ${JSON.stringify(row.description)}` : '') +
        (row.status !== null && row.status !== undefined ? `\n  Status: ${JSON.stringify(row.status)}` : ''));
    } else if (operation === 'read') {
      lines.push(`Project: ${data.project.name} (${data.project.path}); metadata: ${data.project.state}`);
      if (Object.hasOwn(data.project, 'metadata')) lines.push(JSON.stringify(data.project.metadata, null, 2));
      if (Object.hasOwn(data.project, 'body')) lines.push(data.project.body);
    } else if (operation === 'check') {
      lines.push(`Project: ${data.name}; ${data.valid ? 'valid' : 'invalid'}.`);
      for (const entry of data.routing?.entries ?? []) lines.push(`- ${entry.field}: ${entry.valid ? 'available' : 'unavailable'}; ${entry.object?.source ?? entry.path ?? entry.reference ?? '(invalid)'}`);
    } else lines.push(`${data.dryRun ? 'Preview' : data.changed ? operation === 'remove' ? 'Removed' : 'Updated' : 'Unchanged'}: ${data.path ?? data.operationId}`,
      JSON.stringify(data, null, 2));
  }
  for (const error of result.errors) lines.push(`${error.code}: ${error.message}${error.target ? ` (${error.target})` : ''}`);
  return lines.join('\n') + '\n';
}

export function runProjectCommand(args, root) {
  if (args[0] === 'management') return runProjectManagementCommand(args.slice(1), root);
  const result = { ok: false, command: 'project', operation: Object.hasOwn(supported, args[0]) ? args[0] : null, data: null, errors: [] };
  let exitCode;
  try {
    const parsed = parseProjectArgs(args);
    if (parsed.help) return { stdout: projectHelp(parsed.operation), exitCode: 0 };
    const data = parsed.operation === 'write'
      ? parsed.from !== undefined ? readInputFile(root, parsed.from) : parseInput(parsed.data) : undefined;
    const response = project({ ...parsed, data, root });
    result.data = response.data; result.errors = response.errors;
    result.ok = result.errors.length === 0;
    exitCode = result.ok ? 0 : 1;
  } catch (error) {
    const item = errorItem(error);
    if (item.data) { result.data = item.data; delete item.data; }
    result.errors = [item];
    exitCode = error instanceof MetadataError ? error.exitCode : 1;
  }
  const json = hasJsonFlag(args);
  return { stdout: json ? JSON.stringify(result) + '\n' : render(result), exitCode };
}
