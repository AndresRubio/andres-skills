#!/usr/bin/env node
import { COMMANDS, UsageError } from './lib/commands.mjs';

const [name, ...argv] = process.argv.slice(2);
const command = COMMANDS[name];
if (!command) {
  process.stderr.write(`usage: pipeline <${Object.keys(COMMANDS).join('|')}> [...]\n`);
  process.exit(2);
}
try {
  const result = await command(argv);
  process.stdout.write(typeof result === 'string' ? `${result}\n` : `${JSON.stringify(result)}\n`);
} catch (err) {
  process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
  process.exit(err instanceof UsageError ? 2 : 1);
}
