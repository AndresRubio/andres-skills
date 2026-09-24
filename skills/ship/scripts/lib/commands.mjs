import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

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
};
