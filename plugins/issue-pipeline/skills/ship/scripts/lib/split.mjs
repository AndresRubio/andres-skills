import { isPipelineComment } from './lock.mjs';

const SPLIT_LINE_RE = /^Split into: (\S.*)$/;
const NUMBER_RE = /^[1-9]\d*$/;

// The sub-issue numbers named on the last non-empty line of the latest
// pipeline split comment, in order and without duplicates, or [].
export function splitInto(comments) {
  let latest = null;
  for (const c of comments) {
    if (!isPipelineComment(c) || c.marker?.kind !== 'split') continue;
    if (!latest || c.id > latest.id) latest = c;
  }
  if (!latest) return [];
  const last = latest.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  const m = last.match(SPLIT_LINE_RE);
  if (!m) return [];
  const pieces = m[1].split(',').map((piece) => piece.trim());
  if (!pieces.every((piece) => NUMBER_RE.test(piece))) return [];
  return [...new Set(pieces.map(Number))];
}
