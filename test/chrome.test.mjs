import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findChrome, screenshotArgs, takeScreenshot } from '../skills/ship/scripts/lib/chrome.mjs';
import { tempDir } from './helpers/git.mjs';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('findChrome prefers the override, then macOS apps, then Linux binaries', () => {
  const exists = (p) => p === MAC_CHROME || p === '/opt/chrome';
  const which = (name) => (name === 'chromium' ? '/usr/bin/chromium' : null);
  assert.equal(findChrome({ env: { CLAUDE_PIPELINE_CHROME: '/opt/chrome' }, platform: 'darwin', exists, which }), '/opt/chrome');
  assert.equal(findChrome({ env: {}, platform: 'darwin', exists, which }), MAC_CHROME);
  assert.equal(findChrome({ env: {}, platform: 'linux', exists, which }), '/usr/bin/chromium');
  assert.equal(findChrome({ env: {}, platform: 'linux', exists: () => false, which: () => null }), null);
});

test('screenshotArgs isolates the profile and sets the size', () => {
  const args = screenshotArgs('http://localhost:5173/', '/tmp/out.png', { width: 800, height: 600, userDataDir: '/tmp/prof' });
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--window-size=800,600'));
  assert.ok(args.includes('--user-data-dir=/tmp/prof'));
  assert.ok(args.includes('--screenshot=/tmp/out.png'));
  assert.equal(args.at(-1), 'http://localhost:5173/');
});

test('takeScreenshot writes a PNG when Chrome is available', async (t) => {
  if (!findChrome()) {
    t.skip('no Chrome or Chromium on this machine');
    return;
  }
  const server = http.createServer((req, res) => res.end('<h1>hello</h1>'));
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const out = path.join(tempDir(), 'shot.png');
    const r = takeScreenshot(`http://127.0.0.1:${server.address().port}/`, out);
    const bytes = readFileSync(r.path);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    server.close();
  }
});
