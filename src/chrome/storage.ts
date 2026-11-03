import type { UserGroup } from "../core/types";

interface Stored {
  userGroups?: UserGroup[];
  leftoversWindowId?: number | null;
}

export async function loadState(): Promise<{ userGroups: UserGroup[]; leftoversWindowId: number | null }> {
  const s = (await chrome.storage.local.get(["userGroups", "leftoversWindowId"])) as Stored;
  return { userGroups: s.userGroups ?? [], leftoversWindowId: s.leftoversWindowId ?? null };
}

export function saveUserGroups(userGroups: UserGroup[]): Promise<void> {
  return chrome.storage.local.set({ userGroups });
}

export function saveLeftoversWindowId(id: number | null): Promise<void> {
  return chrome.storage.local.set({ leftoversWindowId: id });
}
