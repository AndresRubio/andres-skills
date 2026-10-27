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

export function formatScoreBody({ marker, head, score, model = null }) {
  validateScore(score);
  const data = JSON.stringify({ head, taskCompliance: score.taskCompliance, reviewQuality: score.reviewQuality, reasons: score.reasons, model }).replace(/-->/g, '--\\u003e');
  return [
    marker, '',
    `**Score** at head \`${head.slice(0, 7)}\`: sampled 1 in 4. It informs and blocks nothing.`, '',
    `- Task compliance: \`${score.taskCompliance}\`. ${score.reasons.taskCompliance}`,
    `- Review quality: \`${score.reviewQuality}\`. ${score.reasons.reviewQuality}`, '',
    `<!-- ${TAG} ${data} -->`,
  ].join('\n');
}

export function parseScoreBody(body) {
  if (parseMarker(body)?.kind !== 'score') return null;
  const m = String(body).match(new RegExp(`<!-- ${TAG} (\\{.*\\}) -->\\s*$`, 's'));
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    validateScore(data);
    return { head: data.head, taskCompliance: data.taskCompliance, reviewQuality: data.reviewQuality, reasons: data.reasons, model: data.model ?? null };
  } catch {
    return null;
  }
}

export function latestScore(comments) {
  return comments.filter((c) => c.pipeline && c.marker?.kind === 'score').map((c) => parseScoreBody(c.body)).filter(Boolean).at(-1) ?? null;
}
