import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockStatus } from '../skills/ship/scripts/lib/lock.mjs';
import { runCli } from './helpers/cli.mjs';
import { tempDir } from './helpers/git.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const lockComment = (at) => ({
  author: 'AndresRubio',
  authorAssociation: 'OWNER',
  body: '',
  createdAt: at,
  marker: { kind: 'lock', at, run: 'local' },
});
const NOW = new Date('2026-09-25T12:00:00Z');

test('no claude-working label means unlocked', () => {
  assert.deepEqual(lockStatus({ labels: [], comments: [lockComment('2026-09-25T11:00:00Z')] }, { ttlHours: 3, now: NOW }),
    { locked: false, stale: false, since: '2026-09-25T11:00:00Z' });
});

test('a recent lock is fresh; an old one is stale', () => {
  const fresh = lockStatus({ labels: ['claude-working'], comments: [lockComment('2026-09-25T11:00:00Z')] }, { ttlHours: 3, now: NOW });
  assert.deepEqual(fresh, { locked: true, stale: false, since: '2026-09-25T11:00:00Z' });
  const old = lockStatus({ labels: ['claude-working'], comments: [lockComment('2026-09-25T08:00:00Z')] }, { ttlHours: 3, now: NOW });
  assert.equal(old.stale, true);
});

test('the newest lock comment counts', () => {
  const s = lockStatus({ labels: ['claude-working'], comments: [lockComment('2026-09-25T01:00:00Z'), lockComment('2026-09-25T11:30:00Z')] }, { ttlHours: 3, now: NOW });
  assert.equal(s.since, '2026-09-25T11:30:00Z');
  assert.equal(s.stale, false);
});

test('a label with no lock comment is stale', () => {
  assert.deepEqual(lockStatus({ labels: ['claude-working'], comments: [] }, { ttlHours: 3, now: NOW }), { locked: true, stale: true, since: null });
});

test('an untrusted lock comment is ignored even if dated in the future', () => {
  const untrusted = { ...lockComment('2099-01-01T00:00:00Z'), authorAssociation: 'NONE' };
  assert.deepEqual(lockStatus({ labels: ['claude-working'], comments: [untrusted] }, { ttlHours: 3, now: NOW }),
    { locked: true, stale: true, since: null });
});

test('since uses createdAt (GitHub server time), not marker.at', () => {
  const c = { ...lockComment('2026-09-25T11:00:00Z'), marker: { kind: 'lock', at: '2099-01-01T00:00:00Z', run: 'local' } };
  const s = lockStatus({ labels: ['claude-working'], comments: [c] }, { ttlHours: 3, now: NOW });
  assert.deepEqual(s, { locked: true, stale: false, since: '2026-09-25T11:00:00Z' });
});

test('CLI lock-status reads an issue file', () => {
  const file = path.join(tempDir(), 'issue.json');
  writeFileSync(file, JSON.stringify({ labels: ['claude-working'], comments: [lockComment('2026-09-25T11:00:00Z')] }));
  const r = runCli(['lock-status', '--issue-file', file, '--ttl-hours', '3', '--now', '2026-09-25T12:00:00Z']);
  assert.deepEqual(r.json(), { locked: true, stale: false, since: '2026-09-25T11:00:00Z' });
});
