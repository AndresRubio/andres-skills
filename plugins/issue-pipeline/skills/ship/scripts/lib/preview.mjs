import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import http from 'node:http';

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// A bare HTTP GET, resolving true/false rather than rejecting, so the poll loop
// in startPreview doesn't need its own try/catch around every attempt.
function probeOnce(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume(); // drain and free the socket; we only care that something answered
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Kills the whole process group `pid` leads (its own children, and any of
// theirs — e.g. the `vite` an `npm run dev` spawns), the same way chrome.mjs's
// takeScreenshot cleans up Chrome's helper processes. ESRCH (already gone) is
// swallowed by callers that document that as success; startPreview's own
// timeout cleanup swallows everything since it's best-effort.
function killGroup(pid, signal) {
  process.kill(-pid, signal);
}

// Spawns `config.preview.command` (with every `{port}` replaced by `port`) detached
// in its own process group, and resolves once it answers on `http://localhost:<port>/`
// or rejects (after killing the group) once `timeoutMs` passes. The PID is written to
// `pidFile` before the wait starts, so a caller can always find it to clean up.
export async function startPreview({ config, port, cwd, logFile, pidFile, timeoutMs = 60_000 }) {
  if (!config || !config.preview) {
    throw new Error('preview.command is not configured in pipeline.json');
  }
  const command = config.preview.command.replaceAll('{port}', String(port));

  const logFd = openSync(logFile, 'a');
  let child;
  try {
    child = spawn('sh', ['-c', command], {
      cwd,
      detached: true, // makes `child` the leader of its own process group, so -child.pid stops the whole tree
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd); // the child keeps its own duplicated descriptor; the parent's copy isn't needed
  }
  child.on('error', () => {}); // avoid an unhandled 'error' crash; a spawn failure just means the URL never answers
  writeFileSync(pidFile, String(child.pid));
  child.unref(); // don't keep our own event loop (or the CLI process) alive for a detached, fire-and-forget child

  const url = `http://localhost:${port}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeOnce(url)) return { pid: child.pid, url };
    await sleep(250);
  }
  try {
    killGroup(child.pid, 'SIGTERM');
  } catch {
    // already gone, or never really started — nothing left to clean up
  }
  throw new Error(`preview did not answer on port ${port} within ${timeoutMs} ms`);
}

// Sends SIGTERM to the process group named by the PID in `pidFile`, treats
// "already gone" (ESRCH) as success, and removes the PID file.
export function stopPreview({ pidFile }) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  try {
    killGroup(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // already gone
  }
  return { stopped: true };
}
