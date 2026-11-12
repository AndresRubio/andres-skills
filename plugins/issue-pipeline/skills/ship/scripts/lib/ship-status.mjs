import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RELEASING_KINDS } from './runs.mjs';

// Setup is the first thing a ship session does, and it creates <home>/runs/run-XXXXXX. A session
// that ends without one never started the pipeline: it was refused its tools, could not log in,
// or never loaded the skill. Such a session can still end as a success, so the workflow asks here.
export function sessionStarted(home) {
  const runs = path.join(home, 'runs');
  if (!existsSync(runs)) return false;
  return readdirSync(runs, { withFileTypes: true }).some((entry) => entry.isDirectory() && entry.name.startsWith('run-'));
}

// What the session's own log says about how it ended. claude-code-action hides the session and
// writes it, as the array of SDK messages, to $RUNNER_TEMP/claude-execution-output.json. Only tool
// names are read from it, never text, input or output: the last calls the main session made (a
// subagent's calls carry parent_tool_use_id) and the tools it was refused. A name that is not a
// plain tool name is dropped, so nothing in the log can shape the comment. null when there is no
// readable log.
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const LAST_CALLS = 6;
export function sessionTrace(file) {
  if (!file || !existsSync(file)) return null;
  let messages;
  try {
    messages = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(messages)) return null;
  const plain = (names) => names.filter((n) => typeof n === 'string' && TOOL_NAME.test(n));
  const called = messages
    .filter((m) => m?.type === 'assistant' && !m.parent_tool_use_id && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content.filter((c) => c?.type === 'tool_use').map((c) => c.name));
  const refused = messages
    .filter((m) => m?.type === 'result' && Array.isArray(m.permission_denials))
    .flatMap((m) => m.permission_denials.map((d) => d?.tool_name));
  return { lastTools: plain(called).slice(-LAST_CALLS), denied: [...new Set(plain(refused))] };
}

// The trace as lines of a comment: empty when there is nothing to say.
function traceLines(trace) {
  if (!trace || (trace.lastTools.length === 0 && trace.denied.length === 0)) return [];
  const names = (list) => list.map((n) => `\`${n}\``).join(', ');
  const parts = [];
  if (trace.lastTools.length) parts.push(`its last tool calls were ${names(trace.lastTools)}`);
  if (trace.denied.length) parts.push(`it was refused ${names(trace.denied)}`);
  return ['', `From the session's log, tool names only: ${parts.join(', and ')}.`];
}

// The comment that parks an issue whose run never started. `run` is the marker's run: the Actions
// run URL, or 'local' outside Actions. `edits` are the label edits that go with it (notStartedEdits):
// when they take pipeline-go away the owner is told, because a reply does not bring the label back.
export function notStartedBody(marker, run, edits = [], trace = null) {
  const log = run.startsWith('http') ? ` The log is at ${run}.` : '';
  const goRemoved = edits.some(([flag, label]) => flag === '--remove-label' && label === 'pipeline-go');
  return [
    marker,
    '',
    `The run did not start: the session ended before the pipeline's Setup, so no stage ran and nothing was changed.${log}`,
    ...traceLines(trace),
    '',
    'Reply here once the cause is fixed to start a new run.',
    ...(goRemoved ? ['', '`pipeline-go` was removed: an earlier run\'s lock is still on this issue, and with both labels on the sweep would have started it again without you. Add the label back if the next run should have it.'] : []),
  ].join('\n');
}

// The label edits that park an issue whose session never started. The session used no approval, so
// pipeline-go stays, with one exception: an earlier run's lock still on the issue. The sweep starts
// a stale lock again, and pipeline-go lets an issue through needs-decision (eligibility.mjs), so
// with both left on every sweep would start the issue and every failed start would post a comment.
// The lock is not this session's to remove, so the approval goes.
export function notStartedEdits(labels) {
  const edits = [['--add-label', 'needs-decision']];
  if (labels.includes('pipeline-working') && labels.includes('pipeline-go')) edits.push(['--remove-label', 'pipeline-go']);
  return edits;
}

const sameOrAfter = (iso, since) => !since || new Date(iso).getTime() >= new Date(since).getTime();

// The pipeline comments this attempt posted. Every attempt of an Actions run carries the same run
// link in its markers, so an attempt is told apart by when it began.
export function attemptComments(run, comments, since) {
  return comments.filter((c) => c.pipeline && c.marker.run === run && sameOrAfter(c.createdAt, since));
}

// How this attempt left the issue's lock when the job was over.
//   { left: 'free' }            it does not hold it: released, never taken, or taken by another run or an earlier attempt
//   { left: 'held' }            it took the lock and posted nothing that ends a run
//   { left: 'ended', kind }     it posted a comment that ends a run (kind) and stopped before changing the labels
// Every way a run ends releases the lock (the report, a stop, a back-off), so 'held' is a run that
// stopped part-way. Comments are ordered by id, as in runs.mjs, never by time.
export function lockLeft(run, { labels, comments, since }) {
  if (!labels.includes('pipeline-working')) return { left: 'free' };
  const pipeline = comments.filter((c) => c.pipeline).sort((a, b) => a.id - b.id);
  const lock = pipeline.filter((c) => c.marker.kind === 'lock').at(-1);
  if (!lock || lock.marker.run !== run || !sameOrAfter(lock.createdAt, since)) return { left: 'free' };
  const ending = pipeline.filter((c) => c.id > lock.id && c.marker.run === run && RELEASING_KINDS.includes(c.marker.kind)).at(-1);
  return ending ? { left: 'ended', kind: ending.marker.kind } : { left: 'held' };
}

// The label edits that finish an ending comment's procedure, in its order. The stop procedure
// (`blocked` and `questions`) adds needs-decision and removes pipeline-go with the lock. Stage 10's
// `report` removes pipeline-go with the lock. A back-off (`deferred`) and a `split` release the lock
// and nothing else: the split parent waits for its sub-issues and asks the owner nothing.
const PARKS = ['blocked', 'questions'];
export function endingEdits(kind, labels) {
  const edits = [];
  if (PARKS.includes(kind)) edits.push(['--add-label', 'needs-decision']);
  if ((PARKS.includes(kind) || kind === 'report') && labels.includes('pipeline-go')) edits.push(['--remove-label', 'pipeline-go']);
  edits.push(['--remove-label', 'pipeline-working']);
  return edits;
}

// The comment that parks an issue whose run started and then ended with the lock held.
export function stoppedBody(marker, run, trace = null) {
  const log = run.startsWith('http') ? ` The log is at ${run}.` : '';
  return [
    marker,
    '',
    `The run stopped with the lock held: the session took the lock and ended without a report, a question or a stop comment, so no result was posted.${log} Whatever it committed is still on its branch, if it pushed one.`,
    ...traceLines(trace),
    '',
    'The lock is released. Reply here to start a new run.',
  ].join('\n');
}
