import { beforeEach, expect, test, vi } from 'vitest';
import { execute, restore } from '../src/chrome/direct';

let tabs: Map<number, chrome.tabs.Tab>;
let groups: Map<number, chrome.tabGroups.TabGroup>;
let failGroup: number | null;
const get = async (id: number) => { const tab = tabs.get(id); if (!tab) throw Error('Missing tab'); return { ...tab }; };
beforeEach(() => {
  tabs = new Map([1,2,3].map(id => [id, { id, windowId: 1, index: id-1, groupId: -1, pinned: id === 3, url: `https://example.com/${id}`, active: false } as chrome.tabs.Tab]));
  groups = new Map([[10, { id: 10, windowId: 2, title: 'Existing', color: 'blue', collapsed: false }]]);
  failGroup = null;
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(get),
      remove: vi.fn(async (id: number) => { tabs.delete(id); }),
      move: vi.fn(async (id: number, change: { windowId: number; index: number }) => { Object.assign(tabs.get(id)!, { windowId: change.windowId, index: change.index }); }),
      group: vi.fn(async (args: { groupId?: number; tabIds: number[]; createProperties?: { windowId: number } }) => {
        if (args.tabIds.includes(failGroup!)) throw Error('Group rejected');
        const id = args.groupId ?? 20;
        if (!groups.has(id)) groups.set(id, { id, windowId: args.createProperties!.windowId, title: '', color: 'grey', collapsed: false });
        for (const tabId of args.tabIds) tabs.get(tabId)!.groupId = id;
        return id;
      }),
      ungroup: vi.fn(async (id: number) => { tabs.get(id)!.groupId = -1; }),
      create: vi.fn(async (args: object) => { const tab = { ...tabs.get(2)!, ...args, id: 99, groupId: -1 }; tabs.set(99, tab); return tab; }),
    },
    tabGroups: {
      get: vi.fn(async (id: number) => { const group = groups.get(id); if (!group) throw Error('Missing group'); return { ...group }; }),
      update: vi.fn(async (id: number, change: object) => { Object.assign(groups.get(id)!, change); return groups.get(id)!; }),
    },
    windows: { get: vi.fn(async (id: number) => ({ id })) },
  });
});

test('moving a correction creates a real group using only explicitly chosen tabs', async () => {
  const result = await execute([1], { kind: 'new', name: 'Reading', color: 'green' });
  expect(result.succeeded).toEqual([1]);
  expect(tabs.get(1)?.groupId).toBe(20);
  expect(tabs.get(2)?.groupId).toBe(-1);
  expect(groups.get(20)?.title).toBe('Reading');
  expect((await restore(result.undo)).errors).toEqual([]);
  expect(tabs.get(1)?.groupId).toBe(-1);
  expect(tabs.get(1)?.index).toBe(0);
});

test('partial failures preserve failed work, protect pinned tabs and record intermediate cross-window moves', async () => {
  failGroup = 2;
  const result = await execute([1,2,3,404], { kind: 'existing', groupId: 10 });
  expect(result.succeeded).toEqual([1]);
  expect(result.errors).toHaveLength(3);
  expect(result.undo.originals.map(o => o.tab.id)).toEqual([1,2]);
  expect(tabs.get(3)?.windowId).toBe(1);
  failGroup = null;
  await restore(result.undo);
  expect(tabs.get(1)?.windowId).toBe(1);
  expect(tabs.get(2)?.windowId).toBe(1);
});

test('close protects pinned tabs and Undo reopens the URL', async () => {
  const result = await execute([1,3], { kind: 'close' });
  expect(result.succeeded).toEqual([1]);
  expect(tabs.has(3)).toBe(true);
  await restore(result.undo);
  expect(tabs.get(99)?.url).toBe('https://example.com/1');
});

test('Undo leaves unrelated later group changes alone', async () => {
  const result = await execute([1], { kind: 'existing', groupId: 10 });
  tabs.get(1)!.groupId = 777;
  expect((await restore(result.undo)).errors).toHaveLength(1);
  expect(tabs.get(1)?.groupId).toBe(777);
});

test('missing destination fails before mutating any tab', async () => {
  await expect(execute([1], { kind: 'existing', groupId: 999 })).rejects.toThrow('Missing group');
  expect(tabs.get(1)?.groupId).toBe(-1);
});

test('leaving an already ungrouped tab records Undo so manual review intent can be reversed', async () => {
  const result = await execute([1], { kind: 'ungrouped' });
  expect(result.succeeded).toEqual([1]);
  expect(result.undo.originals).toHaveLength(1);
  expect((await restore(result.undo)).restored).toEqual([1]);
});

test('Undo can restore the metadata of an existing group without touching tabs', async () => {
  const before = { ...groups.get(10)! };
  groups.get(10)!.title = 'Renamed';
  const result = await restore({ originals: [], groupChange: { before, after: { ...groups.get(10)! } } });
  expect(result.errors).toEqual([]);
  expect(groups.get(10)?.title).toBe('Existing');
  expect(chrome.tabs.move).not.toHaveBeenCalled();
});
