// Sampled scoring (spec §7.5, D19). Informs, never blocks.
import { parseMarker } from './marker.mjs';

export const TASK_COMPLIANCE = Object.freeze(['compliant', 'partial', 'non_compliant']);
export const REVIEW_QUALITY = Object.freeze(['actionable', 'vague', 'empty_or_noise']);
const TAG = 'claude-pipeline-score';

// One in four, deterministic on the issue number, so a re-run scores the same PRs.
export const isSampled = (issueNumber) => Number.isInteger(issueNumber) && issueNumber % 4 === 0;

export function validateScore(s) {
  if (!s || typeof s !== 'object') throw new Error('a score must be an object');
  if (!TASK_COMPLIANCE.includes(s.taskCompliance)) throw new Error(`taskCompliance must be one of ${TASK_COMPLIANCE.join(', ')}`);
  if (!REVIEW_QUALITY.includes(s.reviewQuality)) throw new Error(`reviewQuality must be one of ${REVIEW_QUALITY.join(', ')}`);
  if (typeof s.reasons?.taskCompliance !== 'string' || typeof s.reasons?.reviewQuality !== 'string') throw new Error('reasons.taskCompliance and reasons.reviewQuality must be strings');
}

// A reason is model-written text that lands in a visible bullet: one line, and no comment opener,
// so it cannot start a second score tag that the parser would take for the real one.
const cleanReason = (r) => r.replace(/[\r\n]+/g, ' ').replace(/<!--/g, '<!-\u200b-');

export function formatScoreBody({ marker, head, score, model = null }) {
  validateScore(score);
  const reasons = { taskCompliance: cleanReason(score.reasons.taskCompliance), reviewQuality: cleanReason(score.reasons.reviewQuality) };
  // The model name is text from the scorer session's command line: cleaned the same way, so it cannot
  // open a second tag either.
  const cleanModel = model === null || model === undefined ? null : cleanReason(String(model));
  const data = JSON.stringify({ head, taskCompliance: score.taskCompliance, reviewQuality: score.reviewQuality, reasons, model: cleanModel }).replace(/-->/g, '--\\u003e');
  return [
    marker, '',
    `**Score** at head \`${head.slice(0, 7)}\`: sampled 1 in 4. It informs and blocks nothing.`, '',
    `- Task compliance: \`${score.taskCompliance}\`. ${reasons.taskCompliance}`,
    `- Review quality: \`${score.reviewQuality}\`. ${reasons.reviewQuality}`, '',
    `<!-- ${TAG} ${data} -->`,
  ].join('\n');
}

// Linear: the tag is the last one in the body, closed by ` -->` at the very end. No regex backtracking.
export function parseScoreBody(body) {
  if (parseMarker(body)?.kind !== 'score') return null;
  const text = String(body).trimEnd();
  const open = `<!-- ${TAG} `;
  const start = text.lastIndexOf(open);
  if (start === -1 || !text.endsWith(' -->')) return null;
  const json = text.slice(start + open.length, text.length - 4);
  if (!json.startsWith('{') || !json.endsWith('}')) return null;
  try {
    const data = JSON.parse(json);
    validateScore(data);
    return { head: data.head, taskCompliance: data.taskCompliance, reviewQuality: data.reviewQuality, reasons: data.reasons, model: data.model ?? null };
  } catch {
    return null;
  }
}

export function latestScore(comments) {
  return comments.filter((c) => c.pipeline && c.marker?.kind === 'score').map((c) => parseScoreBody(c.body)).filter(Boolean).at(-1) ?? null;
}
