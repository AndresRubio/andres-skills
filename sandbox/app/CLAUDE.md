# Reading list (claude-pipeline sandbox)

A tiny Vite + TypeScript app used to test claude-pipeline. Keep changes small.

- `npm test` (vitest), `npm run typecheck`, `npm run build`, `npm run dev -- --port <port> --strictPort`.
- Pure logic lives in `src/list.ts` and `src/render.ts` and is unit-tested; `src/main.ts` only wires the DOM.
