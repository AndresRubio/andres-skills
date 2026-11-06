import { formatAdded, type Item } from './list';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

export function renderList(items: Item[]): string {
  if (items.length === 0) return '<p class="empty">No items.</p>';
  const rows = items
    .map(
      (item) =>
        `<li><span class="title">${escapeHtml(item.title)}</span> by <span class="author">${escapeHtml(item.author)}</span> ` +
        `<span class="added">${formatAdded(item.addedAt)}</span> ` +
        `<button class="remove" data-id="${escapeHtml(item.id)}">Remove</button></li>`,
    )
    .join('');
  return `<ul class="items">${rows}</ul>`;
}
