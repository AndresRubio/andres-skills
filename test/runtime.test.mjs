import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { findFreePort, parseNumstat, diffSize } from '../skills/ship/scripts/lib/runtime.mjs';
import { git, makeRepoWithOrigin, writeFiles } from './helpers/git.mjs';
import { runCli } from './helpers/cli.mjs';

test('findFreePort skips a port that is in use', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const busy = server.address().port;
  try {
    const port = await findFreePort(busy);
    assert.notEqual(port, busy);
    assert.ok(port > busy);
  } finally {
    server.close();
  }
});

test('findFreePort skips a port bound only on 127.0.0.1 (e.g. a dev server\'s default)', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const busy = server.address().port;
  try {
    const port = await findFreePort(busy);
    assert.notEqual(port, busy);
    assert.ok(port > busy);
  } finally {
    server.close();
  }
});

test('parseNumstat counts files and lines, binary files count as files only', () => {
  assert.deepEqual(parseNumstat('3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n-\t-\timg.png\n'), { files: 3, lines: 14 });
  assert.deepEqual(parseNumstat(''), { files: 0, lines: 0 });
});

test('diffSize measures the branch against its base', () => {
  const { root } = makeRepoWithOrigin();
  git(root, ['checkout', '-b', 'claude/1-x']);
  writeFiles(root, { 'a.txt': 'one\ntwo\n', 'b.txt': 'three\n' });
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'work']);
  assert.deepEqual(diffSize(root, 'origin/main'), { files: 2, lines: 3 });
  assert.deepEqual(runCli(['diff-size', '--base', 'origin/main', '--cwd', root]).json(), { files: 2, lines: 3 });
});

test('diffSize leaves out docs/pipeline (the pipeline\'s own docs, not the change being measured)', () => {
  const { root } = makeRepoWithOrigin();
  git(root, ['checkout', '-b', 'claude/1-x']);
  writeFiles(root, { 'a.txt': 'one\ntwo\n', 'docs/pipeline/1/plan.md': 'x\ny\nz\nw\n' });
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'work']);
  assert.deepEqual(diffSize(root, 'origin/main'), { files: 1, lines: 2 });
});

test('CLI free-port prints a port', () => {
  const r = runCli(['free-port', '--start', '45100']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Number.isInteger(r.json().port));
});
