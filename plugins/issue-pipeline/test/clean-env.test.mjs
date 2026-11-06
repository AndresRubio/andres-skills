import test from 'node:test';
import assert from 'node:assert/strict';

test('the clean-env preload removed GITHUB_* and git hook variables', () => {
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_REPOSITORY', 'GITHUB_SERVER_URL', 'GIT_INDEX_FILE', 'GIT_DIR', 'GIT_PREFIX', 'GIT_EDITOR']) {
    assert.equal(process.env[name], undefined, name);
  }
});
