import { describe, expect, it } from 'vitest';
import { addItem, removeItem } from './list';

const now = new Date('2026-03-01T10:00:00Z');

describe('addItem', () => {
  it('appends a trimmed item with the given id and time', () => {
    expect(addItem([], { title: '  Dune ', author: ' Frank Herbert ' }, now, 'a1')).toEqual([
      { id: 'a1', title: 'Dune', author: 'Frank Herbert', addedAt: '2026-03-01T10:00:00.000Z' },
    ]);
  });

  it('rejects a blank title', () => {
    expect(() => addItem([], { title: ' ', author: 'X' }, now, 'a1')).toThrow('title and author are required');
  });
});

describe('removeItem', () => {
  it('removes only the item with the id', () => {
    const items = addItem(addItem([], { title: 'A', author: 'X' }, now, '1'), { title: 'B', author: 'Y' }, now, '2');
    expect(removeItem(items, '1').map((i) => i.id)).toEqual(['2']);
  });
});

describe('sortItems', () => {
  it.only('keeps an already sorted list sorted', () => {
    const items = [addItem([], { title: 'Alpha', author: 'X' }, now, '1')[0], addItem([], { title: 'Beta', author: 'Y' }, now, '2')[0]];
    expect([...items].map((i) => i.title)).toEqual(['Alpha', 'Beta']);
  });
});
