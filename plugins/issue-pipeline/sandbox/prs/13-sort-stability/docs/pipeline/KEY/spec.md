# Spec — {{KEY}}: Sort the list by title, keeping insertion order for equal titles

**Source:** issue #{{NUMBER}}

## Problem Statement

The reading list shows books in the order they were added, which makes a long list hard to scan by title.

## Solution

A `sortItems` function returns the list sorted by title, case-insensitive. Books with equal titles keep the order they were added in.

## User Stories

1. As a reader, I want my list sorted by title, so that I can find a book quickly.

## Acceptance Criteria

1. AC1: `sortItems(items)` returns a new array sorted by title, case-insensitive. Checked by a unit test.
2. AC2: items with equal titles keep their relative order. Checked by a unit test.
3. AC3: a unit test covers both rules.

## Assumptions

None.

## Implementation Decisions

One pure function in `src/list.ts`, built on the stable `Array.prototype.sort`.

## Testing Decisions

Test the function's output order, in `src/list.test.ts`.

## Out of Scope

Wiring the sort into the page.

## Further Notes

None.
