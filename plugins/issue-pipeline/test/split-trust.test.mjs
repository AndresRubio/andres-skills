import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitInto } from '../skills/ship/scripts/lib/split.mjs';
import { issueTrusted } from '../skills/ship/scripts/lib/lock.mjs';

const at = '2026-11-13T22:32:10Z';
const split = (id, line, over = {}) => ({
  id, author: 'claude[bot]', authorAssociation: 'NONE', createdAt: at,
  body: `**[issue-pipeline]** split · ${at} · local\n\n# Grade for 4\n\n${line}\n`,
  marker: { kind: 'split', at, run: 'local' }, ...over,
});

test('splitInto reads the last line of the latest pipeline split comment', () => {
  assert.deepEqual(splitInto([split(1, 'Split into: 28, 29, 30')]), [28, 29, 30]);
  assert.deepEqual(splitInto([split(1, 'Split into: 28,29 ,30  ')]), [28, 29, 30]);
  assert.deepEqual(splitInto([split(1, 'Split into: 28, 28, 29')]), [28, 29]);
  assert.deepEqual(splitInto([split(2, 'Split into: 40'), split(1, 'Split into: 28')]), [40], 'latest by id, not by array order');
  assert.deepEqual(splitInto([split(1, 'Split into: 28'), split(2, 'no line here')]), [], 'the latest split comment decides');
  assert.deepEqual(splitInto([split(1, '`Split into: 28`')]), []);
  assert.deepEqual(splitInto([split(1, '- Split into: 28')]), [], 'a list bullet is not the line');
  assert.deepEqual(splitInto([split(1, '**Split into:** 28')]), [], 'bold is not the line');
  assert.deepEqual(splitInto([split(1, 'Split into: 28\n\nThanks')]), [], 'nothing may follow the line');
  assert.deepEqual(splitInto([split(1, 'Split into: 28', { author: 'stranger' })]), [], 'not a pipeline comment');
  assert.deepEqual(splitInto([split(1, 'Split into: 28', { marker: { kind: 'report', at, run: 'local' } })]), []);
  assert.deepEqual(splitInto([]), []);
});

test('splitInto stays linear on a long hostile line', () => {
  const body = `**[issue-pipeline]** split · ${at} · local\n\nSplit into: ${'1, '.repeat(70_000)}x`;
  const start = process.hrtime.bigint();
  assert.deepEqual(splitInto([{ ...split(1, ''), body }]), []);
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 1000);
});

const child = (over = {}) => ({
  number: 28, author: 'claude[bot]', authorAssociation: 'NONE',
  parent: { number: 4, authorAssociation: 'OWNER', splitInto: [28, 29, 30] }, ...over,
});

test('issueTrusted: a trusted association, or a pipeline-bot sub-issue that its trusted parent split into', () => {
  assert.equal(issueTrusted({ number: 5, author: 'AndresRubio', authorAssociation: 'OWNER' }), true);
  assert.equal(issueTrusted(child()), true);
  assert.equal(issueTrusted(child({ author: 'github-actions[bot]' })), true);
});

test('issueTrusted refuses any other sub-issue', () => {
  assert.equal(issueTrusted(child({ parent: null })), false);
  assert.equal(issueTrusted(child({ parent: undefined })), false);
  assert.equal(issueTrusted(child({ parent: { number: 4, authorAssociation: 'NONE', splitInto: [28] } })), false, 'a bot-written parent does not vouch');
  assert.equal(issueTrusted(child({ parent: { number: 4, authorAssociation: 'OWNER', splitInto: [] } })), false);
  assert.equal(issueTrusted(child({ parent: { number: 4, authorAssociation: 'OWNER', splitInto: [128, 280] } })), false);
  assert.equal(issueTrusted(child({ author: 'stranger' })), false, 'only a pipeline bot can be vouched for');
  assert.equal(issueTrusted(child({ author: 'other-app[bot]' })), false);
});
