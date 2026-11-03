import { describe, expect, it } from "vitest";
import {
  buildSubjectPrompt,
  buildTopicPrompt,
  cleanTitle,
  NanoSorter,
  parseAnswer,
  resolveAnswer,
  type ModelSession,
} from "../src/core/nanoSorter";
import type { SortInput } from "../src/core/sorter";
import type { TabInfo } from "../src/core/types";
import { group, tab } from "./helpers";

interface Script {
  /** Cleaned tab line ("useEffect (on react.dev)") -> subject. */
  subject: (line: string) => string;
  /** Subject -> group answer, given the group ids listed in the prompt by name. */
  topic: (subject: string, groups: Record<string, string>) => string;
}

/** A fake model that answers both steps from a script, and records every prompt. */
function fakeModel(script: Script, opts: { window?: number; failSubjects?: boolean } = {}) {
  const prompts: { kind: "subject" | "topic"; text: string }[] = [];
  let sessions = 0;
  const factory = async (): Promise<ModelSession> => {
    sessions++;
    return {
      contextWindow: opts.window,
      contextUsage: 0,
      measureContextUsage: async (p: string) => p.length / 4,
      async prompt(p: string) {
        const lines = [...p.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => [Number(m[1]), m[2]] as const);
        if (p.startsWith("Tabs:")) {
          prompts.push({ kind: "subject", text: p });
          if (opts.failSubjects) return "Sure! Here you go.";
          return JSON.stringify({ subjects: lines.map(([n, line]) => ({ tab: n, subject: script.subject(line) })) });
        }
        prompts.push({ kind: "topic", text: p });
        const groups = Object.fromEntries([...p.matchAll(/^([EUN]\d+): "([^"]*)"/gm)].map((m) => [m[2], m[1]]));
        return JSON.stringify({ assignments: lines.map(([n, s]) => ({ subject: n, group: script.topic(s, groups) })) });
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
  it("reads the list, also inside a code fence", () => {
    const raw = '```json\n{"assignments":[{"subject":1,"group":"E1"},{"subject":2,"group":"none"}]}\n```';
    expect([...parseAnswer(raw, "assignments", "subject", "group")]).toEqual([
      [1, "E1"],
      [2, "none"],
    ]);
  });
  it("throws on anything else", () => {
    expect(() => parseAnswer("Sure! Here are your groups", "assignments", "subject", "group")).toThrow();
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

describe("prompts", () => {
  it("the subject step sees cleaned titles", () => {
    const p = buildSubjectPrompt([tab({ url: "https://www.react.dev/a", title: "useEffect – React" })]);
    expect(p).toContain("1. useEffect (on react.dev)");
  });
  it("the topic step sees groups and subjects, but no websites", () => {
    const p = buildTopicPrompt(
      input([], {
        existingGroups: [
          { group: group({ id: 1, title: "Trip" }), tabs: [tab({ url: "https://booking.com/x", title: "Kyoto ryokan – Booking.com" })] },
        ],
        userGroups: [{ id: "u", name: "Reading", hint: "hacker news", color: "pink" }],
      }),
      ["Baking"],
      ["React hooks"],
    );
    expect(p).toContain('U1: "Reading" (proposed by the user). Hint: hacker news');
    expect(p).toContain('E1: "Trip" (existing group). It holds: "Kyoto ryokan"');
    expect(p).toContain('N1: "Baking"');
    expect(p).toContain("1. React hooks");
    expect(p).not.toMatch(/booking\.com|react\.dev/i);
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

describe("NanoSorter", () => {
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
    const sorter = new NanoSorter(model.factory);
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
    const res = await new NanoSorter(fakeModel(script).factory).sort(
      input(t, { userGroups: [{ id: "r", name: "Reading", hint: "", color: "pink" }] }),
    );
    expect(res.get(t[0].id)).toEqual({ kind: "user", id: "r" });
    expect(res.get(t[1].id)).toEqual({ kind: "user", id: "r" });
  });

  it("splits into batches that fit the context window and offers earlier topics to later batches", async () => {
    const many = Array.from({ length: 12 }, (_, i) => tab({ url: `https://site${i}.com/`, title: `useEffect part ${i}` }));
    const model = fakeModel(script, { window: 300 });
    const progress: number[] = [];
    const res = await new NanoSorter(model.factory).sort(input(many), { onProgress: (d) => progress.push(d) });
    expect(model.prompts.filter((p) => p.kind === "subject").length).toBeGreaterThan(1);
    expect(new Set([...res.values()].map((v) => JSON.stringify(v)))).toEqual(
      new Set([JSON.stringify({ kind: "new", name: "Web development" })]),
    );
    expect(progress).toContain(12);
  });

  it("only asks about new tabs, and only re-groups subjects when the groups change", async () => {
    const t = tabs();
    const model = fakeModel(script);
    const sorter = new NanoSorter(model.factory);
    await sorter.sort(input(t.slice(0, 3)));
    expect(model.prompts.map((p) => p.kind)).toEqual(["subject", "topic"]);

    await sorter.sort(input(t.slice(0, 4)));
    expect(model.prompts.map((p) => p.kind)).toEqual(["subject", "topic", "subject", "topic"]);
    expect(model.prompts[2].text).toContain("1. Dutch ovens, tested");
    expect(model.prompts[2].text).not.toContain("useEffect");
    expect(model.prompts[3].text).toContain('N2: "Baking"');

    await sorter.sort(input(t.slice(0, 4)));
    expect(model.prompts).toHaveLength(4);

    await sorter.sort(input(t.slice(0, 4), { userGroups: [{ id: "u", name: "New", hint: "", color: "red" }] }));
    expect(model.prompts.map((p) => p.kind).slice(4)).toEqual(["topic"]);
  });

  it("sorts tabs by website when the model fails", async () => {
    const t = [tab({ url: "https://react.dev/a" }), tab({ url: "https://react.dev/b" })];
    const sorter = new NanoSorter(fakeModel(script, { failSubjects: true }).factory);
    const res = await sorter.sort(input(t));
    expect(res.get(t[0].id)).toEqual({ kind: "new", name: "react.dev" });
    expect(sorter.lastFallbackCount).toBe(2);
  });

  it("stops when cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    const model = fakeModel(script);
    await expect(new NanoSorter(model.factory).sort(input([tab({ url: "https://a.com" })]), { signal: abort.signal })).rejects.toThrow();
    expect(model.sessions()).toBe(0);
  });
});
