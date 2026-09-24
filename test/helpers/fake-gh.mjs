import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './git.mjs';

// routes: { "<args joined by one space>": <JSON value to print> }
export function fakeGh(routes) {
  const dir = tempDir('fake-gh-');
  const routesFile = path.join(dir, 'routes.json');
  writeFileSync(routesFile, JSON.stringify(routes));
  const script = [
    '#!/usr/bin/env node',
    `const routes = require(${JSON.stringify(routesFile)});`,
    "const key = process.argv.slice(2).join(' ');",
    "if (!(key in routes)) { process.stderr.write('fake gh: no route for ' + key + '\\n'); process.exit(1); }",
    'process.stdout.write(JSON.stringify(routes[key]));',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
  return dir;
}
