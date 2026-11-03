import type { GroupColor } from "../core/types";

export interface Actions {
  close: number[];
  addToExisting: { groupId: number; tabIds: number[] }[];
  newGroups: { name: string; color: GroupColor; tabIds: number[] }[];
  leftovers: number[];
}

export interface ApplyResult {
  leftoversWindowId: number | null;
  /** Problems with individual changes, e.g. a tab closed since the last scan. */
  errors: string[];
}

/** The tabs from `ids` that still exist. */
async function live(ids: number[]): Promise<chrome.tabs.Tab[]> {
  const found = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
  return found.filter((t): t is chrome.tabs.Tab => t !== null && t.id !== undefined);
}

async function moveTo(tabs: chrome.tabs.Tab[], windowId: number): Promise<void> {
  const away = tabs.filter((t) => t.windowId !== windowId).map((t) => t.id!);
  if (away.length) await chrome.tabs.move(away, { windowId, index: -1 });
}

/** The window holding most of the tabs; ties go to the first one seen. */
function majorityWindow(tabs: chrome.tabs.Tab[]): number {
  const counts = new Map<number, number>();
  for (const t of tabs) counts.set(t.windowId, (counts.get(t.windowId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Carries out the ticked changes. Each change is tried on its own, so one failure doesn't stop the rest. */
export async function applyActions(actions: Actions, leftoversWindowId: number | null): Promise<ApplyResult> {
  const errors: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await attempt("Closing duplicates", async () => {
    const tabs = await live(actions.close);
    if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id!));
  });

  for (const { groupId, tabIds } of actions.addToExisting) {
    await attempt("Adding to a group", async () => {
      const group = await chrome.tabGroups.get(groupId);
      const tabs = await live(tabIds);
      if (!tabs.length) return;
      await moveTo(tabs, group.windowId);
      await chrome.tabs.group({ groupId, tabIds: tabs.map((t) => t.id!) });
    });
  }

  for (const { name, color, tabIds } of actions.newGroups) {
    await attempt(`Creating “${name}”`, async () => {
      const tabs = await live(tabIds);
      if (!tabs.length) return;
      const windowId = majorityWindow(tabs);
      await moveTo(tabs, windowId);
      const groupId = await chrome.tabs.group({ tabIds: tabs.map((t) => t.id!), createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: name, color });
    });
  }

  let leftId = leftoversWindowId;
  await attempt("Moving to the Leftovers window", async () => {
    const tabs = await live(actions.leftovers);
    if (!tabs.length) return;
    if (leftId !== null) {
      const win = await chrome.windows.get(leftId).catch(() => null);
      if (!win || win.type !== "normal") leftId = null;
    }
    let rest = tabs;
    if (leftId === null) {
      const [first, ...others] = tabs;
      if (first.groupId !== -1) await chrome.tabs.ungroup(first.id!);
      const win = await chrome.windows.create({ tabId: first.id!, focused: false });
      leftId = win.id ?? null;
      rest = others;
    }
    if (leftId !== null) await moveTo(rest, leftId);
  });

  return { leftoversWindowId: leftId, errors };
}

export async function switchToTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab) await chrome.windows.update(tab.windowId, { focused: true });
}
