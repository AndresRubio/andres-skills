title: Add countByAuthor to the list module
labels: enhancement
---
Export a function `countByAuthor(items: Item[]): Record<string, number>` from `src/list.ts` that returns how many items each author has. Authors are compared exactly as stored. Nothing calls it yet.

Acceptance criteria:
- `countByAuthor([])` returns `{}`.
- Two items by "Le Guin" and one by "Tolkien" give `{ "Le Guin": 2, "Tolkien": 1 }`.
- Tests in `src/list.test.ts` cover both.
