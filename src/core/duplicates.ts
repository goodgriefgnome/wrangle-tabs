import { normalizeUrl } from "./url";
import type { DuplicateSuggestion, GroupInfo, TabInfo } from "./types";

export interface DuplicateResult {
  duplicates: DuplicateSuggestion[];
  /** Duplicates that are deliberately left alone, explained for the user. */
  notes: string[];
}

/** Which tab of a set to keep: active, then playing audio, then most recently used. */
function best(tabs: TabInfo[]): TabInfo {
  return [...tabs].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(b.audible) - Number(a.audible) ||
      b.lastAccessed - a.lastAccessed ||
      a.id - b.id,
  )[0];
}

/**
 * Two tabs are duplicates when their cleaned-up URLs match, and either their
 * #fragments match too or their titles match. The title check stops
 * "mail.google.com/#inbox" and "#label/receipts" from counting as the same page
 * while still catching "docs/page" vs "docs/page#section".
 */
function sameSets(tabs: TabInfo[]): TabInfo[][] {
  const byBase = new Map<string, { tab: TabInfo; hash: string }[]>();
  for (const tab of tabs) {
    const { base, hash } = normalizeUrl(tab.url);
    const list = byBase.get(base) ?? [];
    list.push({ tab, hash });
    byBase.set(base, list);
  }

  const sets: TabInfo[][] = [];
  for (const list of byBase.values()) {
    if (list.length < 2) continue;
    // Union-find over "same hash or same title" links.
    const parent = list.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.hash === b.hash || a.tab.title === b.tab.title) parent[find(i)] = find(j);
      }
    }
    const comps = new Map<number, TabInfo[]>();
    list.forEach((item, i) => {
      const root = find(i);
      comps.set(root, [...(comps.get(root) ?? []), item.tab]);
    });
    for (const comp of comps.values()) if (comp.length > 1) sets.push(comp);
  }
  return sets;
}

function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Finds tabs to close. Rules:
 * - Pinned tabs are never closed. An unpinned copy of a pinned tab is closed.
 * - Copies inside the same group: one is kept, the rest are closed.
 * - An ungrouped copy of a grouped tab is closed; the group keeps its tab.
 * - Copies in two different groups are left alone (and reported in `notes`).
 */
export function findDuplicates(tabs: TabInfo[], groups: GroupInfo[]): DuplicateResult {
  const groupName = new Map(groups.map((g) => [g.id, g.title || "an unnamed group"]));
  const duplicates: DuplicateSuggestion[] = [];
  const notes: string[] = [];

  for (const set of sameSets(tabs)) {
    const pinned = set.filter((t) => t.pinned);
    const unpinned = set.filter((t) => !t.pinned);
    const ungrouped = unpinned.filter((t) => t.groupId === -1);
    const byGroup = new Map<number, TabInfo[]>();
    for (const t of unpinned) {
      if (t.groupId !== -1) byGroup.set(t.groupId, [...(byGroup.get(t.groupId) ?? []), t]);
    }

    for (const inGroup of byGroup.values()) {
      if (inGroup.length < 2) continue;
      const keep = best(inGroup);
      for (const t of inGroup) if (t !== keep) duplicates.push({ closeId: t.id, keepId: keep.id });
    }

    if (ungrouped.length) {
      const grouped = unpinned.filter((t) => t.groupId !== -1);
      const keep = pinned.length ? best(pinned) : grouped.length ? best(grouped) : best(ungrouped);
      for (const t of ungrouped) if (t !== keep) duplicates.push({ closeId: t.id, keepId: keep.id });
    }

    if (byGroup.size >= 2) {
      const names = [...byGroup.keys()].map((id) => groupName.get(id) ?? "an unnamed group");
      notes.push(`“${set[0].title}” is open in ${joinNames(names)}. Left alone.`);
    }
  }
  return { duplicates, notes };
}
