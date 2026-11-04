import { describe, expect, it } from "vitest";
import { buildPlan, type ManualTarget } from "../src/core/plan";
import { SiteSorter } from "../src/core/siteSorter";
import type { Snapshot, UserGroup } from "../src/core/types";
import { group, tab } from "./helpers";

const sorter = new SiteSorter();
const plan = (snapshot: Snapshot, userGroups: UserGroup[] = [], manual = new Map<number, ManualTarget>()) =>
  buildPlan({ snapshot, userGroups, manual, sorter });

describe("buildPlan", () => {
  it("adds tabs to the existing group that already holds their site", async () => {
    const inGroup = tab({ url: "https://booking.com/a", groupId: 5 });
    const loose = tab({ url: "https://booking.com/b", windowId: 2 });
    const p = await plan({ tabs: [inGroup, loose], groups: [group({ id: 5 })], leftoversWindowId: null });
    expect(p.addToExisting).toEqual([{ groupId: 5, tabIds: [loose.id] }]);
  });

  it("groups two or more tabs from one site and sends the rest to Leftovers", async () => {
    const a = tab({ url: "https://react.dev/a" });
    const b = tab({ url: "https://react.dev/b" });
    const c = tab({ url: "https://weather.gov/" });
    const p = await plan({ tabs: [a, b, c], groups: [], leftoversWindowId: null });
    expect(p.newGroups.map((g) => [g.name, g.tabIds])).toEqual([["react.dev", [a.id, b.id]]]);
    expect(p.leftovers).toEqual([c.id]);
  });

  it("never touches pinned or grouped tabs, or tabs about to be closed", async () => {
    const pinned = tab({ url: "https://mail.google.com/", pinned: true });
    const grouped = tab({ url: "https://x.com/1", groupId: 3 });
    const dupe = tab({ url: "https://mail.google.com/" });
    const p = await plan({ tabs: [pinned, grouped, dupe], groups: [group({ id: 3 })], leftoversWindowId: null });
    expect(p.close).toEqual([{ tabId: dupe.id, keepId: pinned.id }]);
    expect(p.leftovers).toEqual([]);
    expect(p.newGroups).toEqual([]);
    expect(p.addToExisting).toEqual([]);
  });

  it("fills proposed groups first and keeps them even when empty", async () => {
    const hn = tab({ url: "https://news.ycombinator.com/item?id=1", title: "Show HN: thing – Hacker News" });
    const wiki = tab({ url: "https://en.wikipedia.org/wiki/Lighthouse", title: "Lighthouse – Wikipedia" });
    const reading: UserGroup = { id: "r", name: "Reading", hint: "hacker news, wikipedia", color: "pink" };
    const empty: UserGroup = { id: "w", name: "Woodworking", hint: "", color: "green" };
    const p = await plan({ tabs: [hn, wiki], groups: [], leftoversWindowId: null }, [reading, empty]);
    expect(p.newGroups.map((g) => [g.key, g.mine, g.tabIds])).toEqual([
      ["user:r", true, [hn.id, wiki.id]],
      ["user:w", true, []],
    ]);
    expect(p.leftovers).toEqual([]);
  });

  it("keeps hand moves when re-sorting", async () => {
    const a = tab({ url: "https://react.dev/a" });
    const b = tab({ url: "https://react.dev/b" });
    const c = tab({ url: "https://react.dev/c" });
    const manual = new Map<number, ManualTarget>([[c.id, { kind: "left" }]]);
    const p = await plan({ tabs: [a, b, c], groups: [], leftoversWindowId: null }, [], manual);
    expect(p.newGroups[0].tabIds).toEqual([a.id, b.id]);
    expect(p.leftovers).toEqual([c.id]);
  });

  it("drops hand moves into groups that no longer exist", async () => {
    const a = tab({ url: "https://weather.gov/" });
    const manual = new Map<number, ManualTarget>([[a.id, { kind: "existing", groupId: 99 }]]);
    const p = await plan({ tabs: [a], groups: [], leftoversWindowId: null }, [], manual);
    expect(p.leftovers).toEqual([a.id]);
  });

  it("doesn't suggest moving tabs that are already in the Leftovers window", async () => {
    const a = tab({ url: "https://weather.gov/", windowId: 9 });
    const p = await plan({ tabs: [a], groups: [], leftoversWindowId: 9 });
    expect(p.leftovers).toEqual([]);
  });

  it("gives suggested groups colors that existing groups don't use", async () => {
    const a = tab({ url: "https://react.dev/a" });
    const b = tab({ url: "https://react.dev/b" });
    const g = tab({ url: "https://z.com/", groupId: 1 });
    const p = await plan({ tabs: [a, b, g], groups: [group({ id: 1, color: "blue" })], leftoversWindowId: null });
    expect(p.newGroups[0].color).not.toBe("blue");
  });

  it("puts tabs marked for closing in the Close group, and keeps duplicates the user moved", async () => {
    const a = tab({ url: "https://react.dev/a" });
    const b = tab({ url: "https://react.dev/a" });
    const c = tab({ url: "https://react.dev/c" });
    const marked = tab({ url: "https://weather.gov/" });
    const keep = b.lastAccessed >= a.lastAccessed ? a : b;
    const dupe = keep === a ? b : a;
    const manual = new Map<number, ManualTarget>([[marked.id, { kind: "close" }]]);
    let p = await plan({ tabs: [a, b, c, marked], groups: [], leftoversWindowId: null }, [], manual);
    expect(p.close).toEqual([{ tabId: dupe.id, keepId: keep.id }, { tabId: marked.id }]);
    expect(p.leftovers).not.toContain(marked.id);

    manual.set(dupe.id, { kind: "left" });
    p = await plan({ tabs: [a, b, c, marked], groups: [], leftoversWindowId: null }, [], manual);
    expect(p.close).toEqual([{ tabId: marked.id }]);
    expect(p.leftovers).toContain(dupe.id);
  });

  it("adds tabs to an existing group when a suggested topic has since become that group", async () => {
    const a = tab({ url: "https://react.dev/a" });
    const b = tab({ url: "https://react.dev/b" });
    const p = await plan({ tabs: [a, b], groups: [group({ id: 4, title: "React.dev" })], leftoversWindowId: null });
    expect(p.addToExisting).toEqual([{ groupId: 4, tabIds: [a.id, b.id] }]);
    expect(p.newGroups).toEqual([]);
  });
});
