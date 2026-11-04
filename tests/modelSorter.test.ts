import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  cleanTitle,
  ModelSorter,
  parseAnswer,
  resolveAnswer,
} from "../src/core/modelSorter";
import type { Model } from "../src/core/model";
import type { SortInput } from "../src/core/sorter";
import type { TabInfo } from "../src/core/types";
import { group, tab } from "./helpers";

interface Script {
  /** Cleaned tab line ("useEffect (on react.dev)") -> subject. */
  subject: (line: string) => string;
  /** Subject -> group answer, given the group ids listed in the prompt by name. */
  topic: (subject: string, groups: Record<string, string>) => string;
}

/** A fake model that answers from a script, and records every prompt. */
function fakeModel(script: Script, opts: { window?: number; fail?: boolean; stream?: boolean } = {}) {
  const prompts: string[] = [];
  let sessions = 0;
  const answer = (p: string) => {
    prompts.push(p);
    if (opts.fail) return "Sure! Here you go.";
    const groups = Object.fromEntries([...p.matchAll(/^([EUN]\d+): "([^"]*)"/gm)].map((m) => [m[2], m[1]]));
    const tabs = [...p.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => {
      const subject = script.subject(m[2]);
      return { tab: Number(m[1]), subject, group: script.topic(subject, groups) };
    });
    return JSON.stringify({ tabs });
  };
  const model: Model = {
    name: "fake model",
    maxBatch: 30,
    contextTokens: opts.window ?? 100_000,
    measure: async (r) => r.prompt.length / 4,
    async complete(r) {
      sessions++;
      r.signal?.throwIfAborted();
      const text = answer(r.prompt);
      if (opts.stream) {
        let sofar = "";
        for (const piece of text.match(/.{1,7}/gs) ?? []) r.onText?.((sofar += piece));
      } else r.onText?.(text);
      return text;
    },
  };
  return { model, prompts, sessions: () => sessions };
}

const input = (tabs: TabInfo[], extra: Partial<SortInput> = {}): SortInput => ({
  tabs,
  existingGroups: [],
  userGroups: [],
  ...extra,
});

describe("cleanTitle", () => {
  it("drops the site's name and notification counts", () => {
    expect(cleanTitle("useEffect – React", "https://react.dev/reference/react/useEffect")).toBe("useEffect");
    expect(cleanTitle("(3) Lo-fi beats to study to - YouTube", "https://www.youtube.com/watch?v=1")).toBe("Lo-fi beats to study to");
    expect(cleanTitle("Why does useEffect run twice? - Stack Overflow", "https://stackoverflow.com/q/1")).toBe("Why does useEffect run twice?");
    expect(cleanTitle("GitHub - vitejs/vite: Next generation frontend tooling", "https://github.com/vitejs/vite")).toBe(
      "vitejs/vite: Next generation frontend tooling",
    );
    expect(cleanTitle("Kyoto ryokan – Booking.com", "https://www.booking.com/hotel/jp/x.html")).toBe("Kyoto ryokan");
  });
  it("keeps parts that carry meaning", () => {
    expect(cleanTitle("Generics - TypeScript Handbook", "https://www.typescriptlang.org/docs")).toBe("Generics – TypeScript Handbook");
    expect(cleanTitle("Wikipedia", "https://en.wikipedia.org/")).toBe("Wikipedia");
  });
});

describe("parseAnswer", () => {
  it("reads subjects and groups, also inside a code fence", () => {
    const raw = '```json\n{"tabs":[{"tab":1,"subject":"React hooks","group":"E1"},{"tab":2,"subject":"Weather","group":"none"}]}\n```';
    expect([...parseAnswer(raw)]).toEqual([
      [1, { subject: "React hooks", group: "E1" }],
      [2, { subject: "Weather", group: "none" }],
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
  const p = buildPrompt(
    {
      tabs: [],
      existingGroups: [
        { group: group({ id: 1, title: "Trip" }), tabs: [tab({ url: "https://booking.com/x", title: "Kyoto ryokan – Booking.com" })] },
      ],
      userGroups: [{ id: "u", name: "Reading", hint: "hacker news", color: "pink" }],
    },
    ["Baking"],
    [
      tab({ url: "https://www.react.dev/a", title: "useEffect – React" }),
      tab({ url: "https://stackoverflow.com/q/1", title: "Why does useEffect run twice? - Stack Overflow" }),
    ],
  );
  it("lists groups and known topics", () => {
    expect(p).toContain('U1: "Reading" (proposed by the user). Hint: hacker news');
    expect(p).toContain('E1: "Trip" (existing group). It holds: "Kyoto ryokan"');
    expect(p).toContain('N1: "Baking"');
  });
  it("shows cleaned titles, with the website only for very short ones", () => {
    expect(p).toContain("1. useEffect (on react.dev)");
    expect(p).toContain("2. Why does useEffect run twice?\n");
    expect(p).not.toMatch(/booking\.com|stackoverflow/i);
  });
});

/** Subjects and topics for a small set of tabs spread over a few websites. */
const script: Script = {
  subject: (line) =>
    line.startsWith("useEffect") ? "React hooks"
    : line.startsWith("Configuring Vite") ? "Vite build config"
    : line.startsWith("Rye sourdough") ? "Rye bread recipe"
    : line.startsWith("Dutch ovens") ? "Dutch oven reviews"
    : line.startsWith("Lo-fi") ? "YouTube"
    : line.startsWith("Mechanical") ? "Mechanical keyboards"
    : "Something else",
  topic: (s, groups) =>
    groups["Reading"] && /keyboard/i.test(s) ? groups["Reading"]
    : /react|vite/i.test(s) ? "Web development"
    : /bread|oven/i.test(s) ? "Baking"
    : /lo-fi/i.test(s) ? "YouTube"
    : "none",
};

describe("ModelSorter", () => {
  const tabs = () => [
    tab({ url: "https://react.dev/a", title: "useEffect – React" }),
    tab({ url: "https://vite.dev/config", title: "Configuring Vite" }),
    tab({ url: "https://kingarthurbaking.com/r", title: "Rye sourdough – King Arthur Baking" }),
    tab({ url: "https://www.youtube.com/watch?v=2", title: "Dutch ovens, tested - YouTube" }),
    tab({ url: "https://www.youtube.com/watch?v=1", title: "(3) Lo-fi beats - YouTube" }),
    tab({ url: "https://weather.gov/", title: "Brooklyn forecast" }),
  ];

  it("groups by subject, across websites", async () => {
    const t = tabs();
    const model = fakeModel(script);
    const sorter = new ModelSorter(model.model);
    const res = await sorter.sort(input(t));
    expect(res.get(t[0].id)).toEqual({ kind: "new", name: "Web development" });
    expect(res.get(t[1].id)).toEqual({ kind: "new", name: "Web development" });
    expect(res.get(t[2].id)).toEqual({ kind: "new", name: "Baking" });
    expect(res.get(t[3].id)).toEqual({ kind: "new", name: "Baking" });
    // The two YouTube tabs are not grouped by site: "YouTube" is rejected as a subject and a topic.
    expect(res.get(t[4].id)).toEqual({ kind: "left" });
    expect(res.get(t[5].id)).toEqual({ kind: "left" });
    expect(sorter.subjectOf(t[0].id)).toBe("React hooks");
    expect(sorter.subjectOf(t[4].id)).toBe("Lo-fi beats");
  });

  it("uses groups the user proposed", async () => {
    const t = [
      tab({ url: "https://reddit.com/r/mk/1", title: "Mechanical keyboards for beginners - Reddit" }),
      tab({ url: "https://theverge.com/k", title: "Mechanical keyboard review" }),
    ];
    const res = await new ModelSorter(fakeModel(script).model).sort(
      input(t, { userGroups: [{ id: "r", name: "Reading", hint: "", color: "pink" }] }),
    );
    expect(res.get(t[0].id)).toEqual({ kind: "user", id: "r" });
    expect(res.get(t[1].id)).toEqual({ kind: "user", id: "r" });
  });

  it("splits into batches that fit the context window and offers earlier topics to later batches", async () => {
    const many = Array.from({ length: 12 }, (_, i) => tab({ url: `https://site${i}.com/`, title: `useEffect part ${i}` }));
    const model = fakeModel(script, { window: 300 });
    const progress: number[] = [];
    const res = await new ModelSorter(model.model).sort(input(many), { onProgress: (d) => progress.push(d) });
    expect(model.prompts.length).toBeGreaterThan(1);
    expect(model.prompts.at(-1)).toContain('N1: "Web development"');
    expect(new Set([...res.values()].map((v) => JSON.stringify(v)))).toEqual(
      new Set([JSON.stringify({ kind: "new", name: "Web development" })]),
    );
    expect(progress).toContain(12);
  });

  it("only asks about new tabs until told to forget", async () => {
    const t = tabs();
    const model = fakeModel(script);
    const sorter = new ModelSorter(model.model);
    await sorter.sort(input(t.slice(0, 3)));
    await sorter.sort(input(t.slice(0, 4)));
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("1. Dutch ovens, tested");
    expect(model.prompts[1]).not.toContain("useEffect");
    expect(model.prompts[1]).toContain('N2: "Baking"');
    await sorter.sort(input(t.slice(0, 4)));
    expect(model.prompts).toHaveLength(2);
    // Changing the groups doesn't reshuffle what was already sorted…
    await sorter.sort(input(t.slice(0, 4), { userGroups: [{ id: "u", name: "New", hint: "", color: "red" }] }));
    expect(model.prompts).toHaveLength(2);
    // …until the dashboard asks for a fresh sort.
    sorter.forget();
    await sorter.sort(input(t.slice(0, 4), { userGroups: [{ id: "u", name: "New", hint: "", color: "red" }] }));
    expect(model.prompts).toHaveLength(3);
    expect(model.prompts[2]).toContain("useEffect");
  });

  it("streams what goes in and out of the model", async () => {
    const t = tabs().slice(0, 2);
    const events: string[] = [];
    const res = await new ModelSorter(fakeModel(script, { stream: true }).model).sort(input(t), {
      onModel: (e) => events.push(e.kind === "input" ? `in:${e.items.join("|")}` : `${e.kind}:${e.text.length}`),
    });
    expect(events[0]).toBe("in:useEffect|Configuring Vite");
    expect(events.filter((e) => e.startsWith("output:")).length).toBeGreaterThan(3);
    expect(res.get(t[0].id)).toEqual({ kind: "new", name: "Web development" });
  });

  it("reports model errors", async () => {
    const events: string[] = [];
    await new ModelSorter(fakeModel(script, { fail: true }).model).sort(input([tab({ url: "https://a.com/x" })]), {
      onModel: (e) => events.push(e.kind),
    });
    expect(events).toEqual(["input", "output", "error"]);
  });

  it("sorts tabs by website when the model fails", async () => {
    const t = [tab({ url: "https://react.dev/a" }), tab({ url: "https://react.dev/b" })];
    const sorter = new ModelSorter(fakeModel(script, { fail: true }).model);
    const res = await sorter.sort(input(t));
    expect(res.get(t[0].id)).toEqual({ kind: "new", name: "react.dev" });
    expect(sorter.lastFallbackCount).toBe(2);
  });

  it("stops when cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    const model = fakeModel(script);
    await expect(new ModelSorter(model.model).sort(input([tab({ url: "https://a.com" })]), { signal: abort.signal })).rejects.toThrow();
    expect(model.sessions()).toBe(0);
  });
});
