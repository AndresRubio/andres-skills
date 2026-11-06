# Spec — {{KEY}}: Archive items instead of deleting them

**Source:** issue #{{NUMBER}}

## Problem Statement

Removing a book from the reading list is final. A reader who only wants to set a book aside has no way to do it without losing it.

## Solution

Each item gets an Archive button next to Remove. An archived book disappears from the list but stays in storage, flagged `archived: true`.

## User Stories

1. As a reader, I want to archive a book, so that it leaves my list without being lost.

## Acceptance Criteria

1. AC1: each item has an Archive button next to Remove. Checked by rendering the list and looking for the button.
2. AC2: an archived item is hidden from the list but stays in storage with `archived: true`. Checked by a unit test on `archiveItem` and `visibleItems`.
3. AC3: the header count still reads "N books". Checked by reading the heading after archiving.
4. AC4: a unit test covers archiving.

## Assumptions

- A1: the header count includes archived items (unresolved in the issue).

## Implementation Decisions

`Item` gains an optional `archived` flag. `list.ts` gains `archiveItem` and `visibleItems`; the render and main modules use them.

## Testing Decisions

Test external behaviour of the pure list functions, in `list.test.ts` beside the existing tests.

## Out of Scope

Un-archiving, and a view of archived books.

## Further Notes

None.
