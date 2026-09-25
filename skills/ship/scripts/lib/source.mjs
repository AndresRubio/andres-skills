const GITHUB_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)(?:\/[^?#\s]*)?(?:[#?]\S*)?$/;
const LINEAR_URL = /^https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/\S*)?$/;
const LINEAR_ID = /^[A-Z][A-Z0-9]*-\d+$/;

export function parseSource(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('source is empty');
  const s = input.trim();
  let m = s.match(/^#?(\d+)$/);
  if (m) {
    const number = Number(m[1]);
    return { kind: 'github', number, key: String(number) };
  }
  m = s.match(GITHUB_URL);
  if (m) {
    const number = Number(m[4]);
    if (m[3] === 'pull') return { kind: 'github-pr', owner: m[1], repo: m[2], number };
    return { kind: 'github', owner: m[1], repo: m[2], number, key: String(number) };
  }
  m = s.match(LINEAR_URL);
  if (m) return { kind: 'linear', id: m[1], key: m[1].toLowerCase() };
  if (LINEAR_ID.test(s)) return { kind: 'linear', id: s, key: s.toLowerCase() };
  return { kind: 'text', text: s };
}
