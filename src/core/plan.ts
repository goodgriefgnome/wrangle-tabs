import { findDuplicates } from "./duplicates";
import type { Sorter } from "./sorter";
import {
  GROUP_COLORS,
  type DuplicateSuggestion,
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
  | { kind: "left" };

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
  duplicates: DuplicateSuggestion[];
  notes: string[];
  addToExisting: { groupId: number; tabIds: number[] }[];
  newGroups: NewGroupPlan[];
  leftovers: number[];
}

export interface PlanInput {
  snapshot: Snapshot;
  userGroups: UserGroup[];
  manual: Map<number, ManualTarget>;
  /** Renames and recolors of suggested ("ai:") groups. */
  aiOverrides?: Map<string, { name?: string; color?: GroupColor }>;
  sorter: Sorter;
}

const byPosition = (a: TabInfo, b: TabInfo) => a.windowId - b.windowId || a.index - b.index;

export async function buildPlan({ snapshot, userGroups, manual, aiOverrides, sorter }: PlanInput): Promise<Plan> {
  const { tabs, groups, leftoversWindowId } = snapshot;
  const { duplicates, notes } = findDuplicates(tabs, groups);
  const closing = new Set(duplicates.map((d) => d.closeId));

  const groupIds = new Set(groups.map((g) => g.id));
  const userIds = new Set(userGroups.map((g) => g.id));
  const candidates = tabs
    .filter((t) => !t.pinned && t.groupId === -1 && !closing.has(t.id))
    .sort(byPosition);

  const handPlaced = new Map<number, ManualTarget>();
  for (const t of candidates) {
    const m = manual.get(t.id);
    if (!m) continue;
    if (m.kind === "existing" && !groupIds.has(m.groupId)) continue;
    if (m.kind === "new" && m.key.startsWith("user:") && !userIds.has(m.key.slice(5))) continue;
    handPlaced.set(t.id, m);
  }

  const toSort = candidates.filter((t) => !handPlaced.has(t.id));
  const sorted = await sorter.sort({
    tabs: toSort,
    existingGroups: groups.map((group) => ({ group, tabs: tabs.filter((t) => t.groupId === group.id) })),
    userGroups,
  });

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

  for (const tab of toSort) {
    const s = sorted.get(tab.id) ?? { kind: "left" as const };
    if (s.kind === "existing" && groupIds.has(s.groupId)) place(tab, s);
    else if (s.kind === "user" && userIds.has(s.id)) place(tab, { kind: "new", key: `user:${s.id}` });
    else if (s.kind === "new") {
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
    duplicates,
    notes,
    addToExisting: groups
      .filter((g) => existing.has(g.id))
      .map((g) => ({ groupId: g.id, tabIds: ordered(existing.get(g.id)!) })),
    newGroups,
    leftovers: ordered(leftovers),
  };
}
