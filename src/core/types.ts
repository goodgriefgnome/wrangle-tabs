/** Chrome's tab-group colors. */
export type GroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export const GROUP_COLORS: readonly GroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

/** The parts of a Chrome tab the extension looks at. */
export interface TabInfo {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  /** -1 when the tab is not in a group. */
  groupId: number;
  pinned: boolean;
  active: boolean;
  audible: boolean;
  /** Milliseconds since epoch; 0 when unknown. */
  lastAccessed: number;
}

export interface GroupInfo {
  id: number;
  windowId: number;
  title: string;
  color: GroupColor;
}

export interface Snapshot {
  tabs: TabInfo[];
  groups: GroupInfo[];
  /** The window this extension created for leftover tabs, if it still exists. */
  leftoversWindowId: number | null;
}

/** A group the user proposed on the dashboard. Kept until applied or deleted. */
export interface UserGroup {
  id: string;
  name: string;
  hint: string;
  color: GroupColor;
}

export interface DuplicateSuggestion {
  closeId: number;
  keepId: number;
}
