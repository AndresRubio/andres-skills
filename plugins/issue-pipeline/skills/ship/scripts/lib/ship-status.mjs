import { existsSync, readdirSync } from 'node:fs';
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

// The comment that parks an issue whose run never started. `run` is the marker's run: the Actions
// run URL, or 'local' outside Actions.
export function notStartedBody(marker, run) {
  const log = run.startsWith('http') ? ` The log is at ${run}.` : '';
  return [
    marker,
    '',
    `The run did not start: the session ended before the pipeline's Setup, so no stage ran and nothing was changed.${log}`,
    '',
    'Reply here once the cause is fixed to start a new run.',
  ].join('\n');
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
// (`blocked`, and the `questions` and `split` stops) adds needs-decision and removes pipeline-go with
// the lock. Stage 10's `report` removes pipeline-go with the lock. A back-off (`deferred`) releases
// the lock and nothing else.
const PARKS = ['blocked', 'questions', 'split'];
export function endingEdits(kind, labels) {
  const edits = [];
  if (PARKS.includes(kind)) edits.push(['--add-label', 'needs-decision']);
  if ((PARKS.includes(kind) || kind === 'report') && labels.includes('pipeline-go')) edits.push(['--remove-label', 'pipeline-go']);
  edits.push(['--remove-label', 'pipeline-working']);
  return edits;
}

// The comment that parks an issue whose run started and then ended with the lock held.
export function stoppedBody(marker, run) {
  const log = run.startsWith('http') ? ` The log is at ${run}.` : '';
  return [
    marker,
    '',
    `The run stopped with the lock held: the session took the lock and ended without a report, a question or a stop comment, so no result was posted.${log} Whatever it committed is still on its branch, if it pushed one.`,
    '',
    'The lock is released. Reply here to start a new run.',
  ].join('\n');
}
