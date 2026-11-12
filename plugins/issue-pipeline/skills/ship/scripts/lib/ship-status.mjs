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
