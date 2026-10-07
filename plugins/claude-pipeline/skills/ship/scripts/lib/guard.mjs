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

// A denial is one of two kinds. 'reshape': the push is fine and only what surrounds it is wrong,
// so the agent can split the command and carry on. 'forbidden': anything else (a bad push, a
// merge, a remote or config change, a command it can't read, anything that could change what
// is pushed), so the agent should stop.
const ALLOW = { allow: true };
const deny = (reason, kind = 'forbidden') => ({ allow: false, reason, kind });

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
  // Nothing in the pipeline approves or requests changes (an App approval may count toward required reviews).
  [/\bpr\s+review\b/, 'reviewing (approving or requesting changes on) a pull request'],
  [/\/pulls\/[^/\s'"]+\/reviews\b/, 'the pull request reviews API'],
];
const GRAPHQL_MERGE = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|createCommitOnBranch|updateRefs?)\b/;
const GRAPHQL_REVIEW = /\b(addPullRequestReview|submitPullRequestReview|approvePullRequest)\b/;

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
  if (/graphql/i.test(command) && GRAPHQL_REVIEW.test(command)) {
    return 'a GraphQL mutation that reviews (approves or requests changes on) a pull request';
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
// A word the guard can't read (an expansion or a glob). As a first word followed by a push word
// it is treated as a push it can't vouch for; as the subcommand of git or gh it is denied.
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
// Returns { reason } when it's denied, or { usesBranchVar } when it's allowed. A redirection on
// the push itself is the one problem that is only about shape: it returns { reason, reshape,
// usesBranchVar } so the caller can still look at the rest of the command.
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
  if (redirect) return { reason: redirect, reshape: true, usesBranchVar: form === 'var' };
  return { usesBranchVar: form === 'var' };
}

// --- merges by another spelling, remotes and push-related config ---

// `gh pr merge` or `gh pr review` with the words split up or quoted: gh, then pr, then merge or review.
function ghMergeProblem(segments) {
  for (const seg of segments) {
    const { words } = split(seg);
    if (words.length < 3 || !isGh(words[0])) continue;
    const texts = words.slice(1).map((w) => w.text.toLowerCase());
    const pr = texts.indexOf('pr');
    if (pr >= 0 && texts.indexOf('merge', pr + 1) > pr) return 'merging a pull request';
    if (pr >= 0 && texts.indexOf('review', pr + 1) > pr) return 'reviewing (approving or requesting changes on) a pull request';
  }
  return null;
}

// A git or gh subcommand the guard can't read (`g=push; git $g origin main`) is forbidden: the
// guard can't tell what it runs. git's subcommand is the first word that isn't an option or an
// option's value; gh's is words[1], and for `gh pr` the first word after its flags (skipping
// -R/--repo and their values). A dynamic first word followed by a dynamic second word is the
// same thing (`$g $p origin main`).
const HIDDEN_SUBCOMMAND = 'a git or gh subcommand hidden in a variable or glob';
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function skipFlags(words, from, withValue) {
  let i = from;
  while (i < words.length && words[i].text.startsWith('-')) i += withValue.has(words[i].text) ? 2 : 1;
  return i;
}

function hiddenSubcommandProblem(segments) {
  for (const seg of segments) {
    const { words } = split(seg);
    if (words.length < 2) continue;
    const [first, second] = words;
    const git = isGit(first);
    const gh = isGh(first);
    const dynamic = isDynamic(first);
    if (!git && !gh && !dynamic) continue;
    const gitSubcommand = words[git ? skipFlags(words, 1, GIT_OPTIONS_WITH_VALUE) : 1];
    if ((git || dynamic) && gitSubcommand && isDynamic(gitSubcommand)) return HIDDEN_SUBCOMMAND;
    if (!gh && !dynamic) continue;
    if (isDynamic(second)) return HIDDEN_SUBCOMMAND;
    if (second.text.toLowerCase() === 'pr') {
      const target = words[skipFlags(words, 2, new Set(['-R', '--repo']))];
      if (target && isDynamic(target)) return HIDDEN_SUBCOMMAND;
    }
  }
  return null;
}

// eval builds commands from strings at run time, so nothing the guard reads is what runs. The
// pipeline never uses it. The command word is the first word after assignments, compound-command
// words and command/builtin.
const COMMAND_PREFIXES = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time', 'command', 'builtin']);

function evalProblem(segments) {
  for (const seg of segments) {
    const { words } = split(seg);
    const word = words.find((w) => !COMMAND_PREFIXES.has(w.text));
    if (word && word.text === 'eval') return 'eval';
  }
  return null;
}

const REMOTE_WRITES = new Set(['add', 'set-url', 'rename', 'remove', 'rm', 'set-branches']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']);
const PUSH_CONFIG_KEY = /^(?:(?:remote|url|push|branch|alias|include|includeif|credential|http|protocol|uploadpack|receivepack)\.|core\.(?:hookspath|sshcommand|gitproxy|askpass)$)/i;

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

// The same two rules on raw text, for a command that can't be tokenized (a heredoc, say).
const RAW_REMOTE_WRITE = /\bgit\s+remote\s+(add|set-url|rename|remove|rm|set-branches)\b/i;
const RAW_CONFIG_WRITE = /\bgit\s+config\b[^\n]*\b((remote|url|push|branch|alias|include|includeif|credential|http)\.|core\.(hookspath|sshcommand)\b)/i;

function rawSettingsProblem(text) {
  if (RAW_REMOTE_WRITE.test(text)) return 'changing git remotes';
  if (RAW_CONFIG_WRITE.test(text)) return 'changing git config that controls pushes';
  return null;
}

// --- command-line config, environment redirection, push plumbing, gh repo rewrites (rounds 4-5) ---

// git config given on git's own command line (before the subcommand) can redefine an alias,
// pull in a whole config file, point a remote/proxy/hook elsewhere, or run a program (a pager,
// an editor, fsmonitor, a textconv), so a benign-looking literal subcommand then pushes. git's
// own options come before the subcommand. A -c/--config-env key (dequoted, case-insensitive) is
// allowed only from a short list of display and identity settings; any other key, or a key the
// guard can't read (an expansion or glob), is denied. Keying on the key, not the value, also
// closes the forms whose value is quote-split or comes from an env var (`-c alias.x=$V`).
// PUSH_CONFIG_KEY stays for the `git config` subcommand rule.
const CONFIG_CLI_REASON = 'git config on the command line';
const CONFIG_CLI_ALLOWED = /^(?:core\.quotepath|color\..+|user\.name|user\.email|advice\..+|init\.defaultbranch)$/i;

function configKeyProblem(keyText) {
  const key = keyText.split('=')[0];
  if (/[$`*?[]/.test(key) || !CONFIG_CLI_ALLOWED.test(key)) return CONFIG_CLI_REASON;
  return null;
}

function commandLineConfigProblem(segments) {
  for (const seg of segments) {
    const { words } = split(seg);
    if (words.length < 1 || !isGit(words[0])) continue;
    let i = 1;
    while (i < words.length && words[i].text.startsWith('-')) {
      const t = words[i].text;
      if (t === '-c' || t === '--config-env') {
        const arg = words[i + 1];
        if (!arg) break;
        const problem = configKeyProblem(arg.text);
        if (problem) return problem;
        i += 2;
      } else if (t.startsWith('--config-env=')) {
        const problem = configKeyProblem(t.slice('--config-env='.length));
        if (problem) return problem;
        i += 1;
      } else if (t.startsWith('-c') && !t.startsWith('--')) {
        const problem = configKeyProblem(t.slice(2));
        if (problem) return problem;
        i += 1;
      } else if (GIT_OPTIONS_WITH_VALUE.has(t)) {
        i += 2; // a git option that consumes the next word (-C <path>, --git-dir <path>, ...)
      } else {
        i += 1;
      }
    }
  }
  return null;
}

// The environment can point git or gh somewhere else: GIT_* (GIT_DIR, the GIT_CONFIG_* family),
// GH_* (GH_CONFIG_DIR, GH_REPO), HOME and XDG_CONFIG_* (which config file is read, and so which
// aliases exist), PATH (which git runs), and the askpass/agent variables. The pipeline sets none
// of them. Two rules, both forbidden:
//   - any leading VAR=value on a git or gh segment, whatever the name (`HOME=/tmp/h git sy`);
//   - any word, anywhere, whose dequoted text assigns one of those variables, so export,
//     declare -x, env and standalone assignment segments are caught too.
const REDIRECT_ENV_ASSIGN = /^(?:GIT_[A-Z0-9_]*|GH_[A-Z0-9_]*|HOME|XDG_CONFIG_HOME|XDG_CONFIG_DIRS|PATH|SSH_ASKPASS|GIT_ASKPASS|SSH_AUTH_SOCK)=/;

function gitEnvProblem(segments) {
  for (const seg of segments) {
    const { assigns, words } = split(seg);
    if (assigns > 0 && words.length > 0 && (isGit(words[0]) || isGh(words[0]))) {
      return 'environment assignments before git or gh';
    }
    for (const w of seg.words) {
      if (REDIRECT_ENV_ASSIGN.test(w.text)) return 'setting environment variables that redirect git or gh';
    }
  }
  return null;
}

// git plumbing that speaks a push protocol directly (send-pack, http-push, the remote-* helpers),
// whether as a git subcommand (`git send-pack`, `git remote-ext`) or as a git-<helper> command.
const PLUMBING_SUB = /^(?:send-pack|http-push|remote-.+)$/i;
const PLUMBING_FIRST = /^(?:[^*?[]*\/)?git-(?:send-pack|http-push|remote-.+)$/i;

function pushPlumbingProblem(segments) {
  for (const seg of segments) {
    const { words } = split(seg);
    if (words.length < 1) continue;
    const first = words[0];
    if (!first.expands && PLUMBING_FIRST.test(first.text)) return 'git plumbing that pushes';
    if (isGit(first)) {
      const sub = words[skipFlags(words, 1, GIT_OPTIONS_WITH_VALUE)];
      if (sub && !sub.expands && PLUMBING_SUB.test(sub.text)) return 'git plumbing that pushes';
    }
  }
  return null;
}

// gh repo subcommands that move a repo's default branch or change its settings. The repo action
// is the first non-flag word after `repo` (found the way round 3 finds a subcommand).
const GH_REPO_WRITES = new Set(['sync', 'edit', 'delete', 'rename', 'archive']);

function ghRepoProblem(segments) {
  for (const seg of segments) {
    const { words } = split(seg);
    if (words.length < 3 || !isGh(words[0])) continue;
    if (words[1].expands || words[1].text.toLowerCase() !== 'repo') continue;
    const action = words.slice(2).find((w) => !w.text.startsWith('-'));
    if (action && !action.expands && GH_REPO_WRITES.has(action.text.toLowerCase())) {
      return 'gh repo commands that change branches or settings';
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

// What a segment of a pushing command is: 'source' (exactly `. <path>`), 'cd', 'git' (add,
// commit or status), 'push', or 'pipe' (a tail or head right after a push), else null.
function segmentKind(parts, joiner, previous) {
  const { words } = parts;
  if (joiner === '|') return previous === 'push' && isTailOrHead(parts) ? 'pipe' : null;
  if (words.length === 0) return null;
  if (isPushSegment(parts)) return 'push';
  if (SOURCE_WORDS.has(words[0].text) && words.length === 2) return 'source';
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
//
// Returns null, or { reason, kind }. The kind says whether the agent can just split the command:
//   'forbidden' when anything that runs before the last push is wrong (a segment outside the
//     whitelist, a redirection, a substitution or an assignment), because that could have
//     written the vars.sh the guard is about to trust (a glob or cp before the source) or
//     otherwise changed the push. Also when a vars.sh path or its BRANCH line is bad, and for
//     git commit --no-verify. This is stricter than it has to be for a harmless cp between the
//     source and the push, and that is on purpose: the stage text, not this, keeps the model
//     from writing that chain.
//   'reshape' when the only problems are after the last push (more segments, a substitution, a
//     redirection), or are about the joins and the source: a separator other than && (and the
//     one |), or a source that is missing or not first while everything before the push is
//     allowed. The source path is still checked, so a missing source is a shape problem only
//     because there is no vars.sh to distrust.
function whitelistProblem({ segments, seps }, home, readFile, usesBranchVar) {
  const parts = segments.map(split);
  const lastPush = parts.findLastIndex(isPushSegment);
  const forbidden = (reason) => ({ reason, kind: 'forbidden' });
  let shape = null; // the first problem that is only about the command's shape
  if (seps.length !== segments.length - 1) shape ??= AROUND;

  const kinds = [];
  const sources = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const p = parts[i];
    const joiner = i === 0 ? null : seps[i - 1];
    if (joiner !== null && joiner !== '&&' && joiner !== '|') shape ??= AROUND;
    const kind = segmentKind(p, joiner, kinds[i - 1]);
    kinds.push(kind);
    const wrong = seg.subst || p.assigns > 0 || kind === null || (kind !== 'push' && redirectProblem(seg));
    if (wrong) {
      if (i < lastPush) return forbidden(AROUND);
      shape ??= AROUND;
    }
    if (kind === 'source') {
      sources.push(p.words[1]);
      if (i !== 0) shape ??= AROUND;
    }
    if (kind === 'git' && p.words[1].text === 'commit') {
      const problem = commitProblem(p.words.slice(2));
      if (problem) return forbidden(problem);
    }
  }

  for (const word of sources) {
    const problem = sourceProblem(word, home);
    if (problem) return forbidden(problem);
  }
  if (usesBranchVar) {
    if (sources.length === 0) shape ??= "$BRANCH used without sourcing the run's vars.sh";
    for (const word of sources) {
      let body;
      try {
        body = readFile(path.resolve(word.text));
      } catch {
        return forbidden("a vars.sh the guard couldn't read");
      }
      const vars = lastBranch(body);
      if (vars.error) return forbidden(vars.error);
      if (!isClaudeBranch(vars.branch)) return forbidden("a vars.sh whose BRANCH isn't a claude/ branch");
    }
  }
  return shape ? { reason: shape, kind: 'reshape' } : null;
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
// An = before the word counts (g=push), so a variable can't hold the word unseen.
const STANDALONE_PUSH = /(?<=^|[\s'"`({;&|=])push(?=$|[\s'"`)};&|])/i;
const STANDALONE_GIT = /(?<=^|[\s'"`({;&|/=])git(?=$|[\s'"`)};&|])/i;
const mentionsPush = (text) => STANDALONE_GIT.test(text) && STANDALONE_PUSH.test(text);

const defaultReadFile = (file) => readFileSync(file, 'utf8');

export function checkCommand(command, { home, readFile = defaultReadFile } = {}) {
  const merge = mergeProblem(command);
  if (merge) return deny(merge);

  const text = command.trim();
  const tokens = tokenize(text);
  if (!tokens) {
    if (mentionsPush(text)) return deny('a command too complex to check');
    const settings = rawSettingsProblem(text);
    return settings ? deny(settings) : ALLOW;
  }

  const other = ghMergeProblem(tokens.segments) ?? gitSettingsProblem(tokens.segments)
    ?? hiddenSubcommandProblem(tokens.segments) ?? evalProblem(tokens.segments)
    ?? commandLineConfigProblem(tokens.segments) ?? gitEnvProblem(tokens.segments)
    ?? pushPlumbingProblem(tokens.segments) ?? ghRepoProblem(tokens.segments);
  if (other) return deny(other);

  // Forbidden problems return at once. A reshape problem is kept while the rest is checked,
  // because a forbidden one anywhere in the command wins.
  let shape = null;
  const allowedSpans = [];
  let usesBranchVar = false;
  for (const seg of tokens.segments) {
    const parts = split(seg);
    if (!isPushSegment(parts)) continue;
    const result = inspectPush(seg, parts);
    if (result.reason && !result.reshape) return deny(result.reason);
    shape ??= result.reason ?? null;
    usesBranchVar ||= result.usesBranchVar;
    allowedSpans.push([seg.start, seg.end]);
  }
  if (allowedSpans.length > 0) {
    const problem = whitelistProblem(tokens, home, readFile, usesBranchVar);
    if (problem?.kind === 'forbidden') return deny(problem.reason);
    shape ??= problem?.reason ?? null;
  }

  // The standalone git/push check runs over the raw text (so src/push.ts and push-docs pass),
  // and over the dequoted text of every word outside the allowed pushes, so a push word split by
  // quotes or escapes (pu"sh", pu''sh, 'git' pu\sh) reassembles and is caught.
  const dequotedRemainder = tokens.segments
    .filter((seg) => !isPushSegment(split(seg)))
    .flatMap((seg) => seg.words.map((w) => w.text))
    .join(' ');
  if (mentionsPush(removeSpans(text, allowedSpans)) || mentionsPush(dequotedRemainder)) {
    return deny("a push the guard can't check (inside a string, script, alias or subshell)");
  }
  return shape ? deny(shape, 'reshape') : ALLOW;
}
