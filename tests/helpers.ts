import type { GroupInfo, TabInfo } from "../src/core/types";

let nextId = 1;
export function tab(p: Partial<TabInfo> & { url: string }): TabInfo {
  const id = p.id ?? nextId++;
  return {
    id,
    windowId: 1,
    index: id,
    title: p.title ?? p.url,
    groupId: -1,
    pinned: false,
    active: false,
    audible: false,
    lastAccessed: 0,
    ...p,
  };
}

export function group(p: Partial<GroupInfo> & { id: number }): GroupInfo {
  return { windowId: 1, title: `Group ${p.id}`, color: "blue", ...p };
}
