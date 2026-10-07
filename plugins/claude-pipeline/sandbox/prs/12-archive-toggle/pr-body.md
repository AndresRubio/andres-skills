**[claude-pipeline]** report · 2026-10-07T00:00:00Z · seeded
Fixes #{{NUMBER}}

**Summary:** Archive marks an item `archived: true`; the list renders only visible items.

**Acceptance criteria**
- [x] Archive button next to Remove
- [x] Archived items hidden, kept in storage
- [x] Header count reads "N books" — counts all items, archived included
- [x] Unit test covers archiving

**Decision needed:** criterion 3 doesn't say whether archived books count. This PR counts them (a book you own is still a book). The other reading is to count only visible items.

Pipeline files: `docs/pipeline/{{KEY}}/`
