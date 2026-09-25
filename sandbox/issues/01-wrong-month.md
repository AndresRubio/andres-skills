title: Added dates show the wrong month
labels: claude,bug
---
Every item in the list shows the month after the one it was added in, and items added in December show "undefined".

**Steps**
1. Add a book today.
2. Look at the date next to it.

**Expected:** the current month, e.g. an item added on 2026-09-25 shows `25 Sep 2026`.
**Actual:** it shows `25 Oct 2026`.

**Acceptance criteria**
- An item added on 2026-09-25 shows `25 Sep 2026`.
- An item added on 2026-12-03 shows `3 Dec 2026`.
- An item added on 2026-01-15 shows `15 Jan 2026`.
- A unit test covers the date format.
