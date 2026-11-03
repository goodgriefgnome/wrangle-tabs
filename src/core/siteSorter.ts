import { keywordScore, tabText } from "./keywords";
import type { Sorter, SortInput, SortTarget } from "./sorter";
import { siteOf } from "./url";

/**
 * Placeholder sorter used until the AI sorter lands:
 * 1. A tab goes into the user's proposed group whose name and hint share the most words with it.
 * 2. Otherwise, into the existing group that already holds the most tabs from the same site.
 * 3. Otherwise, two or more tabs from one site become a new group named after the site.
 * 4. Everything else goes to the Leftovers window.
 */
export class SiteSorter implements Sorter {
  readonly label = "Sorted by website";

  async sort({ tabs, existingGroups, userGroups }: SortInput): Promise<Map<number, SortTarget>> {
    const result = new Map<number, SortTarget>();
    const rest = [];

    for (const tab of tabs) {
      const text = tabText(tab.title, tab.url);
      let bestId: string | null = null;
      let bestScore = 0;
      for (const g of userGroups) {
        const score = keywordScore(`${g.name} ${g.hint}`, text);
        if (score > bestScore) {
          bestScore = score;
          bestId = g.id;
        }
      }
      if (bestId) result.set(tab.id, { kind: "user", id: bestId });
      else rest.push(tab);
    }

    // site -> groupId -> number of tabs from that site already in the group
    const siteInGroups = new Map<string, Map<number, number>>();
    for (const { group, tabs: inGroup } of existingGroups) {
      for (const t of inGroup) {
        const site = siteOf(t.url);
        if (!site) continue;
        const counts = siteInGroups.get(site) ?? new Map<number, number>();
        counts.set(group.id, (counts.get(group.id) ?? 0) + 1);
        siteInGroups.set(site, counts);
      }
    }

    const bySite = new Map<string | null, number[]>();
    for (const t of rest) {
      const site = siteOf(t.url);
      bySite.set(site, [...(bySite.get(site) ?? []), t.id]);
    }

    for (const [site, ids] of bySite) {
      let target: SortTarget = { kind: "left" };
      const counts = site ? siteInGroups.get(site) : undefined;
      if (counts?.size) {
        const [groupId] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        target = { kind: "existing", groupId };
      } else if (site && ids.length >= 2) {
        target = { kind: "new", name: site };
      }
      for (const id of ids) result.set(id, target);
    }
    return result;
  }
}
