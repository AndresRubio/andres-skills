export interface Item {
  id: string;
  title: string;
  author: string;
  addedAt: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function addItem(items: Item[], input: { title: string; author: string }, now: Date, id: string): Item[] {
  const title = input.title.trim();
  const author = input.author.trim();
  if (!title || !author) throw new Error('title and author are required');
  return [...items, { id, title, author, addedAt: now.toISOString() }];
}

export function removeItem(items: Item[], id: string): Item[] {
  return items.filter((item) => item.id !== id);
}

export function formatAdded(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth() + 1]} ${date.getUTCFullYear()}`;
}

export function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
}
