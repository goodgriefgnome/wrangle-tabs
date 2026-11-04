# Wrangle Tabs

A Chrome extension that closes duplicate tabs and sorts the rest into tab groups, from one keyboard-driven page.

Click the toolbar button (or press **Alt+Shift+T**) to open the dashboard. It shows your ungrouped tabs sorted into suggested groups. Review one group at a time: fix any tab that's in the wrong place (select tabs with `x`, move them with `m`, mark them for closing with `#`), then press **Shift+Enter** to apply that group. It's carried out in Chrome straight away and leaves the list. Groups you haven't reviewed stay as they are.

## Install

1. Download **[wrangle-tabs.zip](https://github.com/goodgriefgnome/wrangle-tabs/releases/download/latest/wrangle-tabs.zip)** (built automatically from `main`) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.

To update, download and unzip the new build over the same folder, then click the reload icon on the extension's card. The dashboard shows the version next to its title; each build has its own number, so you can tell whether the new one is loaded.

Builds of other branches are on the [Actions](https://github.com/goodgriefgnome/wrangle-tabs/actions) page: open a run and download **wrangle-tabs** under *Artifacts*.

## What it does

**Closes tabs.** The Close group holds duplicates and any tab you mark with `#`. Applying it closes them; until then, moving a tab out of it keeps it open.

Two tabs are duplicates when their URLs match after cleanup (case, `www.`, `http`/`https`, trailing `/`, and tracking parameters such as `utm_*` and `fbclid` are ignored). If the URLs differ only after the `#`, the titles must match too, so `…/docs#section` matches `…/docs`, but Gmail's `#inbox` and `#label/receipts` don't.

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

An AI model groups tabs by subject. For each ungrouped tab, it writes a short subject and then picks one of your groups or a topic, seeing the tab's title (with the site name removed), your existing groups and the groups you proposed. Topics that are just a website name are rejected, and a topic with only one tab goes to the Leftovers window. While it works, the dashboard shows a progress bar and what goes in and out of the model.

Choose the model in **AI settings** (top right, or press `s`):

- **Chrome's built-in AI** (Gemini Nano), the default. It runs on your computer, so your tabs are never sent anywhere. It needs a one-time download of a few GB (the dashboard offers it), Chrome 138 or later on Windows, macOS, Linux or a Chromebook Plus, 22 GB of free disk space, and either a GPU with more than 4 GB of video memory or 16 GB of RAM. `chrome://on-device-internals` shows its status.
- **Gemini API**, Google's online model, with a free tier. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Tab titles are sent to Google, which may use free-tier data to improve its products.
- **OpenAI-compatible API**: OpenRouter, Groq, a local Ollama or LM Studio, and other services that accept OpenAI's chat-completions format. Tab titles are sent to that service.
- **No AI**: tabs are sorted by website. Your proposed groups are filled first, by matching words in their name and hint, then the existing group that already holds tabs from the same site, then a new group per site with two or more tabs.

API keys are stored only in this browser and are never synced. The Gemini API needs no extra permission. For an OpenAI-compatible server, the extension asks for permission to reach it when you save; some servers (OpenRouter, for one) work without it, and a local Ollama needs either the permission or `OLLAMA_ORIGINS=chrome-extension://*`.

The model decides from each tab and the current state of the groups (their names, and the tabs already in them), not from your earlier corrections. If it fails on some tabs, they're sorted by website, and the status line at the bottom says why. Answers are remembered per tab, so suggestions don't shift while you review them: re-scans only sort new tabs. Proposing or deleting a group, or pressing `R`, sorts everything again.

## Keys

| Key | Action |
|---|---|
| `j` / `k`, arrows | Next / previous row |
| `J` / `K` | Next / previous section |
| `g` / `G` | First / last row |
| `h` / `l` | Collapse / expand group |
| Shift+Enter | Apply the group under the cursor |
| `x`, space | Select a tab, or all of a group's tabs |
| `m` | Move the selected tabs (or the tab under the cursor) to another group |
| `#` | Mark the selected tabs (or the tab) for closing; again to unmark |
| `n` | Propose your own group |
| `d` | Delete a group you proposed |
| `e` | Rename a new group |
| `c` | Change a new group's color |
| Enter | Switch to the tab |
| `y` | Copy the tab's full URL |
| `/` | Filter |
| Esc | Clear the selection, then the filter |
| `r` | Re-scan tabs; only new tabs get sorted |
| `R` | Re-sort all tabs from scratch |
| `s` | AI settings |
| `?` | All shortcuts |

## Development

```bash
npm install
npm run build   # type-checks and builds into dist/
npm test        # unit tests for duplicate detection and sorting
```

To load a local build, follow the install steps above with the `dist/` folder. After rebuilding, click the reload icon on the extension's card.

`npm run watch` rebuilds on every change.

### Layout

- `src/core/` — pure logic, no Chrome APIs: URL cleanup, duplicate detection, the sorters and the plan builder. `model.ts` is the interface every AI model implements. Covered by `tests/` (the AI sorter is tested against a scripted fake model).
- `src/chrome/` — reading tabs, applying changes, storage, and AI settings (`aiSettings.ts`).
- `src/chrome/models/` — one file per way of reaching a model: Chrome's built-in AI, the Gemini API, OpenAI-compatible APIs. To add another, implement `Model` there and add it to `aiSettings.ts` and the settings dialog.
- `src/dashboard/` — the dashboard page.
- `src/background.ts` — opens or focuses the dashboard.
