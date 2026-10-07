import './style.css';
import { addItem, archiveItem, removeItem, visibleItems, type Item } from './list';
import { renderList } from './render';
import { load, save } from './storage';

let items: Item[] = load(localStorage);
const listEl = document.querySelector<HTMLDivElement>('#list')!;
const heading = document.querySelector<HTMLHeadingElement>('h1')!;
const form = document.querySelector<HTMLFormElement>('#add-form')!;

function refresh(): void {
  heading.textContent = `Reading list (${items.length} books)`;
  listEl.innerHTML = renderList(visibleItems(items));
  save(localStorage, items);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  items = addItem(
    items,
    { title: String(data.get('title') ?? ''), author: String(data.get('author') ?? '') },
    new Date(),
    crypto.randomUUID(),
  );
  form.reset();
  refresh();
});

listEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.matches('button.remove') && target.dataset.id) {
    items = removeItem(items, target.dataset.id);
    refresh();
  }
  if (target.matches('button.archive') && target.dataset.id) {
    items = archiveItem(items, target.dataset.id);
    refresh();
  }
});

refresh();
