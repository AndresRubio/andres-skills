import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function git(cwd, args) {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main',
      '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    },
  );
}

export function tempDir(prefix = 'cp-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

export function makeRepoWithOrigin(files = {}) {
  const base = tempDir();
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'work');
  git(base, ['init', '--bare', remote]);
  git(base, ['clone', remote, root]);
  writeFiles(root, { 'README.md': 'test\n', ...files });
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['push', '-u', 'origin', 'HEAD:main']);
  git(root, ['remote', 'set-head', 'origin', 'main']);
  return { base, remote, root };
}
