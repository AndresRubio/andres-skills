#!/usr/bin/env node
// Prints a fixture's issue body with its placeholders filled. Usage: fill-body.mjs <fixture-file> [<sandbox-dir>]
//   {{PRIVATE_REPO}}               $SANDBOX_PRIVATE_REPO, else <gh user>/pipeline-sandbox-private
//   {{ISSUE:<fixture file>}}       that fixture's issue number from <sandbox-dir>/.pipeline-fixtures.json
//   {{PERMALINK:<path>:<a>-<b>}}   https://github.com/<repo>/blob/<origin/HEAD sha>/<path>#L<a>-L<b>
//   {{CI_RUN}}                     the latest ci.yml run on main
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = /\{\{([A-Z_]+)(?::([^}]+))?\}\}/g;

export function fillBody(text, resolve) {
  return text.replace(PLACEHOLDER, (_, name, arg) => {
    const value = resolve(name, arg);
    if (value === undefined || value === null || value === '') throw new Error(`no value for {{${name}${arg ? `:${arg}` : ''}}}`);
    return String(value);
  });
}

export const bodyOf = (fixtureText) => fixtureText.split('\n').slice(3).join('\n');

function sandboxResolver(sandbox) {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: sandbox, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let repo;
  const repoName = () => (repo ??= run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']));
  return (name, arg) => {
    if (name === 'PRIVATE_REPO') return process.env.SANDBOX_PRIVATE_REPO || `${run('gh', ['api', 'user', '--jq', '.login'])}/pipeline-sandbox-private`;
    if (name === 'ISSUE') return JSON.parse(readFileSync(path.join(sandbox, '.pipeline-fixtures.json'), 'utf8'))[arg];
    if (name === 'PERMALINK') {
      const [file, range] = arg.split(':');
      const [a, b] = range.split('-');
      return `https://github.com/${repoName()}/blob/${run('git', ['rev-parse', 'origin/HEAD'])}/${file}#L${a}-L${b}`;
    }
    if (name === 'CI_RUN') {
      const id = run('gh', ['run', 'list', '--workflow', 'ci.yml', '--branch', 'main', '--limit', '1', '--json', 'databaseId', '-q', '.[0].databaseId']);
      return id ? `https://github.com/${repoName()}/actions/runs/${id}` : null;
    }
    return null;
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [fixture, sandbox = process.cwd()] = process.argv.slice(2);
  process.stdout.write(fillBody(bodyOf(readFileSync(fixture, 'utf8')), sandboxResolver(path.resolve(sandbox))));
}
