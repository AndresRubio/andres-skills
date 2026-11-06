title: Show the author's name in italics
labels: enhancement
---
In the list, the author's name after "by" should be in italics. Wrap the author span's text in `<em>`; nothing else in the row changes.

Acceptance criteria:
- Each list row renders the author inside `<em>`, still HTML-escaped.
- A test in `src/render.test.ts` covers it.
