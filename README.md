# Wrangle Tabs

A Chrome extension that closes duplicate tabs and sorts the rest into tab groups, from one keyboard-driven page.

Click the toolbar button (or press **Alt+Shift+T**) to open the dashboard. It lists every suggested change, all ticked. Untick what you don't want and press **Shift+Enter** to apply the rest. Unticked suggestions stay on the page for later.

## What it does

**Closes duplicates.** Two tabs are duplicates when their URLs match after cleanup (case, `www.`, `http`/`https`, trailing `/`, and tracking parameters such as `utm_*` and `fbclid` are ignored). If the URLs differ only after the `#`, the titles must match too, so `…/docs#section` matches `…/docs`, but Gmail's `#inbox` and `#label/receipts` don't.

- A pinned copy is always the one kept; pinned tabs are never closed.
- Otherwise it keeps the active tab, then a tab playing audio, then the most recently used.
- An ungrouped copy of a grouped tab is closed; the group keeps its tab.
- Copies in two different groups are left alone.

**Sorts ungrouped tabs.** Each ungrouped tab is suggested for one of:

- **An existing group.** Existing groups only ever gain tabs. They never lose tabs and are never mixed together.
- **A new group.** Created in the window that already holds most of its tabs.
- **The Leftovers window**, for tabs that fit nowhere.

Pinned tabs never appear on the dashboard and are never moved.

**Your own groups.** Press **n** to propose a group with a name and an optional hint. Ungrouped tabs are re-sorted to fill it. Your groups are saved until you apply or delete them, and are kept even when nothing matches yet. Tabs you move by hand (**m**) stay where you put them when tabs are re-sorted.

## Sorting

Stage 1 sorts by website: tabs go into your proposed groups by matching words in the group's name and hint, then into the existing group that already holds tabs from the same site, then into a new group per site with two or more tabs. Stage 2 replaces this with Chrome's built-in AI (Gemini Nano), which runs on your machine.

## Keys

| Key | Action |
|---|---|
| `j` / `k`, arrows | Next / previous row |
| `J` / `K` | Next / previous section |
| `g` / `G` | First / last row |
| `h` / `l` | Collapse / expand group |
| `x`, space | Tick or untick row or group |
| `a` | Tick or untick the whole section |
| `m` | Move tab to another group |
| `n` | Propose your own group |
| `d` | Delete a group you proposed |
| `e` | Rename a new group |
| `c` | Change a new group's color |
| Enter | Switch to the tab |
| `y` | Copy the tab's full URL |
| `/` | Filter |
| `r` | Re-scan tabs |
| Shift+Enter | Apply ticked changes |
| `?` | All shortcuts |

## Development

```bash
npm install
npm run build   # type-checks and builds into dist/
npm test        # unit tests for duplicate detection and sorting
```

To load it in Chrome: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `dist/` folder. After rebuilding, click the reload icon on the extension's card.

`npm run watch` rebuilds on every change.

### Layout

- `src/core/` — pure logic, no Chrome APIs: URL cleanup, duplicate detection, the sorter interface and the plan builder. Covered by `tests/`.
- `src/chrome/` — reading tabs, applying changes, storage.
- `src/dashboard/` — the dashboard page.
- `src/background.ts` — opens or focuses the dashboard.
