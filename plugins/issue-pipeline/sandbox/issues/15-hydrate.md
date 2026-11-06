title: Document what formatAdded returns
labels: enhancement,pipeline
---
`formatAdded` has no doc comment, and #{{ISSUE:01-wrong-month.md}} showed how easy its output is to get wrong. The function is here:

{{PERMALINK:src/list.ts:21-24}}

Add a JSDoc comment above it that says it returns the day of the month, the short month name and the four-digit year, separated by spaces, read in UTC. Change no code.

The tests that cover it run in this CI run, which must stay green: {{CI_RUN}}

Acceptance criteria:
- `formatAdded` has a JSDoc comment naming that format and the UTC reading.
- No other line of `src/list.ts` changes.
- `npm test` passes.
