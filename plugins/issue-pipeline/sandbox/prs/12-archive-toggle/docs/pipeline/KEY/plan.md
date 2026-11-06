# Plan — {{KEY}}

## Task 1 — Model

Add `archived?: boolean` to `Item`, add `archiveItem` and `visibleItems` to `src/list.ts`, and a unit test in `src/list.test.ts`.

Done when: `npm test` passes with the new test.

## Task 2 — Render

Add an Archive button in `src/render.ts`, wire it to `archiveItem` in `src/main.ts`, render `visibleItems(items)`, and show the header count.

Done when: `npm run typecheck` and `npm run build` pass.
