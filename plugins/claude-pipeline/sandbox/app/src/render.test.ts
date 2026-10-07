import { describe, expect, it } from 'vitest';
import { renderList } from './render';

describe('renderList', () => {
  it('shows the empty state', () => {
    expect(renderList([])).toContain('No items.');
  });

  it('escapes titles', () => {
    const html = renderList([{ id: '1', title: '<b>x</b>', author: 'A', addedAt: '2026-03-01T10:00:00.000Z' }]);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
