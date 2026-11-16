# Wrangle Tabs

A Chrome extension that closes duplicate tabs and sorts the rest into tab groups, from one keyboard-driven page.

Click the toolbar button (or press **Alt+Shift+T**) to open the keyboard-first Quiet list. Move with `j`/`k`, select with `x`, and use `m` to move tabs immediately, `n` to create a group from focused/selected tabs, or `#` to close them now. **Shift+Enter** accepts only the focused group's proposal, and is unavailable during a selection. Selection itself makes no changes.

The footer shows the focused tab's complete, copyable URL, followed by AI progress, ready-result import, and **AI settings** (`s`). **Undo** or **Ctrl/Cmd+Z** reverses the most recent supported action. Closing-tab Undo reopens URLs; it cannot restore page state, history, forms or a vanished original window. Undo leaves tabs alone if their window/group has changed since the action. Undo history is limited to the current dashboard session.

## Install

1. Download **[wrangle-tabs.zip](https://github.com/goodgriefgnome/wrangle-tabs/releases/download/latest/wrangle-tabs.zip)** (built automatically from `main`) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.

To update, download and unzip the new build over the same folder, then click the reload icon on the extension's card. Each build has its own version number, shown on the extension card.

Builds of other branches are on the [Actions](https://github.com/goodgriefgnome/wrangle-tabs/actions) page: open a run and download **wrangle-tabs** under *Artifacts*.

## What it does

**Closes tabs.** The Duplicates group proposes extra copies to close. Accepting it closes only those copies. Pressing `#` closes the focused/selected tabs immediately. To keep a proposed duplicate, move it to a group or choose **Leave ungrouped** with `m`.

Two tabs are duplicates when their URLs match after cleanup (case, `www.`, `http`/`https`, trailing `/`, and tracking parameters such as `utm_*` and `fbclid` are ignored). If the URLs differ only after the `#`, the titles must match too, so `…/docs#section` matches `…/docs`, but Gmail's `#inbox` and `#label/receipts` don't.

- A pinned copy is always the one kept; pinned tabs are never closed.
- Otherwise it keeps the active tab, then a tab playing audio, then the most recently used.
- An ungrouped copy of a grouped tab is closed; the group keeps its tab.
- Copies in two different groups are left alone.

**Sorts ungrouped tabs.** Each ungrouped tab is suggested for one of:

- **An existing group.** Existing groups only ever gain tabs. They never lose tabs and are never mixed together.
- **A new group.** Created when you accept it or explicitly move tabs into it. A correction moves only the chosen tabs, without accepting the rest of the proposal.
- **Ungrouped**, for unmatched tabs. Leave them where they are, or explicitly choose **Move to window** to collect them in a Leftovers window.

Pinned tabs never appear on the dashboard and are never moved.

**Your own groups.** Press **n**, enter a name and press Enter to create a real group from the focused or selected tabs immediately. It does not re-sort other proposals. Explicit moves, closes and decisions to leave tabs ungrouped stick through rescans, imports and re-sorting, including dashboard reloads in the current browser session. Pinned tabs remain protected even if pinned after the last scan.

## Sorting

An AI model groups tabs by subject. For each ungrouped tab, it writes a short subject and then picks one of your groups or a topic, seeing the tab's title (with the site name removed), your existing groups and the groups you proposed. Tabs go to the model in the order they sit in your windows, and it is told that neighbouring tabs are more likely related; a tab right next to an existing group is marked as such, and a leftover tab between two tabs of the same group joins them. Topics that are just a website name are rejected, and a topic with only one tab stays ungrouped. The footer shows sorting progress and concise fallback/error status; AI settings contains error details.

Choose the model in **AI settings** (bottom right, or press `s`):

- **Chrome's built-in AI** (Gemini Nano), the default. It runs on your computer, so your tabs are never sent anywhere. It needs a one-time download of a few GB (available in AI settings), Chrome 138 or later on Windows, macOS, Linux or a Chromebook Plus, 22 GB of free disk space, and either a GPU with more than 4 GB of video memory or 16 GB of RAM. `chrome://on-device-internals` shows its status.
- **Gemini API**, Google's online model, with a free tier. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Tab titles are sent to Google, which may use free-tier data to improve its products.
- **OpenAI-compatible API**: OpenRouter, Groq, a local Ollama or LM Studio, and other services that accept OpenAI's chat-completions format. Tab titles are sent to that service.
- **No AI**: tabs are sorted by website. Your proposed groups are filled first, by matching words in their name and hint, then the existing group that already holds tabs from the same site, then a new group per site with two or more tabs.

API keys are stored only in this browser and are never synced. The Gemini API needs no extra permission. For an OpenAI-compatible server, the extension asks for permission to reach it when you save; some servers (OpenRouter, for one) work without it, and a local Ollama needs either the permission or `OLLAMA_ORIGINS=chrome-extension://*`.

The model decides from each tab and the current state of the groups (their names, and the tabs already in them), not from your earlier corrections. If it fails on some tabs, they're sorted by website, and the status line at the bottom says why. Answers are remembered per tab, so suggestions don't shift while you review them: re-scans only sort new tabs. Press `R` to explicitly ask the AI again. Creating a real group does not re-sort your reviewed list.

**Results as they stream in.** Pending tabs sit in **Unsorted**. Initial answers appear automatically until you begin reviewing; later answers wait for explicit import. The footer shows **Import N ready** while sorting continues or finishes. Press `u` to reveal them without changing Chrome: reviewed groups/rows retain their order, new groups and rows append, and the cursor, selection and scroll anchor stay stable. Arrivals do not interrupt a dialog. Explicitly handled tabs are excluded from later proposals. A one-tab topic waits until sorting finishes in case other tabs join it.

**Asking again.** `R` asks the AI again about the group under the cursor, the selected tabs, or everything. Those tabs go back to Unsorted and jump the queue; tabs you placed by hand stay put.

## Keys

| Key | Action |
|---|---|
| `j` / `k`, arrows | Next / previous row |
| `J` / `K` | Next / previous group |
| `g` / `G` | First / last row |
| `h` / `l` | Collapse / expand group |
| Shift+Enter | Apply the group under the cursor |
| `x`, space | Select a tab, or all of a group's tabs |
| `m` | Move the selected tabs (or the tab under the cursor) to another group |
| `#` | Close focused/selected tabs immediately |
| `n` | Create a real group from focused/selected tabs |
| `d` | Delete a group you proposed |
| `e` | Rename focused group |
| `c` | Change focused group color |
| Enter | Switch to the tab |
| `y` | Copy the tab's full URL |
| `/` | Filter |
| Esc | Clear the selection, then the filter |
| `r` | Re-scan tabs; only new tabs get sorted |
| `u` | Import ready AI proposals |
| Ctrl/Cmd+Z | Undo last supported action |
| `R` | Ask the AI again: the group under the cursor, the selected tabs, or everything |
| `s` | AI settings |
| `?` | All shortcuts |

## Development

```bash
npm install
npm run build   # type-checks and builds into dist/
npm test        # core, direct actions, Undo and review-order tests
```

To load a local build, follow the install steps above with the `dist/` folder. After rebuilding, click the reload icon on the extension's card.

`npm run watch` rebuilds on every change.

### Layout

- `src/core/` — pure logic, no Chrome APIs: URL cleanup, duplicate detection, the sorters and the plan builder. `model.ts` is the interface every AI model implements. Covered by `tests/` (the AI sorter is tested against a scripted fake model).
- `src/chrome/` — reading tabs, applying changes, storage, and AI settings (`aiSettings.ts`).
- `src/chrome/models/` — one file per way of reaching a model: Chrome's built-in AI, the Gemini API, OpenAI-compatible APIs. To add another, implement `Model` there and add it to `aiSettings.ts` and the settings dialog.
- `src/dashboard/` — the dashboard page.
- `src/background.ts` — opens or focuses the dashboard.

Chromium dashboard verification uses a mutable Chrome API fixture (not a real extension or live model). With Playwright and `/usr/bin/chromium` available, serve `dist/` on port 8765, then run `node scripts/verify-dashboard.cjs`. Set `WRANGLE_TEST_URL` to use a different server. The fixture covers keyboard actions, Undo, modal/import stability, responsive light/dark layout and footer clearance.
