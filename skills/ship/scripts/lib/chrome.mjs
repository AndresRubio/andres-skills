import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
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

export function takeScreenshot(url, out, { width = 1280, height = 800, ...find } = {}) {
  const chrome = findChrome(find);
  if (!chrome) throw new Error('no Chrome or Chromium found (set CLAUDE_PIPELINE_CHROME)');
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'cp-chrome-'));
  execFileSync(chrome, screenshotArgs(url, out, { width, height, userDataDir }), { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  if (!existsSync(out)) throw new Error(`Chrome did not write ${out}`);
  return { path: path.resolve(out), chrome };
}
