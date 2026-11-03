import type { UserGroup } from "../core/types";

/** "ai" uses Chrome's built-in model when it's available; "site" always sorts by website. */
export type SorterPref = "ai" | "site";

interface Stored {
  userGroups?: UserGroup[];
  leftoversWindowId?: number | null;
  sorterPref?: SorterPref;
}

export async function loadState(): Promise<{ userGroups: UserGroup[]; leftoversWindowId: number | null; sorterPref: SorterPref }> {
  const s = (await chrome.storage.local.get(["userGroups", "leftoversWindowId", "sorterPref"])) as Stored;
  return { userGroups: s.userGroups ?? [], leftoversWindowId: s.leftoversWindowId ?? null, sorterPref: s.sorterPref ?? "ai" };
}

export function saveUserGroups(userGroups: UserGroup[]): Promise<void> {
  return chrome.storage.local.set({ userGroups });
}

export function saveLeftoversWindowId(id: number | null): Promise<void> {
  return chrome.storage.local.set({ leftoversWindowId: id });
}

export function saveSorterPref(sorterPref: SorterPref): Promise<void> {
  return chrome.storage.local.set({ sorterPref });
}
