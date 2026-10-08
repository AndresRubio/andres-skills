import { parseMarker } from './marker.mjs';
import { PIPELINE_BOTS } from './lock.mjs';

export const VERDICTS = Object.freeze(['accepted', 'revision-needed', 'human-decision-needed']);
export const SEVERITIES = Object.freeze(['Critical', 'Important', 'Minor']);
export const FINDING_KINDS = Object.freeze(['unambiguous', 'judgment']);
const SHA_RE = /^[0-9a-f]{40}$/;
const TAG_RE = /<!-- claude-pipeline-verdict (\{[\s\S]*?\}) -->\s*$/;

export function validateFindings(findings) {
  if (!Array.isArray(findings)) throw new Error('findings must be an array');
  findings.forEach((f, i) => {
    const where = `finding ${i + 1}`;
    if (!f || typeof f !== 'object') throw new Error(`${where} must be an object`);
    for (const k of ['file', 'problem', 'impact', 'correction']) {
      if (typeof f[k] !== 'string' || f[k] === '') throw new Error(`${where}: "${k}" must be a non-empty string`);
    }
    if (!(Number.isInteger(f.line) && f.line >= 0)) throw new Error(`${where}: "line" must be an integer >= 0`);
    if (!SEVERITIES.includes(f.severity)) throw new Error(`${where}: "severity" must be one of ${SEVERITIES.join(', ')}`);
    if (!FINDING_KINDS.includes(f.kind)) throw new Error(`${where}: "kind" must be one of ${FINDING_KINDS.join(', ')}`);
    if ('options' in f && !(Array.isArray(f.options) && f.options.every((o) => typeof o === 'string'))) throw new Error(`${where}: "options" must be an array of strings`);
    if ('recommendation' in f && typeof f.recommendation !== 'string') throw new Error(`${where}: "recommendation" must be a string`);
  });
  return findings;
}

export function computeVerdict(findings) {
  validateFindings(findings);
  const blocking = findings.filter((f) => f.severity !== 'Minor');
  if (blocking.some((f) => f.kind === 'judgment')) return 'human-decision-needed';
  if (blocking.length) return 'revision-needed';
  return 'accepted';
}

function findingSection(f, i) {
  const lines = [
    `### ${i + 1}. [${f.severity} · ${f.kind}] ${f.file}:${f.line}`,
    f.problem,
    '',
    `**Impact:** ${f.impact}`,
    `**Correction:** ${f.correction}`,
  ];
  if (f.options?.length) lines.push(`**Options:** ${f.options.join(', ')}`);
  if (f.recommendation) lines.push(`**Recommendation:** ${f.recommendation}`);
  return lines.join('\n');
}

export function formatVerdictBody({ verdict, head, findings = [], diffRisk = [], model = null, reason = null, marker }) {
  if (!VERDICTS.includes(verdict)) throw new Error(`unknown verdict: ${verdict}`);
  if (!SHA_RE.test(head)) throw new Error('head must be a 40-character SHA');
  if (typeof marker !== 'string' || parseMarker(marker)?.kind !== 'verdict') throw new Error('marker must be a verdict marker line');
  const parts = [marker, '', `**Verdict:** \`${verdict}\` · head \`${head.slice(0, 7)}\``];
  if (model) parts.push(`**Reviewer model:** ${model}`);
  if (reason) parts.push(`**Reason:** ${reason}`);
  parts.push('', '## Findings');
  parts.push(findings.length ? findings.map(findingSection).join('\n\n') : 'No Critical or Important findings.');
  parts.push('', '## Diff risk');
  parts.push(diffRisk.length ? diffRisk.map((h) => `- ${h.rule}: \`${h.file}\` — ${h.detail}`).join('\n') : 'None.');
  const payload = { v: 1, verdict, head, findings, diffRisk, model, reason };
  parts.push('', `<!-- claude-pipeline-verdict ${JSON.stringify(payload)} -->`);
  return parts.join('\n');
}

export function parseVerdictBody(body) {
  const marker = parseMarker(body);
  if (!marker || marker.kind !== 'verdict') return null;
  const m = String(body).match(TAG_RE);
  if (!m) return null;
  let payload;
  try { payload = JSON.parse(m[1]); } catch { return null; }
  if (!VERDICTS.includes(payload.verdict) || !SHA_RE.test(payload.head ?? '')) return null;
  try { validateFindings(payload.findings ?? []); } catch { return null; }
  // The verdict is computed, never chosen: without a reason it must be what its findings give;
  // a reason (the review could not finish) always means a human decision.
  if (payload.reason == null) {
    if (computeVerdict(payload.findings ?? []) !== payload.verdict) return null;
  } else if (typeof payload.reason !== 'string' || payload.verdict !== 'human-decision-needed') return null;
  return {
    verdict: payload.verdict, head: payload.head, findings: payload.findings ?? [],
    diffRisk: Array.isArray(payload.diffRisk) ? payload.diffRisk : [], model: payload.model ?? null, reason: payload.reason ?? null,
    at: marker.at, run: marker.run,
  };
}

// Verdicts come from the pipeline's bots, or from the owner (the local lane and the owner's
// PIPELINE_TOKEN post as the owner). Other trusted humans (MEMBER, COLLABORATOR) can't set one.
export function isVerdictAuthor(c) {
  return PIPELINE_BOTS.has(c.author) || c.authorAssociation === 'OWNER';
}

// comments: normalised PR comments (github.fetchPrComments). Newest first by id, pipeline only, matching head.
export function latestVerdict(comments, head) {
  const candidates = comments
    .filter((c) => c.pipeline && isVerdictAuthor(c) && c.marker?.kind === 'verdict')
    .map((c) => ({ id: c.id, parsed: parseVerdictBody(c.body) }))
    .filter((c) => c.parsed && c.parsed.head === head)
    .sort((a, b) => b.id - a.id);
  return candidates[0]?.parsed ?? null;
}
