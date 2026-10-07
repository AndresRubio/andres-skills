import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPreview, stopPreview } from '../skills/ship/scripts/lib/preview.mjs';
import { findFreePort } from '../skills/ship/scripts/lib/runtime.mjs';
import { tempDir } from './helpers/git.mjs';
import { runCli } from './helpers/cli.mjs';

// Safety net so a failing assertion never leaves a server running: reads whatever
// PID (if any) was recorded and kills its whole process group.
function killLeftoverGroup(pidFile) {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// A tiny HTTP server, run directly as the preview command (single-process case).
function serverScript(dir) {
  const file = path.join(dir, 'server.mjs');
  writeFileSync(file, `
    import http from 'node:http';
    const port = Number(process.argv[2]);
    http.createServer((req, res) => res.end('ok')).listen(port);
  `);
  return file;
}

// A wrapper that spawns the server as an ordinary (non-detached) child, the way
// \`npm run dev\` spawns vite: the server ends up a grandchild of the process
// preview-start itself launches (the \`sh -c\` leader), only reachable by killing
// the whole process group, not just the leader's own PID.
function wrapperScript(dir, serverFile, serverPidFile) {
  const file = path.join(dir, 'wrapper.mjs');
  writeFileSync(file, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const port = process.argv[2];
    const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(serverFile)}, port], { stdio: 'inherit' });
    writeFileSync(${JSON.stringify(serverPidFile)}, String(child.pid));
  `);
  return file;
}

test('startPreview resolves once the server answers, with the PID recorded on disk', async (t) => {
  const dir = tempDir('preview-');
  const pidFile = path.join(dir, 'preview.pid');
  t.after(() => killLeftoverGroup(pidFile));

  const server = serverScript(dir);
  const port = await findFreePort(45300);
  const config = { preview: { command: `"${process.execPath}" "${server}" {port}` } };

  const result = await startPreview({
    config, port, cwd: dir, logFile: path.join(dir, 'preview.log'), pidFile, timeoutMs: 5000,
  });

  assert.equal(result.url, `http://localhost:${port}/`);
  assert.equal(typeof result.pid, 'number');
  assert.equal(Number(readFileSync(pidFile, 'utf8').trim()), result.pid);

  await stopPreview({ pidFile });
});

test('stopPreview kills the whole process group, including a grandchild server', async (t) => {
  const dir = tempDir('preview-');
  const pidFile = path.join(dir, 'preview.pid');
  t.after(() => killLeftoverGroup(pidFile));

  const serverPidFile = path.join(dir, 'server.pid');
  const server = serverScript(dir);
  const wrapper = wrapperScript(dir, server, serverPidFile);
  const port = await findFreePort(45310);
  const config = { preview: { command: `"${process.execPath}" "${wrapper}" {port}` } };

  await startPreview({
    config, port, cwd: dir, logFile: path.join(dir, 'preview.log'), pidFile, timeoutMs: 5000,
  });

  // by the time startPreview resolves the server has answered HTTP, so its wrapper
  // has already written its PID — but poll briefly for filesystem safety anyway.
  for (let i = 0; i < 40 && !existsSync(serverPidFile); i += 1) await new Promise((r) => { setTimeout(r, 50); });
  const serverPid = Number(readFileSync(serverPidFile, 'utf8').trim());
  assert.doesNotThrow(() => process.kill(serverPid, 0), 'the grandchild server should be alive before stopPreview');

  const result = await stopPreview({ pidFile });
  assert.deepEqual(result, { stopped: true });
  assert.equal(existsSync(pidFile), false);

  for (let i = 0; i < 40; i += 1) {
    try { process.kill(serverPid, 0); } catch { break; }
    await new Promise((r) => { setTimeout(r, 50); });
  }
  assert.throws(() => process.kill(serverPid, 0), /ESRCH/, 'the grandchild server should be gone after stopPreview');
});

test('startPreview times out and kills the process group, leaving nothing behind', async (t) => {
  const dir = tempDir('preview-');
  const pidFile = path.join(dir, 'preview.pid');
  t.after(() => killLeftoverGroup(pidFile));

  const config = { preview: { command: 'sleep 30' } }; // never listens
  const port = await findFreePort(45320);

  await assert.rejects(
    startPreview({ config, port, cwd: dir, logFile: path.join(dir, 'preview.log'), pidFile, timeoutMs: 700 }),
    new RegExp(`preview did not answer on port ${port} within 700 ms`),
  );

  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  for (let i = 0; i < 40; i += 1) {
    try { process.kill(pid, 0); } catch { break; }
    await new Promise((r) => { setTimeout(r, 50); });
  }
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the timed-out process should be gone');
});

test('startPreview rejects when preview is not configured (preview: null)', async () => {
  const dir = tempDir('preview-');
  await assert.rejects(
    startPreview({
      config: { preview: null }, port: 45330, cwd: dir,
      logFile: path.join(dir, 'preview.log'), pidFile: path.join(dir, 'preview.pid'), timeoutMs: 1000,
    }),
    /preview/i,
  );
});

test('stopPreview treats an already-exited PID as success and removes the PID file', async () => {
  const dir = tempDir('preview-');
  const pidFile = path.join(dir, 'preview.pid');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => child.on('exit', resolve));
  writeFileSync(pidFile, String(child.pid));

  const result = await stopPreview({ pidFile });
  assert.deepEqual(result, { stopped: true });
  assert.equal(existsSync(pidFile), false);
});

test('CLI preview-start / preview-stop are wired end to end', async (t) => {
  const dir = tempDir('preview-');
  const pidFile = path.join(dir, 'preview.pid');
  t.after(() => killLeftoverGroup(pidFile));

  const server = serverScript(dir);
  const port = await findFreePort(45340);
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ preview: { command: `"${process.execPath}" "${server}" {port}` } }));

  const start = runCli([
    'preview-start', '--config-file', configFile, '--port', String(port), '--cwd', dir,
    '--log', path.join(dir, 'preview.log'), '--pid-file', pidFile, '--timeout-ms', '5000',
  ]);
  assert.equal(start.code, 0, start.stderr);
  const startJson = start.json();
  assert.equal(startJson.url, `http://localhost:${port}/`);
  assert.equal(typeof startJson.pid, 'number');

  const stop = runCli(['preview-stop', '--pid-file', pidFile]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.deepEqual(stop.json(), { stopped: true });
});

test('CLI preview-start exits 1 with a JSON error when preview is not configured', () => {
  const dir = tempDir('preview-');
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ preview: null }));
  const r = runCli([
    'preview-start', '--config-file', configFile, '--port', '45350', '--cwd', dir,
    '--log', path.join(dir, 'preview.log'), '--pid-file', path.join(dir, 'preview.pid'), '--timeout-ms', '500',
  ]);
  assert.equal(r.code, 1, r.stdout);
  assert.match(JSON.parse(r.stderr).error, /preview/i);
});
