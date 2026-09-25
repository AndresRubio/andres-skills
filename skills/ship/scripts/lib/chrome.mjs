import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAC_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const LINUX_BINARIES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

export function whichSync(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function findChrome({ env = process.env, platform = process.platform, exists = existsSync, which = whichSync } = {}) {
  if (env.CLAUDE_PIPELINE_CHROME) return exists(env.CLAUDE_PIPELINE_CHROME) ? env.CLAUDE_PIPELINE_CHROME : null;
  if (platform === 'darwin') {
    const app = MAC_APPS.find((p) => exists(p));
    if (app) return app;
  }
  for (const name of LINUX_BINARIES) {
    const hit = which(name);
    if (hit) return hit;
  }
  return null;
}

export function screenshotArgs(url, out, { width = 1280, height = 800, userDataDir } = {}) {
  return [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`, `--window-size=${width},${height}`, '--virtual-time-budget=5000',
    `--screenshot=${path.resolve(out)}`, url,
  ];
}

// Waits (up to timeoutMs) for `child`'s exit to be observed, so callers that just
// sent it a kill signal can be sure it's actually gone before moving on. Resolves
// immediately if the child has already exited.
function waitForExit(child, timeoutMs = 2000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Polls `target` every intervalMs. Resolves as soon as the file exists, is non-empty,
// and its size hasn't changed since the previous poll (i.e. Chrome has finished
// writing it) — regardless of whether the Chrome process itself has exited. Rejects
// if the child exits first (nothing left to wait for), errors on spawn, or the
// timeout elapses first.
function waitForStableFile(target, { child, timeoutMs, intervalMs = 200, stderrState }) {
  return new Promise((resolve, reject) => {
    let lastSize = -1;
    let settled = false;
    let poller;
    let timer;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      fn(value);
    };

    function check() {
      let size;
      try {
        size = statSync(target).size;
      } catch {
        return;
      }
      if (size > 0 && size === lastSize) {
        finish(resolve);
        return;
      }
      lastSize = size;
    }

    function onExit(code) {
      finish(reject, new Error(`Chrome exited (code ${code}) without writing ${target}: ${stderrState.tail}`));
    }

    function onError(err) {
      finish(reject, err);
    }

    poller = setInterval(check, intervalMs);
    timer = setTimeout(
      () => finish(reject, new Error(`timed out after ${timeoutMs}ms waiting for ${target}`)),
      timeoutMs,
    );
    child.once('exit', onExit);
    child.once('error', onError);
    check();
  });
}

export async function takeScreenshot(url, out, { width = 1280, height = 800, timeoutMs = 60_000, ...find } = {}) {
  const chrome = findChrome(find);
  if (!chrome) throw new Error('no Chrome or Chromium found (set CLAUDE_PIPELINE_CHROME)');
  const target = path.resolve(out);
  rmSync(target, { force: true }); // a stale file from a previous run must not satisfy the wait
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'cp-chrome-'));
  const child = spawn(chrome, screenshotArgs(url, target, { width, height, userDataDir }), {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true, // makes `child` the leader of its own process group, so -child.pid kills the whole tree
  });
  child.on('error', () => {}); // avoid an unhandled 'error' crash; waitForStableFile's own listener surfaces it
  const stderrState = { tail: '' };
  child.stderr.on('data', (chunk) => {
    stderrState.tail = (stderrState.tail + chunk.toString()).slice(-2000);
  });
  try {
    await waitForStableFile(target, { child, timeoutMs, stderrState });
    return { path: target, chrome };
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL'); // whole process group: Chrome plus its GPU/renderer/utility helpers
    } catch {
      // already exited, or never started
    }
    await waitForExit(child);
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
