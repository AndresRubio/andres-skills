import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

test('plugin.json, the marketplace entry and package.json declare the same version', () => {
  const plugin = read('../.claude-plugin/plugin.json').version;
  const entry = read('../.claude-plugin/marketplace.json').plugins[0].version;
  const pkg = read('../package.json').version;
  assert.match(plugin, /^\d+\.\d+\.\d+$/);
  assert.equal(entry, plugin, 'marketplace entry version (claude plugin validate --strict fails on a mismatch)');
  assert.equal(pkg, plugin, 'package.json version');
});
