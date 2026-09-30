import { readFileSync } from 'node:fs';
import path from 'node:path';

// The run guard's logic. hooks/guard.mjs is the thin I/O wrapper around it.
//
// A seatbelt, not a security boundary: it reads a Bash command as text and refuses the
// shapes that push somewhere other than the run's claude/* branch, or that merge. A command
// that pushes may contain nothing but the vars.sh source, cd, git add, git commit, git status
// and a tail/head of the push's output, so nothing in it can change what is pushed. A script
// written to a file and then run gets past it, and so does a .git/config or hook edited by a
// file write in an earlier call. The boundaries are a token scoped to the repo and branch
// protection.

const ALLOW = { allow: true };
const deny = (reason) => ({ allow: false, reason });

// --- activation ---

// A run switches the guard on for its session at Setup: the command that creates the run
// folder names Setup's mktemp template, and every later pipeline command sources that
// folder's vars.sh. Merely mentioning the pipeline home (ls, grep) doesn't count.
export function isActivating(command) {
  return command.includes('/runs/run-XXXXXX') || /\/runs\/run-[A-Za-z0-9]+\/vars\.sh/.test(command);
}

// --- merges and ref writes (raw text, including text inside quotes) ---

// The API rules match endpoint paths (repos/<owner>/<repo>/…) and the GraphQL rule matches only
// a command that mentions graphql, so file names like docs/git/refs.md don't trip them.
const MERGE_RULES = [
  [/\bpr\s+merge\b/, 'merging a pull request'],
  [/\bgh\s+alias\b/, 'gh aliases'],
  [/repos\/[^\s'"]+\/(pulls\/[^\s/'"]+\/merge|merges)\b/, 'the merge API'],
  [/repos\/[^\s'"]+\/git\/(refs|commits|trees|tags)\b/, 'git objects or refs through the API'],
];
const GRAPHQL_MERGE = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|createCommitOnBranch|updateRefs?)\b/;

const WRITE_FLAGS = [
  /(?:^|[\s'"])(?:-X|--method)[\s=]*['"]?(?:PUT|POST|PATCH|DELETE)\b/i,
  /(?:^|[\s'"])-[fF]/,
  /(?:^|[\s'"])--(?:field|raw-field|input)\b/,
];

function mergeProblem(command) {
  for (const [pattern, reason] of MERGE_RULES) {
    if (pattern.test(command)) return reason;
  }
  if (/graphql/i.test(command) && GRAPHQL_MERGE.test(command)) {
    return 'a GraphQL mutation that merges or moves a branch';
  }
  if (/repos\/[^\s'"]+\/contents\//.test(command) && WRITE_FLAGS.some((flag) => flag.test(command))) {
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
// source slice, `expands` is true when the word contains a $ expansion or a backtick, and
// `subst` when it contains a command substitution (also inside ${...}). `seps` lists every
// separator in order, empty segments included, so a whitelist can see exactly what joined the
// segments. Returns null for a command it can't tokenize (unbalanced quotes, a heredoc, and so
// on).
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
  const seps = [];
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
      const slice = cmd.slice(at, close + 1);
      take(slice, close + 1, { expands: true, subst: /\$\(|`/.test(slice) });
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
      seps.push('\n');
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
      const width = (c === '&' || c === '|') && cmd[i + 1] === c ? 2 : 1;
      seps.push(cmd.slice(i, i + width));
      i += width;
    } else {
      ensureWord();
      take(c, i + 1);
      i += 1;
    }
  }
  endSegment();
  return { segments, seps };
}

// --- reading the segments ---

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

// A segment's leading VAR=value words, and the rest (the command and its arguments).
function split(seg) {
  let k = 0;
  while (k < seg.words.length && ASSIGNMENT.test(seg.words[k].raw)) k += 1;
  return { assigns: k, words: seg.words.slice(k) };
}

// A literal path ending in git or gh. Case-insensitive, because a case-insensitive file system
// runs `GIT` and `/usr/bin/Git` as git.
const isGit = (w) => !w.expands && /^(?:[^*?[]*\/)?git$/i.test(w.text);
const isGh = (w) => !w.expands && /^(?:[^*?[]*\/)?gh$/i.test(w.text);
// A first word the guard can't read (an expansion or a glob): if a push word follows, it is
// treated as a push it can't vouch for.
const isDynamic = (w) => w.expands || /[*?[]/.test(w.text);

function isPushSegment({ words }) {
  return words.length >= 2 && (isGit(words[0]) || isDynamic(words[0])) && words.slice(1).some((w) => w.text === 'push');
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

// Redirections are allowed only to /dev/null or as a file-descriptor duplication (2>&1, >&2).
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
  if (!isGit(parts.words[0])) return { reason: "a command the guard can't identify as git, followed by push" };
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

// --- merges by another spelling, remotes and push-related config ---

// `gh pr merge` with the words split up or quoted: gh, then pr, then merge.
function ghMergeProblem(segments) {
  for (const seg of segments) {
    const { words } = split(seg);
    if (words.length < 3 || !isGh(words[0])) continue;
    const texts = words.slice(1).map((w) => w.text.toLowerCase());
    const pr = texts.indexOf('pr');
    if (pr >= 0 && texts.indexOf('merge', pr + 1) > pr) return 'merging a pull request';
  }
  return null;
}

const REMOTE_WRITES = new Set(['add', 'set-url', 'rename', 'remove', 'rm', 'set-branches']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']);
const PUSH_CONFIG_KEY = /^(?:(?:remote|url|push|branch|alias|include|includeif|credential|http)\.|core\.(?:hookspath|sshcommand)$)/i;

function gitSettingsProblem(segments) {
  for (const seg of segments) {
    const { words } = split(seg);
    if (words.length < 2 || !isGit(words[0])) continue;
    const args = words.slice(1).map((w) => w.text);
    const remote = args.indexOf('remote');
    if (remote >= 0 && args.slice(remote + 1).some((a) => REMOTE_WRITES.has(a))) return 'changing git remotes';
    const config = args.indexOf('config');
    if (config < 0) continue;
    const after = args.slice(config + 1);
    if (!after.some((a) => CONFIG_READS.has(a)) && after.some((a) => !a.startsWith('-') && PUSH_CONFIG_KEY.test(a))) {
      return 'changing git config that controls pushes';
    }
  }
  return null;
}

// --- the whitelist for a command that pushes ---

const AROUND = 'a push must run with only the vars.sh source, cd, git add, git commit and git status around it';
const SOURCE_WORDS = new Set(['.', 'source']);
const GIT_AROUND = new Set(['add', 'commit', 'status']);
const PIPE_ARG = /^(?:-{1,2}[A-Za-z0-9][A-Za-z0-9=-]*|\+?\d+)$/;
// Short git commit options that take the rest of the word as their value, as in -mnote.
const COMMIT_VALUE_FLAGS = new Set(['m', 'F', 'C', 'c', 't', 'S', 'u']);

const isTailOrHead = ({ words }) => (
  words.length >= 1 && !words[0].expands && ['tail', 'head'].includes(words[0].text)
  && words.slice(1).every((w) => !w.expands && PIPE_ARG.test(w.text))
);

// git commit without its hooks: --no-verify (or an abbreviation of it) and -n, alone or in a cluster.
function commitProblem(args) {
  for (const { text } of args) {
    if (text.startsWith('--no-v') && '--no-verify'.startsWith(text)) return 'git commit without its hooks';
    if (!/^-[A-Za-z]+$/.test(text)) continue;
    for (const ch of text.slice(1)) {
      if (ch === 'n') return 'git commit without its hooks';
      if (COMMIT_VALUE_FLAGS.has(ch)) break;
    }
  }
  return null;
}

// What a segment of a pushing command is: 'source' (first segment only), 'cd', 'git' (add,
// commit or status), 'push', or 'pipe' (a tail or head right after a push), else null.
function segmentKind(parts, index, joiner, previous) {
  const { words } = parts;
  if (joiner === '|') return previous === 'push' && isTailOrHead(parts) ? 'pipe' : null;
  if (words.length === 0) return null;
  if (isPushSegment(parts)) return 'push';
  if (index === 0 && SOURCE_WORDS.has(words[0].text) && words.length === 2) return 'source';
  if (words[0].text === 'cd' && words.length === 2) return 'cd';
  if (isGit(words[0]) && words.length >= 2 && !words[1].expands && GIT_AROUND.has(words[1].text)) return 'git';
  return null;
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

function sourceProblem(pathWord, home) {
  if (pathWord.expands) return 'a vars.sh path that uses an expansion';
  if (!path.isAbsolute(pathWord.text)) return 'a vars.sh path that is not absolute';
  if (!isRunVarsFile(path.resolve(pathWord.text), home)) return "a vars.sh that isn't in the run folder under the pipeline home";
  return null;
}

// A command with a push in it may contain only: a vars.sh source as its first segment, cd,
// git add, git commit (not --no-verify), git status, the push itself, and a tail or head of the
// push's output; joined by && (and that one |); with no substitution, no assignment and no
// redirection except to /dev/null or a descriptor duplication. So nothing in it can change
// what the push does, and the vars.sh the guard reads is the one the shell sources. When the
// push uses $BRANCH, that vars.sh must be sourced and end with a claude/ branch.
function whitelistProblem({ segments, seps }, home, readFile, usesBranchVar) {
  if (seps.length !== segments.length - 1) return AROUND;
  const kinds = [];
  let sourceWord = null;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const parts = split(seg);
    const joiner = i === 0 ? null : seps[i - 1];
    if (joiner !== null && joiner !== '&&' && joiner !== '|') return AROUND;
    if (seg.subst || parts.assigns > 0 || redirectProblem(seg)) return AROUND;
    const kind = segmentKind(parts, i, joiner, kinds[i - 1]);
    if (!kind) return AROUND;
    if (kind === 'source') sourceWord = parts.words[1];
    if (kind === 'git' && parts.words[1].text === 'commit') {
      const problem = commitProblem(parts.words.slice(2));
      if (problem) return problem;
    }
    kinds.push(kind);
  }

  if (sourceWord) {
    const problem = sourceProblem(sourceWord, home);
    if (problem) return problem;
  }
  if (!usesBranchVar) return null;
  if (!sourceWord) return "$BRANCH used without sourcing the run's vars.sh";

  let body;
  try {
    body = readFile(path.resolve(sourceWord.text));
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

// Standalone shell words: `git` and `push` count only when set off by whitespace, a quote, a
// bracket or a separator, so src/push.ts, push-docs and lib/git/refs.js don't.
const STANDALONE_PUSH = /(?<=^|[\s'"`({;&|])push(?=$|[\s'"`)};&|])/i;
const STANDALONE_GIT = /(?<=^|[\s'"`({;&|/])git(?=$|[\s'"`)};&|])/i;
const mentionsPush = (text) => STANDALONE_GIT.test(text) && STANDALONE_PUSH.test(text);

const defaultReadFile = (file) => readFileSync(file, 'utf8');

export function checkCommand(command, { home, readFile = defaultReadFile } = {}) {
  const merge = mergeProblem(command);
  if (merge) return deny(merge);

  const text = command.trim();
  const tokens = tokenize(text);
  if (!tokens) return mentionsPush(text) ? deny('a command too complex to check') : ALLOW;

  const other = ghMergeProblem(tokens.segments) ?? gitSettingsProblem(tokens.segments);
  if (other) return deny(other);

  const allowedSpans = [];
  let usesBranchVar = false;
  for (const seg of tokens.segments) {
    const parts = split(seg);
    if (!isPushSegment(parts)) continue;
    const result = inspectPush(seg, parts);
    if (result.reason) return deny(result.reason);
    usesBranchVar ||= result.usesBranchVar;
    allowedSpans.push([seg.start, seg.end]);
  }
  if (allowedSpans.length > 0) {
    const problem = whitelistProblem(tokens, home, readFile, usesBranchVar);
    if (problem) return deny(problem);
  }

  if (mentionsPush(removeSpans(text, allowedSpans))) {
    return deny("a push the guard can't check (inside a string, script, alias or subshell)");
  }
  return ALLOW;
}
