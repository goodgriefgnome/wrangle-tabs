import { describe, expect, it } from "vitest";
import { buildPrompt, NanoSorter, parseAnswer, resolveAnswer, type ModelSession } from "../src/core/nanoSorter";
import type { SortInput } from "../src/core/sorter";
import type { TabInfo } from "../src/core/types";
import { group, tab } from "./helpers";

/** A fake model: `answer` gets each prompt and returns tab number -> group text. */
function fakeModel(answer: (prompt: string, tabCount: number) => Record<number, string> | string, opts: { window?: number } = {}) {
  const prompts: string[] = [];
  let sessions = 0;
  const factory = async (): Promise<ModelSession> => {
    sessions++;
    return {
      contextWindow: opts.window,
      contextUsage: 0,
      measureContextUsage: async (p: string) => p.length / 4,
      async prompt(p: string) {
        prompts.push(p);
        const count = (p.match(/^\d+\. /gm) ?? []).length;
        const a = answer(p, count);
        if (typeof a === "string") return a;
        return JSON.stringify({ assignments: Object.entries(a).map(([t, g]) => ({ tab: Number(t), group: g })) });
      },
      destroy() {},
    };
  };
  return { factory, prompts, sessions: () => sessions };
}

const input = (tabs: TabInfo[], extra: Partial<SortInput> = {}): SortInput => ({
  tabs,
  existingGroups: [],
  userGroups: [],
  ...extra,
});

describe("parseAnswer", () => {
  it("reads assignments, also inside a code fence", () => {
    const raw = '```json\n{"assignments":[{"tab":1,"group":"E1"},{"tab":2,"group":"none"}]}\n```';
    expect([...parseAnswer(raw)]).toEqual([
      [1, "E1"],
      [2, "none"],
    ]);
  });
  it("throws on anything else", () => {
    expect(() => parseAnswer("Sure! Here are your groups")).toThrow();
  });
});

describe("resolveAnswer", () => {
  const trip = group({ id: 10, title: "Trip planning" });
  const inp = input([], {
    existingGroups: [{ group: trip, tabs: [] }],
    userGroups: [{ id: "u", name: "Weekend reading", hint: "", color: "pink" }],
  });
  it("maps ids", () => {
    expect(resolveAnswer("E1", inp, [])).toEqual({ kind: "existing", groupId: 10 });
    expect(resolveAnswer("u1", inp, [])).toEqual({ kind: "user", id: "u" });
    expect(resolveAnswer("N1", inp, ["React"])).toEqual({ kind: "new", name: "React" });
    expect(resolveAnswer("E7", inp, [])).toEqual({ kind: "left" });
  });
  it("maps names the model wrote instead of ids", () => {
    expect(resolveAnswer('"trip planning"', inp, [])).toEqual({ kind: "existing", groupId: 10 });
    expect(resolveAnswer("Weekend Reading", inp, [])).toEqual({ kind: "user", id: "u" });
    expect(resolveAnswer("Recipes", inp, ["recipe"])).toEqual({ kind: "new", name: "recipe" });
  });
  it("treats none and blanks as leftovers", () => {
    expect(resolveAnswer("none", inp, [])).toEqual({ kind: "left" });
    expect(resolveAnswer("  ", inp, [])).toEqual({ kind: "left" });
  });
});

describe("buildPrompt", () => {
  it("lists user groups, existing groups, known topics and tabs", () => {
    const p = buildPrompt(
      input([tab({ url: "https://react.dev/a", title: "useEffect – React" })], {
        existingGroups: [{ group: group({ id: 1, title: "Trip" }), tabs: [tab({ url: "https://x.com", title: "Kyoto ryokan" })] }],
        userGroups: [{ id: "u", name: "Reading", hint: "hacker news", color: "pink" }],
      }),
      ["Baking"],
      [tab({ url: "https://www.react.dev/a", title: "useEffect – React" })],
    );
    expect(p).toContain('U1: "Reading" (proposed by the user). Hint: hacker news');
    expect(p).toContain('E1: "Trip" (existing group). Its tabs include: "Kyoto ryokan"');
    expect(p).toContain('N1: "Baking"');
    expect(p).toContain("1. useEffect – React [react.dev]");
  });
});

describe("NanoSorter", () => {
  it("sorts by topic and sends single-tab topics to Leftovers", async () => {
    const tabs = [
      tab({ url: "https://react.dev/a", title: "useEffect" }),
      tab({ url: "https://stackoverflow.com/q/1", title: "Why does useEffect run twice" }),
      tab({ url: "https://weather.gov/", title: "Forecast" }),
      tab({ url: "https://seriouseats.com/x", title: "Dutch ovens" }),
    ];
    const model = fakeModel(() => ({ 1: "React", 2: "react", 3: "none", 4: "Cooking" }));
    const res = await new NanoSorter(model.factory).sort(input(tabs));
    expect(res.get(tabs[0].id)).toEqual({ kind: "new", name: "React" });
    expect(res.get(tabs[1].id)).toEqual({ kind: "new", name: "React" });
    expect(res.get(tabs[2].id)).toEqual({ kind: "left" });
    expect(res.get(tabs[3].id)).toEqual({ kind: "left" });
  });

  it("splits into batches that fit the context window and offers earlier topics to later batches", async () => {
    const tabs = Array.from({ length: 12 }, (_, i) => tab({ url: `https://site${i}.com/`, title: `Article number ${i} about stuff` }));
    const model = fakeModel((_, n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [k + 1, "Reading"])), { window: 400 });
    const progress: number[] = [];
    const res = await new NanoSorter(model.factory).sort(input(tabs), { onProgress: (d) => progress.push(d) });
    expect(model.prompts.length).toBeGreaterThan(1);
    expect(model.prompts.at(-1)).toContain('N1: "Reading"');
    expect(new Set([...res.values()].map((v) => JSON.stringify(v)))).toEqual(new Set([JSON.stringify({ kind: "new", name: "Reading" })]));
    expect(progress.at(-1)).toBe(12);
  });

  it("only asks about new tabs until the groups change", async () => {
    const a = tab({ url: "https://react.dev/a", title: "A" });
    const b = tab({ url: "https://react.dev/b", title: "B" });
    const model = fakeModel((_, n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [k + 1, "React"])));
    const sorter = new NanoSorter(model.factory);
    await sorter.sort(input([a]));
    await sorter.sort(input([a, b]));
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("1. B");
    expect(model.prompts[1]).not.toContain("1. A");
    await sorter.sort(input([a, b], { userGroups: [{ id: "u", name: "New", hint: "", color: "red" }] }));
    expect(model.prompts).toHaveLength(3);
    expect(model.prompts[2]).toContain("1. A");
  });

  it("sorts tabs by website when the model fails", async () => {
    const tabs = [tab({ url: "https://react.dev/a" }), tab({ url: "https://react.dev/b" })];
    const model = fakeModel(() => "not json");
    const sorter = new NanoSorter(model.factory);
    const res = await sorter.sort(input(tabs));
    expect(res.get(tabs[0].id)).toEqual({ kind: "new", name: "react.dev" });
    expect(sorter.lastFallbackCount).toBe(2);
  });

  it("stops when cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    const model = fakeModel(() => ({ 1: "x" }));
    await expect(new NanoSorter(model.factory).sort(input([tab({ url: "https://a.com" })]), { signal: abort.signal })).rejects.toThrow();
    expect(model.sessions()).toBe(0);
  });
});
