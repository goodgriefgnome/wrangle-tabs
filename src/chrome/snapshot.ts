import type { GroupColor, GroupInfo, Snapshot, TabInfo } from "../core/types";

export const DASHBOARD_URL = chrome.runtime.getURL("dashboard.html");

/** Reads every tab and group in normal (non-popup) windows, leaving out the dashboard itself. */
export async function takeSnapshot(leftoversWindowId: number | null): Promise<Snapshot> {
  const rawTabs = await chrome.tabs.query({ windowType: "normal" });
  const tabs: TabInfo[] = rawTabs
    .filter((t) => t.id !== undefined && !(t.url ?? "").startsWith(DASHBOARD_URL))
    .map((t) => ({
      id: t.id!,
      windowId: t.windowId,
      index: t.index,
      title: t.title || t.url || "Untitled",
      url: t.url || t.pendingUrl || "",
      groupId: t.groupId ?? -1,
      pinned: t.pinned,
      active: t.active,
      audible: t.audible ?? false,
      lastAccessed: (t as { lastAccessed?: number }).lastAccessed ?? 0,
    }));

  const windowIds = new Set(rawTabs.map((t) => t.windowId));
  const groups: GroupInfo[] = (await chrome.tabGroups.query({}))
    .filter((g) => windowIds.has(g.windowId))
    .map((g) => ({ id: g.id, windowId: g.windowId, title: g.title ?? "", color: g.color as GroupColor }));

  return {
    tabs,
    groups,
    leftoversWindowId: leftoversWindowId !== null && windowIds.has(leftoversWindowId) ? leftoversWindowId : null,
  };
}
