import { describe, expect, it } from "vitest";
import { findDuplicates } from "../src/core/duplicates";
import { group, tab } from "./helpers";

describe("findDuplicates", () => {
  it("closes all but the most recently used ungrouped copy", () => {
    const a = tab({ url: "https://a.com/x", lastAccessed: 1 });
    const b = tab({ url: "https://a.com/x?utm_source=z", lastAccessed: 5 });
    const c = tab({ url: "https://a.com/x/", lastAccessed: 3 });
    const { duplicates } = findDuplicates([a, b, c], []);
    expect(duplicates).toEqual([
      { closeId: a.id, keepId: b.id },
      { closeId: c.id, keepId: b.id },
    ]);
  });

  it("prefers the active tab", () => {
    const a = tab({ url: "https://a.com/", active: true, lastAccessed: 1 });
    const b = tab({ url: "https://a.com/", lastAccessed: 9 });
    expect(findDuplicates([a, b], []).duplicates).toEqual([{ closeId: b.id, keepId: a.id }]);
  });

  it("ignores the #fragment only when titles match", () => {
    const r1 = tab({ url: "https://react.dev/useEffect", title: "useEffect – React", lastAccessed: 2 });
    const r2 = tab({ url: "https://react.dev/useEffect#cleanup", title: "useEffect – React" });
    const g1 = tab({ url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox – Gmail" });
    const g2 = tab({ url: "https://mail.google.com/mail/u/0/#label/receipts", title: "Receipts – Gmail" });
    const { duplicates } = findDuplicates([r1, r2, g1, g2], []);
    expect(duplicates).toEqual([{ closeId: r2.id, keepId: r1.id }]);
  });

  it("keeps the pinned copy and never closes pinned tabs", () => {
    const p = tab({ url: "https://mail.google.com/", pinned: true });
    const p2 = tab({ url: "https://mail.google.com/", pinned: true });
    const u = tab({ url: "https://mail.google.com/", lastAccessed: 99, active: true });
    const { duplicates } = findDuplicates([p, p2, u], []);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].closeId).toBe(u.id);
    expect([p.id, p2.id]).toContain(duplicates[0].keepId);
  });

  it("closes the ungrouped copy of a grouped tab", () => {
    const g = tab({ url: "https://a.com/", groupId: 7 });
    const u = tab({ url: "https://a.com/", active: true });
    expect(findDuplicates([g, u], [group({ id: 7 })]).duplicates).toEqual([{ closeId: u.id, keepId: g.id }]);
  });

  it("dedupes inside one group", () => {
    const a = tab({ url: "https://a.com/", groupId: 7, lastAccessed: 1 });
    const b = tab({ url: "https://a.com/", groupId: 7, lastAccessed: 2 });
    expect(findDuplicates([a, b], [group({ id: 7 })]).duplicates).toEqual([{ closeId: a.id, keepId: b.id }]);
  });

  it("leaves copies in different groups alone and explains why", () => {
    const a = tab({ url: "https://a.com/", title: "Holidays", groupId: 1 });
    const b = tab({ url: "https://a.com/", title: "Holidays", groupId: 2 });
    const res = findDuplicates([a, b], [group({ id: 1, title: "Trip" }), group({ id: 2, title: "Budget" })]);
    expect(res.duplicates).toEqual([]);
    expect(res.notes).toEqual(["“Holidays” is open in Trip and Budget. Left alone."]);
  });

  it("still closes ungrouped copies when the page is in two groups", () => {
    const a = tab({ url: "https://a.com/", groupId: 1 });
    const b = tab({ url: "https://a.com/", groupId: 2 });
    const u = tab({ url: "https://a.com/" });
    const res = findDuplicates([a, b, u], [group({ id: 1 }), group({ id: 2 })]);
    expect(res.duplicates.map((d) => d.closeId)).toEqual([u.id]);
    expect(res.notes).toHaveLength(1);
  });
});
