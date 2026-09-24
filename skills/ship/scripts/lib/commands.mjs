import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseSource } from './source.mjs';
import { branchName, keyFromBranch, worktreePath } from './naming.mjs';

export class UsageError extends Error {}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function parse(argv, options = {}, positionals = 0) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (parsed.positionals.length !== positionals) {
    throw new UsageError(`expected ${positionals} positional argument(s), got ${parsed.positionals.length}`);
  }
  return { ...parsed.values, _: parsed.positionals };
}

export function required(values, ...names) {
  for (const name of names) {
    if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  }
}

const PLUGIN_JSON = new URL('../../../../.claude-plugin/plugin.json', import.meta.url);

export const COMMANDS = {
  version: (argv) => {
    parse(argv);
    return { version: readJson(PLUGIN_JSON).version };
  },
  source: (argv) => parseSource(parse(argv, {}, 1)._[0]),
  'branch-name': (argv) => {
    const v = parse(argv, { key: { type: 'string' }, title: { type: 'string' } });
    required(v, 'key', 'title');
    return { branch: branchName(v.key, v.title) };
  },
  'key-from-branch': (argv) => ({ key: keyFromBranch(parse(argv, {}, 1)._[0]) }),
  'worktree-path': (argv) => {
    const v = parse(argv, { 'repo-root': { type: 'string' }, key: { type: 'string' } });
    required(v, 'repo-root', 'key');
    return { path: worktreePath(v['repo-root'], v.key) };
  },
};
