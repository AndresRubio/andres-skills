import './style.css';
import { addItem, removeItem, type Item } from './list';
import { renderList } from './render';
import { load, save } from './storage';

let items: Item[] = load(localStorage);
const listEl = document.querySelector<HTMLDivElement>('#list')!;
const form = document.querySelector<HTMLFormElement>('#add-form')!;

function refresh(): void {
  listEl.innerHTML = renderList(items);
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
});

refresh();
