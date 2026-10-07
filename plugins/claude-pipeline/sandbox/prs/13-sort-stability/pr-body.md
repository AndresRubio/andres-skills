**[claude-pipeline]** report · 2026-10-07T00:00:00Z · seeded
Fixes #{{NUMBER}}

**Summary:** Adds `sortItems`, which returns a copy of the list sorted by title, case-insensitive, with equal titles keeping insertion order.

**Acceptance criteria**
- [x] `sortItems(items)` returns a new array sorted by title, case-insensitive
- [x] Items with equal titles keep their relative order
- [x] A unit test covers both rules

Pipeline files: `docs/pipeline/{{KEY}}/`
