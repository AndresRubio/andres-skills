import { git } from './git.mjs';

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|specs)\//;
const TEST_NAME = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb)$|_spec\.rb$/;
// A file under a test directory counts only when it is code: fixtures, snapshots, specs in
// Markdown or OpenAPI YAML are not tests. Shell scripts (sh, bats) count, as test runners.
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rb|rs|java|kt|cs|php|swift|sh|bats)$/;
export function isTestFile(file) {
  return (TEST_PATH.test(file) && CODE_EXT.test(file)) || TEST_NAME.test(file);
}

const ASSERTION = /\b(expect|assert\w*|should)\b/;
const SKIP_MARKERS = [
  [/\b(it|test|describe|suite)\.only\(/, '.only('], [/\b(it|test|describe|suite)\.skip\(/, '.skip('], [/\b(xit|xtest|xdescribe)\(/, 'x-prefixed test'],
  [/\bit\.todo\(/, 'it.todo('], [/@ts-ignore/, '@ts-ignore'], [/@ts-expect-error/, '@ts-expect-error'], [/eslint-disable/, 'eslint-disable'],
  [/#\s*noqa\b/, '# noqa'], [/#\s*type:\s*ignore/, '# type: ignore'], [/@pytest\.mark\.skip/, '@pytest.mark.skip'], [/@unittest\.skip/, '@unittest.skip'],
];
const TEST_CONFIG = /(^|\/)((vitest|jest|mocha|karma|playwright|cypress|ava|tap)\.config\.[cm]?[jt]s|\.mocharc[^/]*|jest\.config[^/]*|pytest\.ini|setup\.cfg|tox\.ini|pyproject\.toml|tsconfig[^/]*\.json|jsconfig\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|biome\.json[c]?|\.nycrc[^/]*|codecov\.ya?ml|\.coveragerc|\.ruff\.toml|ruff\.toml|mypy\.ini)$/;
const DEPENDENCY = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|poetry\.lock|uv\.lock|pyproject\.toml|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock))$/;
const COVERAGE = /coverage|threshold/i;

function parseNameStatus(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [status, a, b] = line.split('\t');
    rows.push({ status: status[0], file: a, renamedTo: b });
  }
  return rows;
}

// Splits a unified diff into { file: { added: [lines], removed: [lines] } }, using the +++ b/ path.
// Hunk-aware parser that respects @@ line counts to avoid confusing content with headers.
function parsePatch(text) {
  const files = {};
  const lines = text.split('\n');
  let i = 0;
  let currentFile = null;
  let removedLeft = 0;
  let addedLeft = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Start of a new file section
    if (line.startsWith('diff --git')) {
      currentFile = null;
      removedLeft = 0;
      addedLeft = 0;
      i++;
      continue;
    }

    // File headers (before any @@)
    if (removedLeft === 0 && addedLeft === 0) {
      if (line.startsWith('--- ')) {
        i++;
        continue;
      }
      if (line.startsWith('+++ ')) {
        // Extract path, strip trailing tab if present, then strip b/ prefix
        let p = line.slice(4);
        p = p.replace(/\t.*$/, '');
        p = p.replace(/^b\//, '');
        currentFile = p === '/dev/null' ? null : (files[p] ??= { added: [], removed: [] });
        i++;
        continue;
      }
      if (line.startsWith('index ')) {
        i++;
        continue;
      }
    }

    // Hunk header: @@ -a[,b] +c[,d] @@
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        removedLeft = parseInt(match[2] ?? '1', 10);
        addedLeft = parseInt(match[4] ?? '1', 10);
      }
      i++;
      continue;
    }

    // Skip "\ No newline at end of file"
    if (line === '\\ No newline at end of file') {
      i++;
      continue;
    }

    // Hunk body lines
    if (removedLeft > 0 || addedLeft > 0) {
      if (currentFile && line.startsWith('-')) {
        currentFile.removed.push(line.slice(1));
        removedLeft--;
      } else if (currentFile && line.startsWith('+')) {
        currentFile.added.push(line.slice(1));
        addedLeft--;
      } else if (line.startsWith(' ')) {
        // Context line
        removedLeft--;
        addedLeft--;
      }
      // Ignore other lines (e.g., lines with no prefix at end of hunk)
      i++;
      continue;
    }

    i++;
  }

  return files;
}

export function analyzeDiff({ nameStatus, patch }) {
  const hits = [];
  const rows = parseNameStatus(nameStatus);
  const files = parsePatch(patch);
  for (const row of rows) {
    if ((row.status === 'D' || row.status === 'R') && isTestFile(row.file)) {
      hits.push({ rule: 'test-file-removed', file: row.file, detail: row.status === 'D' ? 'deleted' : `renamed to ${row.renamedTo}` });
    }
  }
  for (const [file, { added, removed }] of Object.entries(files)) {
    if (isTestFile(file)) {
      const lost = removed.filter((l) => ASSERTION.test(l)).length;
      const gained = added.filter((l) => ASSERTION.test(l)).length;
      if (lost > gained) hits.push({ rule: 'assertions-lost', file, detail: `assertions: ${lost} removed, ${gained} added` });
    }
    for (const line of added) {
      for (const [re, label] of SKIP_MARKERS) {
        if (re.test(line)) hits.push({ rule: 'skip-marker', file, detail: `${label}: ${line.trim().slice(0, 120)}` });
      }
    }
  }
  for (const row of rows) {
    const file = row.renamedTo ?? row.file;
    if (TEST_CONFIG.test(file)) {
      const addedText = (files[file]?.added ?? []).join('\n');
      hits.push({ rule: 'test-config-changed', file, detail: COVERAGE.test(addedText) ? 'coverage threshold or test/lint/typecheck config changed' : 'test, lint or typecheck config changed' });
    }
    if (DEPENDENCY.test(file)) hits.push({ rule: 'dependency-changed', file, detail: row.status === 'A' ? 'manifest or lockfile added' : 'manifest or lockfile changed' });
  }
  return { hits };
}

const EXCLUDE = ['--', '.', ':(exclude)docs/pipeline'];
export function diffRisk(cwd, base) {
  const nameStatus = git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-status', `${base}...HEAD`, ...EXCLUDE]);
  const patch = git(cwd, ['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', `${base}...HEAD`, ...EXCLUDE]);
  return { base, ...analyzeDiff({ nameStatus, patch }) };
}
