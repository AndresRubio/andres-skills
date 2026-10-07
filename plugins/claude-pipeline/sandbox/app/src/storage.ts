import type { Item } from './list';

const KEY = 'reading-list.v1';

export function load(storage: Storage): Item[] {
  const raw = storage.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Item[]) : [];
  } catch {
    return [];
  }
}

export function save(storage: Storage, items: Item[]): void {
  storage.setItem(KEY, JSON.stringify(items));
}
