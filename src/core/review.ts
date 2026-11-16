import type { Plan } from './plan';
import type { Snapshot } from './types';

/** Session decisions are tied to the tab and its URL; navigation makes it eligible again. */
export function unresolvedSnapshot(snapshot: Snapshot, resolved: ReadonlyMap<number, string>): Snapshot {
  return { ...snapshot, tabs: snapshot.tabs.filter(tab => resolved.get(tab.id) !== tab.url) };
}

/** Keep reviewed groups and their remaining rows in place; append incoming proposals. */
export function stableReview(previous: Plan | null, next: Plan): Plan {
  if (!previous) return next;
  const ordered = <T>(old: T[], incoming: T[], key: (item: T) => string | number): T[] => {
    const pending = new Map(incoming.map(item => [key(item), item]));
    const result: T[] = [];
    for (const item of old) {
      const value = pending.get(key(item));
      if (value !== undefined) { result.push(value); pending.delete(key(item)); }
    }
    return [...result, ...pending.values()];
  };
  const ids = (old: number[], incoming: number[]) => ordered(old, incoming, id => id);
  return {
    ...next,
    close: ordered(previous.close, next.close, item => item.tabId),
    addToExisting: ordered(previous.addToExisting, next.addToExisting, item => item.groupId).map(group => ({ ...group, tabIds: ids(previous.addToExisting.find(old => old.groupId === group.groupId)?.tabIds ?? [], group.tabIds) })),
    newGroups: ordered(previous.newGroups, next.newGroups, item => item.key).map(group => ({ ...group, tabIds: ids(previous.newGroups.find(old => old.key === group.key)?.tabIds ?? [], group.tabIds) })),
    leftovers: ids(previous.leftovers, next.leftovers),
    unsorted: ordered(previous.unsorted, next.unsorted, item => item.tabId),
  };
}
