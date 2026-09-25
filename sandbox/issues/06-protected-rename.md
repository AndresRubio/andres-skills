title: Rename the storage helpers for clarity
labels: claude,enhancement
---
`load` and `save` in the storage module are too generic. Rename them to `loadItems` and `saveItems` and update every caller. No behaviour change.
