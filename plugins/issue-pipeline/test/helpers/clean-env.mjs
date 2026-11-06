// Preload for the test run (see the "test" script in package.json).
// In GitHub Actions, GITHUB_RUN_ID and friends are set, and library code reads them as defaults,
// so tests that expect the marker "local" got a run URL.
// Inside a git hook, git exports GIT_INDEX_FILE, GIT_DIR and the rest of its local variables,
// which pointed the temporary repos and worktrees the tests build at the hook's own repository.
// Dropping these here gives every test file, and every child process it spawns, the same clean base.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GITHUB_')) delete process.env[name];
}

// Output of `git rev-parse --local-env-vars`, plus the author, committer and editor variables.
const GIT_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_EDITOR',
];
for (const name of GIT_VARS) delete process.env[name];
