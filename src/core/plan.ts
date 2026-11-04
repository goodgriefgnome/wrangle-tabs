import { findDuplicates } from "./duplicates";
import type { Sorter, SortInput, SortOptions, SortTarget } from "./sorter";
import {
  GROUP_COLORS,
  type GroupColor,
  type Snapshot,
  type TabInfo,
  type UserGroup,
} from "./types";

/**
 * Where the user moved a tab by hand. Hand moves survive re-sorting.
 * New-group keys are "user:<id>" for proposed groups and "ai:<name>" for suggested ones.
 */
export type ManualTarget =
  | { kind: "existing"; groupId: number }
  | { kind: "new"; key: string }
  | { kind: "left" }
  | { kind: "close" };

/** A tab in the Close group: a duplicate (with the copy that stays open) or one the user marked. */
export interface CloseItem {
  tabId: number;
  keepId?: number;
}

export interface NewGroupPlan {
  /** "user:<id>" or "ai:<name>". */
  key: string;
  name: string;
  color: GroupColor;
  hint: string;
  /** True for groups the user proposed. */
  mine: boolean;
  tabIds: number[];
}

export interface Plan {
  close: CloseItem[];
  /** Duplicates that are left alone, explained. */
  notes: string[];
  addToExisting: { groupId: number; tabIds: number[] }[];
  newGroups: NewGroupPlan[];
  leftovers: number[];
  /** Tabs the sorter hasn't placed yet, with the topic they're heading for when it has only them so far. */
  unsorted: { tabId: number; topic?: string }[];
}

export interface PlanInput {
  snapshot: Snapshot;
  userGroups: UserGroup[];
  manual: Map<number, ManualTarget>;
  /** Renames and recolors of suggested ("ai:") groups. */
  aiOverrides?: Map<string, { name?: string; color?: GroupColor }>;
}

const byPosition = (a: TabInfo, b: TabInfo) => a.windowId - b.windowId || a.index - b.index;

/** Sorts the tabs that need it, then builds the plan, in one go. */
export async function sortAndPlan(input: PlanInput, sorter: Sorter, options?: SortOptions): Promise<Plan> {
  return buildPlan(input, await sorter.sort(sortInputFor(input), options));
}

/** What the sorter should look at: ungrouped tabs that aren't closing or placed by hand, and the groups. */
export function sortInputFor(input: PlanInput): SortInput {
  const { candidates, handPlaced } = prepare(input);
  const { tabs, groups } = input.snapshot;
  return {
    tabs: candidates.filter((t) => !handPlaced.has(t.id)),
    existingGroups: groups.map((group) => ({ group, tabs: tabs.filter((t) => t.groupId === group.id) })),
    userGroups: input.userGroups,
  };
}

function prepare({ snapshot, userGroups, manual }: PlanInput) {
  const { tabs, groups } = snapshot;
  const found = findDuplicates(tabs, groups);
  // A duplicate the user moved somewhere else is kept open.
  const close: CloseItem[] = found.duplicates
    .filter((d) => !manual.has(d.closeId) || manual.get(d.closeId)!.kind === "close")
    .map((d) => ({ tabId: d.closeId, keepId: d.keepId }));
  const closing = new Set(close.map((c) => c.tabId));
  for (const t of tabs) {
    if (!t.pinned && manual.get(t.id)?.kind === "close" && !closing.has(t.id)) {
      close.push({ tabId: t.id });
      closing.add(t.id);
    }
  }

  const groupIds = new Set(groups.map((g) => g.id));
  const userIds = new Set(userGroups.map((g) => g.id));
  const candidates = tabs
    .filter((t) => !t.pinned && t.groupId === -1 && !closing.has(t.id))
    .sort(byPosition);

  const handPlaced = new Map<number, ManualTarget>();
  for (const t of candidates) {
    const m = manual.get(t.id);
    if (!m) continue;
    if (m.kind === "close") continue;
    if (m.kind === "existing" && !groupIds.has(m.groupId)) continue;
    if (m.kind === "new" && m.key.startsWith("user:") && !userIds.has(m.key.slice(5))) continue;
    handPlaced.set(t.id, m);
  }
  return { found, close, candidates, handPlaced, groupIds, userIds };
}

/**
 * Builds the plan from the sorter's answers. Tabs with no answer go to Leftovers, or, when they're
 * in `waiting` (tab id -> tentative topic, if any), to the unsorted list.
 */
export function buildPlan(
  input: PlanInput,
  sorted: Map<number, SortTarget>,
  waiting: Map<number, string | undefined> = new Map(),
): Plan {
  const { snapshot, userGroups, aiOverrides } = input;
  const { groups, leftoversWindowId } = snapshot;
  const { found, close, candidates, handPlaced, groupIds, userIds } = prepare(input);
  const notes = found.notes;
  const toSort = candidates.filter((t) => !handPlaced.has(t.id));
  const unsorted: Plan["unsorted"] = [];

  const existing = new Map<number, number[]>();
  const fresh = new Map<string, number[]>();
  const aiNames = new Map<string, string>();
  const leftovers: number[] = [];

  const place = (tab: TabInfo, target: ManualTarget) => {
    if (target.kind === "existing") existing.set(target.groupId, [...(existing.get(target.groupId) ?? []), tab.id]);
    else if (target.kind === "new") fresh.set(target.key, [...(fresh.get(target.key) ?? []), tab.id]);
    // A tab already in the Leftovers window needs no move.
    else if (tab.windowId !== leftoversWindowId) leftovers.push(tab.id);
  };

  const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const existingByName = new Map(groups.filter((g) => g.title).map((g) => [loose(g.title), g.id]));
  for (const tab of toSort) {
    if (!sorted.has(tab.id) && waiting.has(tab.id)) {
      unsorted.push({ tabId: tab.id, topic: waiting.get(tab.id) });
      continue;
    }
    const s = sorted.get(tab.id) ?? { kind: "left" as const };
    if (s.kind === "existing" && groupIds.has(s.groupId)) place(tab, s);
    else if (s.kind === "user" && userIds.has(s.id)) place(tab, { kind: "new", key: `user:${s.id}` });
    else if (s.kind === "new" && existingByName.has(loose(s.name))) {
      // A suggested topic that has since become a real group: add to that group.
      place(tab, { kind: "existing", groupId: existingByName.get(loose(s.name))! });
    } else if (s.kind === "new") {
      const key = `ai:${s.name}`;
      aiNames.set(key, s.name);
      place(tab, { kind: "new", key });
    } else place(tab, { kind: "left" });
  }
  for (const tab of candidates) {
    const m = handPlaced.get(tab.id);
    if (!m) continue;
    // A hand move into a suggested group that no longer exists falls back to Leftovers.
    if (m.kind === "new" && m.key.startsWith("ai:") && !aiNames.has(m.key)) place(tab, { kind: "left" });
    else place(tab, m);
  }

  const tabOrder = new Map(candidates.map((t, i) => [t.id, i]));
  const ordered = (ids: number[]) => [...ids].sort((a, b) => tabOrder.get(a)! - tabOrder.get(b)!);

  const used = new Set<GroupColor>([...groups.map((g) => g.color), ...userGroups.map((g) => g.color)]);
  const palette = GROUP_COLORS.filter((c) => c !== "grey");
  let nextColor = 0;
  const pickColor = (): GroupColor => {
    const free = palette.find((c) => !used.has(c));
    const color = free ?? palette[nextColor++ % palette.length];
    used.add(color);
    return color;
  };

  const newGroups: NewGroupPlan[] = userGroups.map((g) => ({
    key: `user:${g.id}`,
    name: g.name,
    color: g.color,
    hint: g.hint,
    mine: true,
    tabIds: ordered(fresh.get(`user:${g.id}`) ?? []),
  }));
  for (const [key, name] of aiNames) {
    const ids = fresh.get(key);
    if (!ids?.length) continue;
    const override = aiOverrides?.get(key);
    newGroups.push({
      key,
      name: override?.name ?? name,
      color: override?.color ?? pickColor(),
      hint: "",
      mine: false,
      tabIds: ordered(ids),
    });
  }

  return {
    close,
    notes,
    addToExisting: groups
      .filter((g) => existing.has(g.id))
      .map((g) => ({ groupId: g.id, tabIds: ordered(existing.get(g.id)!) })),
    newGroups,
    leftovers: ordered(leftovers),
    unsorted,
  };
}
