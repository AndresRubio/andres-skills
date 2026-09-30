import { readFileSync } from 'node:fs';
import path from 'node:path';

// The run guard's logic. hooks/guard.mjs is the thin I/O wrapper around it.
//
// A seatbelt, not a security boundary: it reads a Bash command as text and refuses the
// shapes that push somewhere other than the run's claude/* branch, or that merge. A script
// written to a file and then run gets past it. The boundaries are a token scoped to the repo
// and branch protection.

const ALLOW = { allow: true };
const deny = (reason) => ({ allow: false, reason });

// --- activation ---

// Every pipeline command sources vars.sh from the runs folder or calls pipeline.mjs, so
// a run switches the guard on for its session from Setup onward.
export function isActivating(command, home) {
  const homes = [home, path.resolve(home)].map((h) => h.replace(/\/+$/, ''));
  const needles = ['CLAUDE_PIPELINE_HOME', '.claude-pipeline/runs/', 'scripts/pipeline.mjs', ...homes.map((h) => `${h}/runs/`)];
  return needles.some((needle) => command.includes(needle));
}

// --- merges and ref writes (raw text, including text inside quotes) ---

const MERGE_RULES = [
  [/\bpr\s+merge\b/, 'merging a pull request'],
  [/\bgh\s+alias\b/, 'gh aliases'],
  [/\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|createCommitOnBranch|updateRefs?)\b/, 'a GraphQL mutation that merges or moves a branch'],
  [/\/pulls\/[^\s/'"]+\/merge\b|\/merges\b/, 'the merge API'],
  [/\/git\/(refs|commits|trees|tags)\b/, 'git objects or refs through the API'],
];

const WRITE_FLAGS = [
  /(?:^|[\s'"])(?:-X|--method)[\s=]*['"]?(?:PUT|POST|PATCH|DELETE)\b/i,
  /(?:^|[\s'"])-[fF]/,
  /(?:^|[\s'"])--(?:field|raw-field|input)\b/,
];

function mergeProblem(command) {
  for (const [pattern, reason] of MERGE_RULES) {
    if (pattern.test(command)) return reason;
  }
  if (/\/contents\//.test(command) && WRITE_FLAGS.some((flag) => flag.test(command))) {
    return 'writing files through the contents API';
  }
  return null;
}

// --- tokenizer ---

class Unparseable extends Error {}

// s[open] === '(': returns the index after the matching ')'.
function skipParens(s, open) {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === "'") i = skipSingle(s, i);
    else if (c === '"') i = skipDouble(s, i);
    else if (c === '`') i = skipBackticks(s, i);
    else {
      if (c === '(') depth += 1;
      else if (c === ')' && (depth -= 1) === 0) return i + 1;
      i += 1;
    }
  }
  throw new Unparseable('unbalanced parenthesis');
}

function skipSingle(s, open) {
  const close = s.indexOf("'", open + 1);
  if (close < 0) throw new Unparseable('unbalanced single quote');
  return close + 1;
}

function skipDouble(s, open) {
  let i = open + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    else if (c === '$' && s[i + 1] === '(') i = skipParens(s, i + 1);
    else if (c === '`') i = skipBackticks(s, i);
    else i += 1;
  }
  throw new Unparseable('unbalanced double quote');
}

function skipBackticks(s, open) {
  let i = open + 1;
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === '`') return i + 1;
    else i += 1;
  }
  throw new Unparseable('unbalanced backtick');
}

const REDIRECT_OP = /^(?:&>>|&>|<<<|<<-|<<|>>|>&|>\||<>|<&|>|<)/;

// Splits a command the way a POSIX shell would: into segments (separated by && || ; | & newline
// ( and )), each with its words and redirections. A word is { text, raw, expands, subst,
// start, end }: `text` has the quotes removed and any expansion left as written, `raw` is the
// source slice, and `expands` is true when the word contains a $ expansion or a backtick.
// Returns null for a command it can't tokenize (unbalanced quotes, a heredoc, and so on).
function tokenize(cmd) {
  try {
    return tokenizeUnchecked(cmd);
  } catch (err) {
    if (err instanceof Unparseable) return null;
    throw err;
  }
}

function tokenizeUnchecked(cmd) {
  const n = cmd.length;
  const segments = [];
  let seg = { words: [], redirs: [], subst: false, start: -1, end: -1 };
  let word = null;
  let pending = null; // a redirection operator still waiting for its target word
  let i = 0;

  const touch = (from, to) => {
    if (seg.start < 0) seg.start = from;
    seg.end = to;
  };
  const ensureWord = () => {
    word ??= { text: '', raw: '', expands: false, subst: false, start: i, end: i };
    return word;
  };
  const endWord = () => {
    if (!word) return;
    word.raw = cmd.slice(word.start, word.end);
    if (pending) {
      seg.redirs.push({ op: pending.op, target: word });
      touch(pending.start, word.end);
      pending = null;
    } else {
      seg.words.push(word);
      touch(word.start, word.end);
    }
    if (word.subst) seg.subst = true;
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (pending) throw new Unparseable('redirection without a target');
    if (seg.words.length || seg.redirs.length) segments.push(seg);
    seg = { words: [], redirs: [], subst: false, start: -1, end: -1 };
  };
  const take = (text, to, flags = {}) => {
    const w = ensureWord();
    w.text += text;
    w.end = to;
    if (flags.expands) w.expands = true;
    if (flags.subst) w.subst = w.expands = true;
  };
  // `$` at cmd[at]: a $(...) or ${...} is taken whole; a plain $NAME is taken one character
  // at a time (the name's characters come through as literals). Returns the next index.
  const takeDollar = (at) => {
    const next = cmd[at + 1];
    if (next === '(') {
      const end = skipParens(cmd, at + 1);
      take(cmd.slice(at, end), end, { subst: true });
      return end;
    }
    if (next === '{') {
      const close = cmd.indexOf('}', at + 2);
      if (close < 0) throw new Unparseable('unbalanced brace');
      take(cmd.slice(at, close + 1), close + 1, { expands: true });
      return close + 1;
    }
    take('$', at + 1, { expands: true });
    return at + 1;
  };
  const takeBackticks = (at) => {
    const end = skipBackticks(cmd, at);
    take(cmd.slice(at, end), end, { subst: true });
    return end;
  };
  const takeDouble = (at) => {
    const w = ensureWord();
    let k = at + 1;
    for (;;) {
      if (k >= n) throw new Unparseable('unbalanced double quote');
      const c = cmd[k];
      if (c === '"') {
        w.end = k + 1; // an empty "" adds no text, but still ends the word here
        return k + 1;
      }
      if (c === '\\') {
        const next = cmd[k + 1];
        if (next === undefined) throw new Unparseable('trailing backslash');
        if (next !== '\n') take('$`"\\'.includes(next) ? next : c + next, k + 2);
        k += 2;
      } else if (c === '$') k = takeDollar(k);
      else if (c === '`') k = takeBackticks(k);
      else {
        take(c, k + 1);
        k += 1;
      }
    }
  };

  while (i < n) {
    const c = cmd[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i += 1;
    } else if (c === '\n') {
      endSegment();
      i += 1;
    } else if (c === '\\') {
      if (i + 1 >= n) throw new Unparseable('trailing backslash');
      if (cmd[i + 1] !== '\n') {
        ensureWord();
        take(cmd[i + 1], i + 2);
      }
      i += 2;
    } else if (c === "'") {
      const end = skipSingle(cmd, i);
      ensureWord();
      take(cmd.slice(i + 1, end - 1), end);
      i = end;
    } else if (c === '"') {
      i = takeDouble(i);
    } else if (c === '`') {
      ensureWord();
      i = takeBackticks(i);
    } else if (c === '$') {
      ensureWord();
      i = takeDollar(i);
    } else if (c === '#' && !word) {
      while (i < n && cmd[i] !== '\n') i += 1;
    } else if (c === '<' || c === '>' || (c === '&' && cmd[i + 1] === '>')) {
      const op = REDIRECT_OP.exec(cmd.slice(i, i + 3))[0];
      if (op.startsWith('<<')) throw new Unparseable('heredoc');
      if (cmd[i + op.length] === '(') throw new Unparseable('process substitution');
      let start = i;
      if (word && !word.expands && /^\d+$/.test(word.text) && cmd.slice(word.start, word.end) === word.text) {
        start = word.start; // `2>&1`: the digits are the file descriptor, not an argument
        word = null;
      } else {
        endWord();
      }
      if (pending) throw new Unparseable('redirection without a target');
      pending = { op, start };
      i += op.length;
    } else if (';&|()'.includes(c)) {
      endSegment();
      i += (c === '&' || c === '|') && cmd[i + 1] === c ? 2 : 1;
    } else {
      ensureWord();
      take(c, i + 1);
      i += 1;
    }
  }
  endSegment();
  return segments;
}

// --- reading the segments ---

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

// A segment's leading VAR=value words, and the rest (the command and its arguments).
function split(seg) {
  let k = 0;
  while (k < seg.words.length && ASSIGNMENT.test(seg.words[k].raw)) k += 1;
  return { assigns: k, words: seg.words.slice(k) };
}

const isGit = (w) => w.text === 'git' || w.text.endsWith('/git');

function isPushSegment({ words }) {
  return words.length >= 2 && isGit(words[0]) && words.slice(1).some((w) => w.text === 'push');
}

const isClaudeBranch = (text) => (
  /^claude\/[A-Za-z0-9._/-]+$/.test(text) && !text.includes('..') && !text.endsWith('/') && !text.endsWith('.lock')
);
const BRANCH_FORMS = new Set(['$BRANCH', '"$BRANCH"', '${BRANCH}', '"${BRANCH}"']);

// 'literal' for a claude/ branch written out, 'var' for exactly $BRANCH, else null.
function refForm(word) {
  if (BRANCH_FORMS.has(word.raw)) return 'var';
  return !word.expands && isClaudeBranch(word.text) ? 'literal' : null;
}

function flagProblem(flag) {
  if (flag === '--force-if-includes' || flag.startsWith('--force') || /^-[A-Za-z]*f[A-Za-z]*$/.test(flag)) return 'force-push';
  if (flag === '-d' || flag === '--delete') return 'deleting a remote branch';
  if (['--mirror', '--all', '--tags', '--prune', '--follow-tags'].includes(flag)) return 'pushing more than the run branch';
  return 'a push flag other than -u or --set-upstream';
}

function refProblem(word) {
  if (word.text.startsWith('+')) return 'force-push (a leading + on the refspec)';
  return "a refspec that isn't a claude/ branch";
}

function redirectProblem(seg) {
  for (const { op, target } of seg.redirs) {
    const dup = (op === '>&' || op === '<&') && /^(\d+|-)$/.test(target.text);
    if (target.expands || !(dup || target.text === '/dev/null')) {
      return 'a redirection on a push to anywhere but /dev/null';
    }
  }
  return null;
}

// Checks one push segment against the one allowed shape:
//   git push [-u|--set-upstream] origin <claude/... | $BRANCH>
// Returns { reason } when it's denied, or { usesBranchVar } when it's allowed.
function inspectPush(seg, parts) {
  if (parts.assigns > 0) return { reason: 'environment assignments before git' };
  const [, sub, ...args] = parts.words;
  if (sub.text.startsWith('-')) return { reason: 'git options before push' };
  if (sub.text !== 'push') return { reason: 'a push through another git subcommand' };

  let rest = args;
  if (rest[0] && !rest[0].expands && (rest[0].text === '-u' || rest[0].text === '--set-upstream')) rest = rest.slice(1);
  const flag = rest.find((w) => w.text.startsWith('-'));
  if (flag) return { reason: flagProblem(flag.text) };
  if (rest.length === 0) return { reason: 'a push with no remote or branch named' };
  if (rest[0].expands || rest[0].text !== 'origin') return { reason: 'a remote other than origin' };
  if (rest.length === 1) return { reason: 'a push with no branch named' };
  if (rest.length > 2) return { reason: 'more than one refspec' };

  const form = refForm(rest[1]);
  if (!form) return { reason: refProblem(rest[1]) };
  const redirect = redirectProblem(seg);
  if (redirect) return { reason: redirect };
  return { usesBranchVar: form === 'var' };
}

// --- resolving $BRANCH ---

const SOURCE_WORDS = new Set(['.', 'source']);
const BRANCH_ASSIGNMENT = /^BRANCH(?:\[[^\]]*\])?\+?=/;
// Words that run the next word as a command (or start a compound command) and so hide a
// builtin that follows them, as in `{ read BRANCH; }`.
const COMMAND_PREFIXES = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time']);
const BUILTINS_THAT_SET_VARIABLES = new Set([
  'export', 'declare', 'typeset', 'local', 'readonly', 'read', 'eval', 'unset', 'mapfile', 'readarray',
  'set', 'alias', 'builtin', 'command', 'exec', 'trap', 'for', 'select', 'getopts',
]);

function commandWords(parts) {
  let k = 0;
  while (k < parts.words.length && COMMAND_PREFIXES.has(parts.words[k].text)) k += 1;
  return parts.words.slice(k);
}

function startsWithBuiltin(parts) {
  const [first, second] = commandWords(parts);
  if (!first) return false;
  return BUILTINS_THAT_SET_VARIABLES.has(first.text) || (first.text === 'printf' && /^-v/.test(second?.text ?? ''));
}

function isRunVarsFile(file, home) {
  const rel = path.relative(path.resolve(home, 'runs'), file).split(path.sep).join('/');
  return /^run-[A-Za-z0-9]+\/vars\.sh$/.test(rel);
}

function parseVarsValue(raw) {
  const single = /^'((?:[^']|'\\'')*)'$/.exec(raw);
  if (single) return single[1].replaceAll("'\\''", "'");
  const double = /^"([^$`\\"]*)"$/.exec(raw);
  if (double) return double[1];
  return /^[A-Za-z0-9._/:@+-]*$/.test(raw) ? raw : null;
}

// Every non-empty line must be `set -u` or NAME=value in one of the forms the skill writes;
// returns the last BRANCH value, or an { error }.
function lastBranch(body) {
  let branch = null;
  for (const line of body.split('\n')) {
    if (line.trim() === '' || line === 'set -u') continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    const value = m ? parseVarsValue(m[2]) : null;
    if (value === null) return { error: "a vars.sh line the guard doesn't recognise" };
    if (m[1] === 'BRANCH') branch = value;
  }
  if (branch === null) return { error: 'a vars.sh with no BRANCH line' };
  return { branch };
}

function branchProblem(segments, home, readFile) {
  const parts = segments.map(split);
  const sources = parts.filter((p) => p.words.length > 0 && SOURCE_WORDS.has(p.words[0].text));
  if (sources.length === 0) return "$BRANCH used without sourcing the run's vars.sh";
  if (sources.length > 1) return 'more than one source command';
  const { words } = sources[0];
  if (words.length !== 2) return 'a source command with extra arguments';
  const pathWord = words[1];
  if (pathWord.expands) return 'a vars.sh path that uses an expansion';
  if (!path.isAbsolute(pathWord.text)) return 'a vars.sh path that is not absolute';
  const file = path.resolve(pathWord.text);
  if (!isRunVarsFile(file, home)) return "a vars.sh that isn't in the run folder under the pipeline home";

  const all = segments.flatMap((s) => [...s.words, ...s.redirs.map((r) => r.target)]);
  if (all.some((w) => BRANCH_ASSIGNMENT.test(w.text))) return 'an assignment to BRANCH';
  if (parts.some(startsWithBuiltin)) return 'a shell builtin that can change BRANCH';
  if (segments.some((s) => s.subst)) return 'a command substitution alongside a push of $BRANCH';
  if (all.some((w) => w !== pathWord && w.text.includes('vars.sh'))) return 'another reference to vars.sh';

  let body;
  try {
    body = readFile(file);
  } catch {
    return "a vars.sh the guard couldn't read";
  }
  const vars = lastBranch(body);
  if (vars.error) return vars.error;
  if (!isClaudeBranch(vars.branch)) return "a vars.sh whose BRANCH isn't a claude/ branch";
  return null;
}

// --- the check ---

function removeSpans(text, spans) {
  let out = '';
  let pos = 0;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    out += `${text.slice(pos, start)} `;
    pos = end;
  }
  return out + text.slice(pos);
}

const mentionsPush = (text) => /\bgit\b/.test(text) && /\bpush\b/.test(text);

const defaultReadFile = (file) => readFileSync(file, 'utf8');

export function checkCommand(command, { home, readFile = defaultReadFile } = {}) {
  const merge = mergeProblem(command);
  if (merge) return deny(merge);

  const segments = tokenize(command);
  if (!segments) return mentionsPush(command) ? deny('a command too complex to check') : ALLOW;

  const allowedSpans = [];
  let usesBranchVar = false;
  for (const seg of segments) {
    const parts = split(seg);
    if (!isPushSegment(parts)) continue;
    const result = inspectPush(seg, parts);
    if (result.reason) return deny(result.reason);
    usesBranchVar ||= result.usesBranchVar;
    allowedSpans.push([seg.start, seg.end]);
  }
  if (usesBranchVar) {
    const problem = branchProblem(segments, home, readFile);
    if (problem) return deny(problem);
  }

  if (mentionsPush(removeSpans(command, allowedSpans))) {
    return deny("a push the guard can't check (inside a string, script, alias or subshell)");
  }
  return ALLOW;
}
