import type { GroupColor } from '../core/types';

export type Destination = { kind: 'close' } | { kind: 'ungrouped' } |
  { kind: 'existing'; groupId: number } | { kind: 'new'; name: string; color: GroupColor };
interface Original { tab: chrome.tabs.Tab; group?: chrome.tabGroups.TabGroup; after?: chrome.tabs.Tab; closed?: boolean }
export interface UndoRecord { originals: Original[]; groupChange?: { before: chrome.tabGroups.TabGroup; after: chrome.tabGroups.TabGroup } }
export interface Outcome { succeeded: number[]; errors: string[]; undo: UndoRecord }
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Revalidate each tab and record each successful mutation, including moves before a failed group call. */
export async function execute(ids: number[], destination: Destination): Promise<Outcome> {
  const result: Outcome = { succeeded: [], errors: [], undo: { originals: [] } };
  let target = destination.kind === 'existing' ? await chrome.tabGroups.get(destination.groupId) : undefined;
  let newWindow: number | undefined;
  if (destination.kind === 'new') {
    const candidates = await Promise.all(ids.map(id => chrome.tabs.get(id).catch(() => undefined)));
    const counts = new Map<number, number>();
    for (const tab of candidates) if (tab && !tab.pinned) counts.set(tab.windowId, (counts.get(tab.windowId) ?? 0) + 1);
    newWindow = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  for (const id of new Set(ids)) {
    let original: Original | undefined;
    try {
      const tab = await chrome.tabs.get(id);
      if (tab.pinned) throw new Error('Pinned tabs are protected');
      original = { tab, group: tab.groupId !== -1 ? await chrome.tabGroups.get(tab.groupId).catch(() => undefined) : undefined };
      if (destination.kind === 'close') {
        await chrome.tabs.remove(id);
        original.closed = true;
      } else if (destination.kind === 'ungrouped') {
        await chrome.tabs.ungroup(id);
      } else {
        const windowId = target?.windowId ?? newWindow ?? tab.windowId;
        newWindow = windowId;
        if (tab.windowId !== windowId) await chrome.tabs.move(id, { windowId, index: -1 });
        if (target) await chrome.tabs.group({ groupId: target.id, tabIds: [id] });
        else {
          const groupId = await chrome.tabs.group({ tabIds: [id], createProperties: { windowId } });
          // Remember the group even if setting its title/color fails.
          target = await chrome.tabGroups.get(groupId);
          if (destination.kind === 'new') await chrome.tabGroups.update(groupId, { title: destination.name, color: destination.color });
        }
      }
      result.succeeded.push(id);
    } catch (e) { result.errors.push(`Tab ${id}: ${message(e)}`); }
    if (original) {
      original.after = original.closed ? undefined : await chrome.tabs.get(id).catch(() => undefined);
      if (result.succeeded.includes(id) || original.closed || original.after && (original.after.groupId !== original.tab.groupId || original.after.windowId !== original.tab.windowId || original.after.index !== original.tab.index)) result.undo.originals.push(original);
    }
  }
  return result;
}

/** Restore only affected tabs that still match our outcome; don't overwrite subsequent user moves. */
export async function restore(record: UndoRecord): Promise<{ restored: number[]; errors: string[] }> {
  const restored: number[] = [], errors: string[] = [];
  const recreated = new Map<number, number>();
  for (const entry of [...record.originals].sort((a,b) => a.tab.windowId - b.tab.windowId || a.tab.index - b.tab.index)) {
    const { tab, group, after } = entry;
    try {
      await chrome.windows.get(tab.windowId);
      let id = tab.id!;
      if (entry.closed) {
        const opened = await chrome.tabs.create({ windowId: tab.windowId, url: tab.url, index: tab.index, active: false });
        id = opened.id!;
      } else {
        const current = await chrome.tabs.get(id);
        if (current.pinned || current.windowId !== after?.windowId || current.groupId !== after?.groupId) throw new Error('Changed since this action; left alone');
        await chrome.tabs.ungroup(id);
        await chrome.tabs.move(id, { windowId: tab.windowId, index: tab.index });
      }
      if (group) {
        let groupId = recreated.get(group.id);
        if (groupId === undefined) groupId = (await chrome.tabGroups.get(group.id).catch(() => undefined))?.id;
        if (groupId === undefined) {
          groupId = await chrome.tabs.group({ tabIds: [id], createProperties: { windowId: tab.windowId } });
          await chrome.tabGroups.update(groupId, { title: group.title, color: group.color });
          recreated.set(group.id, groupId);
        } else await chrome.tabs.group({ groupId, tabIds: [id] });
      }
      restored.push(tab.id!);
    } catch (e) { errors.push(`Tab ${tab.id}: ${message(e)}`); }
  }
  if (record.groupChange) {
    const { before, after } = record.groupChange;
    try {
      const current = await chrome.tabGroups.get(before.id);
      if (current.title !== after.title || current.color !== after.color) throw new Error('Group changed since this action; left alone');
      await chrome.tabGroups.update(before.id, { title: before.title, color: before.color });
      record.groupChange = undefined;
    } catch (e) { errors.push(message(e)); }
  }
  return { restored, errors };
}
