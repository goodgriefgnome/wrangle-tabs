import type { GroupInfo, TabInfo, UserGroup } from "./types";

/** Everything a sorter gets: ungrouped tabs to place, plus the groups they could go into. */
export interface SortInput {
  tabs: TabInfo[];
  existingGroups: { group: GroupInfo; tabs: TabInfo[] }[];
  userGroups: UserGroup[];
}

export type SortTarget =
  | { kind: "existing"; groupId: number }
  | { kind: "user"; id: string }
  | { kind: "new"; name: string }
  | { kind: "left" };

/**
 * Decides where each ungrouped tab should go. Stage 1 ships SiteSorter;
 * stage 2 adds a Gemini Nano sorter behind the same interface.
 */
export type ModelEvent =
  | { kind: "input"; items: string[] }
  | { kind: "output"; text: string }
  | { kind: "error"; text: string };

export interface SortOptions {
  /** Aborted when a newer sort supersedes this one. */
  signal?: AbortSignal;
  /** Called as tabs get sorted, for slow sorters. `phase` names a step that has no count. */
  onProgress?: (done: number, total: number, phase?: "grouping") => void;
  /** What a model-based sorter is sending and receiving right now, for display. */
  onModel?: (event: ModelEvent) => void;
}

export interface Sorter {
  /** Shown in the dashboard header, e.g. "Sorted by website". */
  readonly label: string;
  sort(input: SortInput, options?: SortOptions): Promise<Map<number, SortTarget>>;
}
