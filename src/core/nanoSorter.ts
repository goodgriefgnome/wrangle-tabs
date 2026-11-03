import { SiteSorter } from "./siteSorter";
import type { Sorter, SortInput, SortOptions, SortTarget } from "./sorter";
import type { TabInfo } from "./types";

/** The parts of a Prompt API session the sorter uses. */
export interface ModelSession {
  prompt(input: string, options?: { responseConstraint?: object; signal?: AbortSignal }): Promise<string>;
  measureContextUsage?(input: string, options?: { responseConstraint?: object }): Promise<number>;
  readonly contextUsage?: number;
  readonly contextWindow?: number;
  destroy(): void;
}

/** Creates a fresh session that already has the system prompt. */
export type SessionFactory = (systemPrompt: string, signal?: AbortSignal) => Promise<ModelSession>;

export const SYSTEM_PROMPT = `You sort web browser tabs into tab groups by topic.
You get a numbered list of groups and a numbered list of tabs. For every tab, pick where it belongs:
- A group id from the list (such as E1, U2 or N3) when the tab clearly fits that group's topic.
- Groups proposed by the user come first: use them whenever a tab fits their name or hint.
- Otherwise a short new topic name of one to three words, such as "React", "Japan trip" or "Baking". Group by what the tab is about, not by which website it is on. Use exactly the same name for every tab on the same topic.
- "none" when the tab shares no topic with any group or other tab.
Answer with JSON only.`;

const SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: { tab: { type: "integer" }, group: { type: "string" } },
        required: ["tab", "group"],
      },
    },
  },
  required: ["assignments"],
};

const MAX_BATCH = 30;
const MIN_BATCH = 3;
/** Rough number of tokens the answer uses per tab. */
const OUTPUT_TOKENS_PER_TAB = 20;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;
/** Compares topic names loosely: case, punctuation and a plural "s" are ignored. */
export const normName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").replace(/s$/, "");

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const tabKey = (t: TabInfo) => `${t.id}|${t.title}|${t.url}`;

function contextSignature(input: SortInput): string {
  return JSON.stringify([
    input.existingGroups.map(({ group }) => [group.id, group.title]),
    input.userGroups.map((g) => [g.id, g.name, g.hint]),
  ]);
}

export function buildPrompt(input: SortInput, topics: string[], batch: TabInfo[]): string {
  const lines: string[] = ["Groups:"];
  input.userGroups.forEach((g, i) => {
    lines.push(`U${i + 1}: ${quote(g.name)} (proposed by the user)${g.hint ? `. Hint: ${clip(g.hint, 120)}` : ""}`);
  });
  input.existingGroups.forEach(({ group, tabs }, i) => {
    const examples = tabs.slice(0, 3).map((t) => quote(clip(t.title, 60))).join("; ");
    lines.push(`E${i + 1}: ${quote(group.title || "Unnamed group")} (existing group)${examples ? `. Its tabs include: ${examples}` : ""}`);
  });
  topics.forEach((name, i) => lines.push(`N${i + 1}: ${quote(name)} (new topic, already used for other tabs)`));
  if (lines.length === 1) lines.push("None yet.");
  lines.push("", "Tabs:");
  batch.forEach((t, i) => lines.push(`${i + 1}. ${clip(t.title, 90)} [${hostOf(t.url)}]`));
  lines.push(
    "",
    `For each of the ${batch.length} tabs, answer with its number and a group: a group id, a short new topic name, or "none".`,
  );
  return lines.join("\n");
}

/** Reads the model's answer into tab number -> group text. Throws when it isn't the expected JSON. */
export function parseAnswer(raw: string): Map<number, string> {
  const json = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const data = JSON.parse(json) as { assignments?: { tab?: unknown; group?: unknown }[] };
  if (!Array.isArray(data.assignments)) throw new Error("Answer has no assignments");
  const out = new Map<number, string>();
  for (const a of data.assignments) {
    if (typeof a.tab === "number" && typeof a.group === "string") out.set(a.tab, a.group);
  }
  return out;
}

/** Turns one answer ("E1", "none", "Baking", …) into a target. */
export function resolveAnswer(answer: string, input: SortInput, topics: string[]): SortTarget {
  const text = answer.trim().replace(/^["'“”]+|["'“”.]+$/g, "").trim();
  if (!text || /^none$/i.test(text)) return { kind: "left" };

  const id = /^([EUN])\s*(\d+)$/i.exec(text);
  if (id) {
    const n = Number(id[2]) - 1;
    const letter = id[1].toUpperCase();
    if (letter === "E" && input.existingGroups[n]) return { kind: "existing", groupId: input.existingGroups[n].group.id };
    if (letter === "U" && input.userGroups[n]) return { kind: "user", id: input.userGroups[n].id };
    if (letter === "N" && topics[n]) return { kind: "new", name: topics[n] };
    return { kind: "left" };
  }

  // The model sometimes writes a group's name instead of its id.
  const norm = normName(text);
  const existing = input.existingGroups.find(({ group }) => group.title && normName(group.title) === norm);
  if (existing) return { kind: "existing", groupId: existing.group.id };
  const user = input.userGroups.find((g) => normName(g.name) === norm);
  if (user) return { kind: "user", id: user.id };
  const topic = topics.find((t) => normName(t) === norm);
  return { kind: "new", name: topic ?? clip(text.replace(/\s+/g, " "), 40) };
}

/**
 * Sorts tabs with Chrome's built-in model (Gemini Nano).
 * - Tabs go to the model in batches that fit its context window. Topic names
 *   from earlier batches are offered to later ones, so topics stay consistent.
 * - Answers are cached per tab until the groups change, so re-scans only ask about new tabs.
 * - A suggested topic with a single tab goes to Leftovers instead.
 * - Tabs the model fails on are sorted by website.
 */
export class NanoSorter implements Sorter {
  readonly label = "Sorted by on-device AI";
  /** Tabs the model failed on in the last sort, which were sorted by website instead. */
  lastFallbackCount = 0;
  private cache = new Map<string, SortTarget>();
  private cacheSignature = "";

  constructor(
    private readonly createSession: SessionFactory,
    private readonly fallback: Sorter = new SiteSorter(),
  ) {}

  async sort(input: SortInput, options: SortOptions = {}): Promise<Map<number, SortTarget>> {
    const { signal, onProgress } = options;
    const signature = contextSignature(input);
    if (signature !== this.cacheSignature) {
      this.cache.clear();
      this.cacheSignature = signature;
    }

    const result = new Map<number, SortTarget>();
    const todo: TabInfo[] = [];
    for (const t of input.tabs) {
      const hit = this.cache.get(tabKey(t));
      if (hit) result.set(t.id, hit);
      else todo.push(t);
    }

    const topics: string[] = [];
    const addTopic = (name: string) => {
      if (!topics.some((t) => normName(t) === normName(name))) topics.push(name);
    };
    for (const v of result.values()) if (v.kind === "new") addTopic(v.name);

    onProgress?.(0, todo.length);
    let size = MAX_BATCH;
    let i = 0;
    while (i < todo.length) {
      signal?.throwIfAborted();
      let batch = todo.slice(i, i + size);
      let session: ModelSession | null = null;
      try {
        session = await this.createSession(SYSTEM_PROMPT, signal);
        let prompt = buildPrompt(input, topics, batch);
        while (batch.length > MIN_BATCH && !(await fits(session, prompt, batch.length))) {
          size = Math.max(MIN_BATCH, Math.floor(batch.length * 0.6));
          batch = todo.slice(i, i + size);
          prompt = buildPrompt(input, topics, batch);
        }
        const answers = parseAnswer(await session.prompt(prompt, { responseConstraint: SCHEMA, signal }));
        const offered = [...topics];
        batch.forEach((t, k) => {
          const answer = answers.get(k + 1);
          if (answer === undefined) return;
          const target = resolveAnswer(answer, input, offered);
          if (target.kind === "new") {
            addTopic(target.name);
            target.name = topics.find((x) => normName(x) === normName(target.name))!;
          }
          this.cache.set(tabKey(t), target);
          result.set(t.id, target);
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn("On-device AI couldn't sort a batch of tabs; sorting them by website.", e);
      } finally {
        session?.destroy();
      }
      i += batch.length;
      onProgress?.(i, todo.length);
    }

    const missing = input.tabs.filter((t) => !result.has(t.id));
    this.lastFallbackCount = missing.length;
    if (missing.length) {
      const fb = await this.fallback.sort({ ...input, tabs: missing }, { signal });
      for (const [id, target] of fb) result.set(id, target);
    }

    // A topic needs at least two tabs to become a group.
    const counts = new Map<string, number>();
    for (const v of result.values()) if (v.kind === "new") counts.set(normName(v.name), (counts.get(normName(v.name)) ?? 0) + 1);
    for (const [id, v] of result) if (v.kind === "new" && counts.get(normName(v.name))! < 2) result.set(id, { kind: "left" });
    return result;
  }
}

async function fits(session: ModelSession, prompt: string, tabCount: number): Promise<boolean> {
  const window = session.contextWindow;
  if (!window || !session.measureContextUsage) return true;
  const need = await session.measureContextUsage(prompt, { responseConstraint: SCHEMA });
  return (session.contextUsage ?? 0) + need + tabCount * OUTPUT_TOKENS_PER_TAB <= window * 0.9;
}
