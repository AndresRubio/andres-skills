// Shared by skill-structure.test.mjs and skill-wording.test.mjs: where the ship skill lives and
// how to read it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = fileURLToPath(new URL('../../skills/ship/', import.meta.url));
export const read = (rel) => readFileSync(path.join(SKILL_DIR, rel), 'utf8');
export const headings = (text) => [...text.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1].trim());

// Every .md file under the skill, except under scripts/.
export function markdownFiles(dir = SKILL_DIR) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'scripts' ? [] : markdownFiles(full);
    return name.endsWith('.md') ? [full] : [];
  });
}

// The text under `## <heading>`, up to the next ## heading.
export const section = (text, heading) => text.split(`## ${heading}`)[1]?.split('\n## ')[0] ?? '';
// A top-level numbered step, up to the next one, a heading, or the end of the text.
export const step = (text, n) => text.match(new RegExp(`^${n}\\. [\\s\\S]*?(?=^\\d+\\. |^#|(?![\\s\\S]))`, 'm'))?.[0] ?? '';
