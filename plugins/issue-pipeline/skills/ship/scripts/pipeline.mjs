#!/usr/bin/env node
import { COMMANDS, UsageError, ExitError } from './lib/commands.mjs';

const [name, ...argv] = process.argv.slice(2);
if (!Object.hasOwn(COMMANDS, name)) {
  const message = `unknown command "${name}"; expected one of: ${Object.keys(COMMANDS).join(', ')}`;
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(2);
}
const command = COMMANDS[name];
try {
  const result = await command(argv);
  process.stdout.write(typeof result === 'string' ? `${result}\n` : `${JSON.stringify(result)}\n`);
} catch (err) {
  if (err instanceof ExitError) {
    process.stdout.write(`${JSON.stringify(err.result)}\n`);
    process.exit(1);
  }
  process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
  process.exit(err instanceof UsageError ? 2 : 1);
}
