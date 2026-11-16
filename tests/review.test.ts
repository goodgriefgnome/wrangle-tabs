import { expect, test } from 'vitest';
import { stableReview, unresolvedSnapshot } from '../src/core/review';
import { buildPlan, sortInputFor } from '../src/core/plan';
import type { Plan } from '../src/core/plan';
const base = (): Plan => ({ close: [], notes: [], addToExisting: [], newGroups: [], leftovers: [], unsorted: [] });
test('imports append groups and rows without reordering reviewed proposals or duplicating arrivals', () => {
  const group = (key: string, tabIds: number[]) => ({ key, tabIds, name: key, color: 'blue' as const, hint: '', mine: false });
  const old = { ...base(), newGroups: [group('B', [4,2]), group('A', [3])], unsorted: [{ tabId: 1 }] };
  const incoming = { ...base(), newGroups: [group('C', [7]), group('A', [3,1]), group('B', [2,4,6])] };
  const result = stableReview(old, incoming);
  expect(result.newGroups.map(g => g.key)).toEqual(['B','A','C']);
  expect(result.newGroups[0].tabIds).toEqual([4,2,6]);
  expect(stableReview(result, incoming)).toEqual(result);
});
test('manual keep-ungrouped intent survives stale AI answers and repeated sorting', () => {
  const tab = { id: 1, windowId: 1, index: 0, title: 'Tab', url: 'https://example.com', groupId: -1, pinned: false, active: false, audible: false, lastAccessed: 0 };
  const input = { snapshot: { tabs: [tab], groups: [], leftoversWindowId: null }, userGroups: [], manual: new Map([[1, { kind: 'left' as const }]]) };
  expect(sortInputFor(input).tabs).toEqual([]);
  expect(buildPlan(input, new Map([[1, { kind: 'new', name: 'Stale' }]])).newGroups).toEqual([]);
});

test('resolved direct decisions exclude stale AI proposals through refresh, import and resort, until navigation', () => {
  const tab = { id: 1, windowId: 1, index: 0, title: 'Tab', url: 'https://example.com', groupId: -1, pinned: false, active: false, audible: false, lastAccessed: 0 };
  const resolved = new Map([[1, tab.url]]);
  const snapshot = { tabs: [tab], groups: [], leftoversWindowId: null };
  const input = { snapshot: unresolvedSnapshot(snapshot, resolved), userGroups: [], manual: new Map() };
  const stale = new Map([[1, { kind: 'new' as const, name: 'Stale' }]]);
  expect(sortInputFor(input).tabs).toEqual([]);
  expect(buildPlan(input, stale).newGroups).toEqual([]);
  expect(unresolvedSnapshot({ ...snapshot, tabs: [{ ...tab, url: 'https://example.com/new' }] }, resolved).tabs).toHaveLength(1);
});
