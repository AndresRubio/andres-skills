title: Archive items instead of deleting them
labels: claude,enhancement
---
Removing a book is final. Add an **Archive** action so a book can be set aside without being lost.

**Acceptance criteria**
1. Each item has an Archive button next to Remove.
2. An archived item is hidden from the list but stays in storage with `archived: true`.
3. The header count still reads "N books".
4. A unit test covers archiving.
