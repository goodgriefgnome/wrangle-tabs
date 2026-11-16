# Keyboard-first Quiet list

## Goal and approved reference

Implement the agreed design in the Chrome extension, not merely the mockup.
Reference: https://wrangle-tabs-design-review.fizzyvale2.chatgpt.site
Local self-contained reference: /workspace/sites/wrangle-preview/dist/index.html
The reference uses sample data and DOM shortcuts for demonstration; reuse its visual direction and behavior, not its implementation architecture.

## Product decisions

1. Explicit user decisions act in Chrome immediately. Moving to an existing group, creating a group from focused/selected tabs, closing tabs, renaming, and recoloring must not require later acceptance. Selection itself makes no changes. Accepting an AI group immediately applies that suggestion. Correcting one tab must not accept the remainder of its suggested group.
2. Retain the Quiet list appearance: restrained green accent, compact rows, subtle group colors, clear cursor, minimal text. One suggestions workspace. No sidebar, Suggestions heading, tab-count introduction, marketing copy, debugging output, or shortcut panel permanently taking space.
3. Header: app name, New group with n, Undo, and Help with ?. Show meaningful short status/error feedback without a constant explanatory paragraph. AI/provider settings and rescan/resort remain accessible through Help/settings or unobtrusive controls; preserve existing functionality.
4. Display Shift+Enter only on the one group affected by the keyboard action. Hide that hint while a selection makes group acceptance unavailable. Other group acceptance buttons may remain clickable without duplicated shortcut hints.
5. Move (m) and Close (#) appear only on the focused row. With a selection, visibly indicate the selection scope. Rows remain single-line: remove the words Move/Close at constrained widths before considering other reductions. Keep the keycaps, accessible labels, and non-overlapping controls. Truncate the title as necessary; never wrap these actions onto another row. Do not put navigation/selection hints on every row; show them in ? help.
6. Restore a bottom bar solely for the focused tab's full URL. It follows keyboard and pointer focus, shows the actual complete URL rather than a cleaned duplicate key, permits copying, and clears when no tab is focused. No shortcut or apply toolbar there. A long URL may wrap within this bar; reserve sufficient scroll clearance dynamically so the last row cannot be hidden. Tab rows themselves never wrap. A group-header focus should not show a stale tab URL.
7. Completed AI results wait for explicit import once review has started. A small header indicator changes from sorting to Import N ready with u. Import appends new groups and adds to existing suggestions without reordering reviewed content, losing selection, moving the cursor, or changing the scroll anchor. Import only reveals proposals; it does not mutate Chrome. AI results must not resurrect a tab explicitly moved, closed, kept ungrouped, or otherwise resolved by the user. Respect existing handling of one-tab topics and model failures.
8. Explicit corrections stick through rescans, import, and re-sorting. Pinned-tab protection and existing-group boundaries remain intact. Unmatched tabs can be left ungrouped in their original locations; moving to a Leftovers window is an explicit optional action, not an unavoidable completion step.

## Keyboard behavior

- j/k or Up/Down: adjacent row; J/K: adjacent group/section. Retain useful existing g/G and collapse/expand commands where compatible.
- x or Space: toggle focused tab selection, with clear selection styling.
- m: searchable destination picker; Up/Down selects, Enter immediately moves the focused tab or selection. Offer existing groups, new group, and leave ungrouped. Moving to a proposed group should create the actual destination using only explicitly moved tabs, not implicitly accept the whole proposal.
- n: name a group and Enter creates it with focused/selected tabs immediately. Optional find-more suggestions must not silently re-sort the whole reviewed list. If creating an empty group is supported, label that case clearly.
- #: immediately close focused/selected tabs. Keep duplicate acceptance explicitly scoped and pinned tabs safe.
- Enter: switch to the focused Chrome tab. Shift+Enter: accept only the focused group's suggestion, unavailable during a selection.
- u: import ready results. Esc: close picker/dialog, then clear selection/filter as appropriate.
- Ctrl/Cmd+Z: Undo the most recent supported direct action. Text inputs keep native editing/undo behavior. ?: full shortcuts, including discoverable settings/rescan/resort commands.
- Do not capture global keys while typing or when modifiers belong to the browser. Dialogs need reliable focus entry, keyboard navigation, cancellation and focus return.

## Implementation sequence

1. Inspect the current repository, instructions, branch and remote; fetch current main and preserve any existing changes. Read dashboard, plan, model sorter, storage, snapshot and apply logic. Record implementation assumptions.
2. Separate suggested state from executed actions. Introduce a coherent action layer for immediate moves/group creation/close/rename/color and per-action outcomes. Handle partial failures honestly; keep failed work available, resnapshot actual Chrome state, and avoid dropping proposals or manual intent on failure. Store only intent needed to protect decisions across relevant refreshes/reloads.
3. Implement practical Undo with recorded original positions/windows/group membership and created groups. Closing-tab Undo may reopen URLs but cannot promise restored page state; disclose that limitation in concise action feedback/help. Revalidate live tabs/groups/windows and avoid mutating unrelated browser state. Undo should not clobber later AI arrivals or unrelated user activity.
4. Replace dashboard layout/styles using the approved design, integrating the real model and action layer. Preserve provider settings, duplicate keep-copy context, informative errors and accessibility. Use native controls with visible focus and accessible names. No mock sample tabs or simulated timers in the extension.
5. Implement keyboard routing, focused-row controls, contextual group hint and searchable move/new-group dialogs. Keep focus/scroll stable after immediate action and incoming-results import.
6. Add the URL-only bottom bar with responsive clearance. Ensure it shows full URLs for duplicate rows too; retain any keep-copy comparison in contextual detail rather than misrepresenting the focused URL.
7. Verify the result and update README to reflect immediate actions, shortcuts, incoming suggestions and Undo limitations. Keep this plan updated with final implementation status and any genuine limitations.

## Required verification

- Run npm test and npm run build (repository requirements before pushing).
- Add meaningful tests for direct-action scope, partial failure, pinned protection, Undo and manual-intent preservation; avoid superficial DOM snapshot tests.
- Exercise the real dashboard with a Chrome API fixture/mock if a live extension cannot be run. Distinguish mocked verification from real-browser integration evidence.
- Keyboard-only walkthrough: navigate, select multiple tabs, search destination, move now, new-group now, close, undo, accept one group, rescan, import while focused/selected, help/settings and cancel dialogs.
- Incoming results: before completion, ready count, explicit import, stable row/cursor/selection/scroll, no duplicate import, stale model answers for already handled tabs, and result arrival during a modal/action.
- Layout at desktop, medium and narrow widths, light/dark themes: tab rows remain one line, focused actions shrink to keycaps, at most one group shortcut hint, full long URL remains available, bottom bar never covers final rows.
- Empty states, all tabs handled, stale tabs, vanished windows/groups and individual Chrome API failures.

## Delivery

Follow repository instructions: work on main, no feature branch/PR, and run required checks before commit/push. The user has requested implementation; the repository documents that pushes publish the extension. Commit and push the completed, verified change when ready. Do not push a partial/broken implementation. Report commit, verification, release outcome if observable, and any material limitations. Do not overwrite unrelated concurrent changes.

## Final implementation status

Implemented the Quiet list in the actual extension, retaining its model/provider pipeline. Explicit moves, new groups, closes and group acceptance execute immediately. Existing-group rename/recolor also execute immediately; names/colors on unaccepted proposals edit that proposal. The direct action layer revalidates live tabs, protects pins, reports individual failures, records intermediate mutations and rescans actual Chrome state. Session decisions are keyed by tab ID and full URL to prevent stale AI answers from resurrecting handled tabs; navigation makes the tab eligible again.

Implemented a single-action Undo for move/create/close/rename/recolor, including original windows, indexes and group metadata. It avoids overwriting subsequent window/group changes. Closing Undo reopens URLs without page state. Undo history is in memory for the current dashboard page; resolved intent survives page reload through Chrome session storage. The optional legacy Move to Leftovers window action is retained, but does not offer Undo. Undo cannot restore a vanished original window.

Updated final approved footer decision: the fixed footer has the focused tab's complete URL above a divider, followed by provider/progress/fallback/error status and Import ready/Stop/AI settings controls. AI settings is visibly accessible there with s, not in the header. Header contains app name, New group n, Undo and Help ?. URL height drives dynamic scroll clearance. Rows remain single-line; constrained widths hide action words, retaining keycaps and accessible labels. Only the focused row has actions; only its group has the Shift+Enter hint, hidden during selection.

Incoming AI answers wait after review begins, preserve modal focus and selected tabs, and import with stable group/row order, tab cursor identity and scroll anchor. Import never calls mutation APIs. A focused imported tab expands a collapsed destination when needed to remain visible. Help contains navigation/selection and settings/rescan/resort commands; settings retains providers, model configuration/download and error details.

Verification: unit coverage includes direct scope, pins, partial failure/intermediate moves, stale destinations, Undo and later external changes, metadata restoration, manual/resolved-intent preservation and stable review order. `scripts/verify-dashboard.cjs` uses Chromium with a mutable Chrome API and scripted model fixture for keyboard move/create/close/Undo, selection, acceptance, dialogs/help/settings, explicit incoming import while a modal is open, stale answers for already-closed tabs, stable cursor/selection/scroll, no duplicate import, empty state, full URL, and 1100/760/600/360px light/dark row/footer checks. This is fixture-based browser verification, not a real provider call. An attempted unpacked-extension run in installed Chromium did not expose an extension service worker, so no live extension-integration claim is made. npm test, npm run build and git diff --check are required and run before delivery.
