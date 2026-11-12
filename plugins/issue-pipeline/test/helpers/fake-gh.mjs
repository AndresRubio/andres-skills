import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './git.mjs';

// routes: { "<args joined by one space>": <JSON value to print> }
// Every call is appended to <dir>/calls.log, routed or not; ghCalls(dir) reads them back in order.
// A route value of { __ghError: "<stderr text>", __ghExit?: <code, default 1> } makes the
// fake `gh` fail instead: it writes __ghError to stderr and exits with __ghExit.
export function fakeGh(routes) {
  const dir = tempDir('fake-gh-');
  const routesFile = path.join(dir, 'routes.json');
  writeFileSync(routesFile, JSON.stringify(routes));
  const script = [
    '#!/usr/bin/env node',
    `const routes = require(${JSON.stringify(routesFile)});`,
    "const key = process.argv.slice(2).join(' ');",
    `require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, key + '\\n');`,
    "if (!(key in routes)) { process.stderr.write('fake gh: no route for ' + key + '\\n'); process.exit(1); }",
    'const r = routes[key];',
    "if (r && typeof r === 'object' && '__ghError' in r) { process.stderr.write(r.__ghError + '\\n'); process.exit(r.__ghExit ?? 1); }",
    'process.stdout.write(JSON.stringify(r));',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
  return dir;
}

export function ghCalls(dir) {
  const log = path.join(dir, 'calls.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}
