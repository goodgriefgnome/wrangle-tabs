import { SiteSorter } from "./siteSorter";
import type { Sorter, SortInput, SortOptions, SortTarget } from "./sorter";
import type { TabInfo } from "./types";
import { siteOf } from "./url";

/** The parts of a Prompt API session the sorter uses. */
export interface ModelSession {
  prompt(input: string, options?: { responseConstraint?: object; signal?: AbortSignal }): Promise<string>;
  measureContextUsage?(input: string, options?: { responseConstraint?: object }): Promise<number>;
  readonly contextUsage?: number;
  readonly contextWindow?: number;
  destroy(): void;
}

/** Creates a fresh session that already has the given system prompt. */
export type SessionFactory = (systemPrompt: string, signal?: AbortSignal) => Promise<ModelSession>;

/*
 * Sorting happens in two steps, because a small model asked to group tabs
 * directly tends to group them by website:
 * 1. Subjects: the model says what each tab is about, in a few words.
 * 2. Topics: the model groups those subjects, without seeing any website names.
 */

export const SUBJECT_PROMPT = `You read web browser tab titles and say what each page is about.
For each tab, write its subject in 2 to 5 words: the topic, product, place, project or task the page is about.
Never answer with the name of the website. "YouTube", "GitHub", "Wikipedia", "Reddit" or "Google Docs" are not subjects: say what the video, repository, article, thread or document is about.
Answer with JSON only.`;

export const TOPIC_PROMPT = `You organise subjects into tab groups.
You get a numbered list of groups and a numbered list of subjects. Each subject is what one or more browser tabs are about. For every subject, pick where it belongs:
- A group id (such as U1, E2 or N3) when the subject fits that group's topic. Groups proposed by the user come first: use them whenever a subject fits their name or hint.
- Otherwise a new topic name of one to three words, broad enough to also cover related subjects, such as "Web development", "Japan trip", "Baking" or "Home office". Give related subjects the same topic name, even when they are worded differently.
- "none" when the subject is unrelated to every group and every other subject.
Never use the name of a website or app as a topic.
Answer with JSON only.`;

const SUBJECT_SCHEMA = {
  type: "object",
  properties: {
    subjects: {
      type: "array",
      items: {
        type: "object",
        properties: { tab: { type: "integer" }, subject: { type: "string" } },
        required: ["tab", "subject"],
      },
    },
  },
  required: ["subjects"],
};

const TOPIC_SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: { subject: { type: "integer" }, group: { type: "string" } },
        required: ["subject", "group"],
      },
    },
  },
  required: ["assignments"],
};

const MAX_BATCH = 30;
const MIN_BATCH = 3;
/** Rough number of tokens the answer uses per item. */
const OUTPUT_TOKENS_PER_ITEM = 20;

/** Website and app names that are never a subject or a topic on their own. */
const BRANDS = [
  "youtube", "github", "gitlab", "google", "googledoc", "googlesheet", "googledrive", "gmail", "reddit",
  "wikipedia", "twitter", "facebook", "instagram", "linkedin", "amazon", "stackoverflow", "stackexchange",
  "hackernew", "medium", "substack", "notion", "slack", "figma", "website", "webpage", "homepage",
];

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;
/** Compares names loosely: case, punctuation and a plural "s" are ignored. */
export const normName = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").replace(/s$/, "");

/** "react.dev" -> "react", "docs.google.com" -> "google", "bbc.co.uk" -> "bbc". */
function siteLabel(url: string): string | null {
  const site = siteOf(url);
  return site ? normName(site.split(".")[0]) : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Removes the website's name and other noise from a tab title:
 * "(3) Lo-fi beats - YouTube" -> "Lo-fi beats", "useEffect – React" (on react.dev) -> "useEffect".
 */
export function cleanTitle(title: string, url: string): string {
  const label = siteLabel(url);
  const isSite = (part: string) => {
    const n = normName(part);
    if (!n || part.trim().split(/\s+/).length > 4) return false;
    if (BRANDS.includes(n)) return true;
    return label !== null && label.length >= 3 && (n.includes(label) || label.includes(n));
  };
  const parts = title.replace(/^\(\d+\)\s*/, "").split(/\s+(?:[-–—|·•]|::)\s+/);
  while (parts.length > 1 && isSite(parts[parts.length - 1])) parts.pop();
  while (parts.length > 1 && isSite(parts[0])) parts.shift();
  return parts.join(" – ").trim() || title;
}

/** True when a subject or topic is just a website's name. */
function isSiteName(name: string, siteLabels: Set<string>): boolean {
  const n = normName(name);
  return !n || BRANDS.includes(n) || siteLabels.has(n);
}

const tabKey = (t: TabInfo) => `${t.title}|${t.url}`;

function groupSignature(input: SortInput): string {
  return JSON.stringify([
    input.existingGroups.map(({ group }) => [group.id, group.title]),
    input.userGroups.map((g) => [g.id, g.name, g.hint]),
  ]);
}

export function buildSubjectPrompt(batch: TabInfo[]): string {
  const lines = ["Tabs:"];
  batch.forEach((t, i) => lines.push(`${i + 1}. ${clip(cleanTitle(t.title, t.url), 100)} (on ${hostOf(t.url) || "a local page"})`));
  lines.push("", `Give the subject of each of the ${batch.length} tabs.`);
  return lines.join("\n");
}

export function buildTopicPrompt(input: SortInput, topics: string[], subjects: string[]): string {
  const lines: string[] = ["Groups:"];
  input.userGroups.forEach((g, i) => {
    lines.push(`U${i + 1}: ${quote(g.name)} (proposed by the user)${g.hint ? `. Hint: ${clip(g.hint, 120)}` : ""}`);
  });
  input.existingGroups.forEach(({ group, tabs }, i) => {
    const examples = tabs
      .slice(0, 3)
      .map((t) => quote(clip(cleanTitle(t.title, t.url), 60)))
      .join("; ");
    lines.push(`E${i + 1}: ${quote(group.title || "Unnamed group")} (existing group)${examples ? `. It holds: ${examples}` : ""}`);
  });
  topics.forEach((name, i) => lines.push(`N${i + 1}: ${quote(name)} (new topic, already used for other subjects)`));
  if (lines.length === 1) lines.push("None yet.");
  lines.push("", "Subjects:");
  subjects.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push(
    "",
    `For each of the ${subjects.length} subjects, answer with its number and a group: a group id, a new topic name, or "none".`,
  );
  return lines.join("\n");
}

/** Reads `{ <listKey>: [{ <idKey>: n, <valueKey>: "…" }] }` into n -> text. Throws on anything else. */
export function parseAnswer(raw: string, listKey: string, idKey: string, valueKey: string): Map<number, string> {
  const json = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const data = JSON.parse(json) as Record<string, unknown>;
  const list = data[listKey];
  if (!Array.isArray(list)) throw new Error(`Answer has no ${listKey}`);
  const out = new Map<number, string>();
  for (const item of list as Record<string, unknown>[]) {
    const id = item[idKey];
    const value = item[valueKey];
    if (typeof id === "number" && typeof value === "string") out.set(id, value);
  }
  return out;
}

/** Turns one topic answer ("E1", "none", "Baking", …) into a target. */
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
 * Sorts tabs with Chrome's built-in model (Gemini Nano), in two steps (see above).
 * - Both steps go to the model in batches that fit its context window.
 * - Subjects are remembered per tab; topics per subject until the groups change.
 *   So re-scans only ask about new tabs.
 * - A topic with a single tab goes to Leftovers.
 * - Tabs the model fails on are sorted by website.
 */
export class NanoSorter implements Sorter {
  readonly label = "Sorted by on-device AI";
  /** Tabs the model failed on in the last sort, which were sorted by website instead. */
  lastFallbackCount = 0;
  private subjects = new Map<string, string>();
  private topics = new Map<string, SortTarget>();
  private topicSignature = "";
  private lastSubjects = new Map<number, string>();

  constructor(
    private readonly createSession: SessionFactory,
    private readonly fallback: Sorter = new SiteSorter(),
  ) {}

  /** What the model said the tab is about, from the last sort. */
  subjectOf(tabId: number): string | undefined {
    return this.lastSubjects.get(tabId);
  }

  async sort(input: SortInput, options: SortOptions = {}): Promise<Map<number, SortTarget>> {
    const { signal, onProgress } = options;
    const signature = groupSignature(input);
    if (signature !== this.topicSignature) {
      this.topics.clear();
      this.topicSignature = signature;
    }
    const siteLabels = new Set(
      [...input.tabs, ...input.existingGroups.flatMap((g) => g.tabs)].map((t) => siteLabel(t.url)).filter((l): l is string => !!l),
    );

    // Step 1: subjects.
    const todo = input.tabs.filter((t) => !this.subjects.has(tabKey(t)));
    onProgress?.(0, todo.length);
    await this.inBatches(todo, SUBJECT_PROMPT, SUBJECT_SCHEMA, buildSubjectPrompt, signal, (batch, raw) => {
      const answers = parseAnswer(raw, "subjects", "tab", "subject");
      batch.forEach((t, k) => {
        let subject = answers.get(k + 1)?.trim().replace(/\s+/g, " ");
        if (subject === undefined) return;
        if (isSiteName(subject, siteLabels)) subject = cleanTitle(t.title, t.url);
        this.subjects.set(tabKey(t), clip(subject, 60));
      });
    }, (done) => onProgress?.(done, todo.length));

    this.lastSubjects = new Map();
    for (const t of input.tabs) {
      const s = this.subjects.get(tabKey(t));
      if (s) this.lastSubjects.set(t.id, s);
    }

    // Step 2: topics for subjects not seen since the groups last changed.
    const known: string[] = [];
    const addTopic = (name: string) => {
      if (!known.some((t) => normName(t) === normName(name))) known.push(name);
      return known.find((t) => normName(t) === normName(name))!;
    };
    for (const v of this.topics.values()) if (v.kind === "new") addTopic(v.name);
    const subjectsTodo = [...new Map([...this.lastSubjects.values()].map((s) => [normName(s), s])).entries()]
      .filter(([n]) => !this.topics.has(n))
      .map(([, s]) => s);
    if (subjectsTodo.length) onProgress?.(0, subjectsTodo.length, "grouping");
    await this.inBatches(
      subjectsTodo,
      TOPIC_PROMPT,
      TOPIC_SCHEMA,
      (batch) => buildTopicPrompt(input, known, batch),
      signal,
      (batch, raw) => {
        const answers = parseAnswer(raw, "assignments", "subject", "group");
        const offered = [...known];
        batch.forEach((subject, k) => {
          const answer = answers.get(k + 1);
          if (answer === undefined) return;
          let target = resolveAnswer(answer, input, offered);
          // A website name is not a topic: fall back to the subject itself.
          if (target.kind === "new" && isSiteName(target.name, siteLabels)) target = { kind: "new", name: subject };
          if (target.kind === "new") target = { kind: "new", name: addTopic(target.name) };
          this.topics.set(normName(subject), target);
        });
      },
    );

    const result = new Map<number, SortTarget>();
    for (const t of input.tabs) {
      const subject = this.lastSubjects.get(t.id);
      if (subject === undefined) continue;
      // Subjects the model gave no topic for can still group with identical subjects.
      result.set(t.id, this.topics.get(normName(subject)) ?? { kind: "new", name: subject });
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

  /** Sends `items` to the model in batches that fit its context window. Failed batches are skipped. */
  private async inBatches<T>(
    items: T[],
    system: string,
    schema: object,
    build: (batch: T[]) => string,
    signal: AbortSignal | undefined,
    handle: (batch: T[], raw: string) => void,
    progress?: (done: number) => void,
  ): Promise<void> {
    let size = MAX_BATCH;
    let i = 0;
    while (i < items.length) {
      signal?.throwIfAborted();
      let batch = items.slice(i, i + size);
      let session: ModelSession | null = null;
      try {
        session = await this.createSession(system, signal);
        let prompt = build(batch);
        while (batch.length > MIN_BATCH && !(await fits(session, prompt, schema, batch.length))) {
          size = Math.max(MIN_BATCH, Math.floor(batch.length * 0.6));
          batch = items.slice(i, i + size);
          prompt = build(batch);
        }
        handle(batch, await session.prompt(prompt, { responseConstraint: schema, signal }));
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn("On-device AI couldn't handle a batch; those tabs are sorted by website.", e);
      } finally {
        session?.destroy();
      }
      i += batch.length;
      progress?.(i);
    }
  }
}

async function fits(session: ModelSession, prompt: string, schema: object, count: number): Promise<boolean> {
  const window = session.contextWindow;
  if (!window || !session.measureContextUsage) return true;
  const need = await session.measureContextUsage(prompt, { responseConstraint: schema });
  return (session.contextUsage ?? 0) + need + count * OUTPUT_TOKENS_PER_ITEM <= window * 0.9;
}
