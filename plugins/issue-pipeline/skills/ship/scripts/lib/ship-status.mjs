import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

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

// Whether this run still holds the issue's lock: the issue carries `pipeline-working` and its newest
// lock comment is this run's. Every way a run ends releases the lock (the report, a stop, a back-off),
// so a run that still holds it when the job is over stopped part-way.
export function holdsLock(run, { labels, comments }) {
  if (!labels.includes('pipeline-working')) return false;
  const newest = comments.filter((c) => c.pipeline && c.marker.kind === 'lock').sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)).at(-1);
  return newest?.marker.run === run;
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
