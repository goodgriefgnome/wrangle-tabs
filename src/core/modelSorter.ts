import { estimateTokens, type Model, type ModelRequest } from "./model";
import { SiteSorter } from "./siteSorter";
import type { Sorter, SortInput, SortOptions, SortTarget } from "./sorter";
import type { TabInfo } from "./types";
import { siteOf } from "./url";

export const SYSTEM_PROMPT = `You sort web browser tabs into tab groups by subject.
You get a numbered list of groups and a numbered list of tabs. For every tab, first write its subject: what the page is about, in 2 to 5 words. Then pick its group:
- A group id (such as U1, E2 or N3) when the tab's subject fits that group. Groups proposed by the user come first: use them whenever a tab fits their name or hint.
- Otherwise a new topic name of one to three words, broad enough to also cover related tabs, such as "Web development", "Japan trip", "Baking" or "Home office". Give tabs on related subjects the same topic, even when they are on different websites.
- "none" when the tab is unrelated to every group and every other tab.
Never use the name of a website or app (such as YouTube, GitHub, Wikipedia, Reddit or Google Docs) as a subject or a topic: say what the page itself is about.
Answer with JSON only.`;

const SCHEMA = {
  type: "object",
  properties: {
    tabs: {
      type: "array",
      items: {
        type: "object",
        // The subject comes first, so the model works out what the tab is about before picking a group.
        properties: { tab: { type: "integer" }, subject: { type: "string" }, group: { type: "string" } },
        required: ["tab", "subject", "group"],
      },
    },
  },
  required: ["tabs"],
};

const MIN_BATCH = 3;
/** Rough number of tokens the answer uses per item. */
const OUTPUT_TOKENS_PER_ITEM = 30;

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

export function buildPrompt(input: SortInput, topics: string[], batch: TabInfo[]): string {
  const lines: string[] = ["Groups:"];
  input.userGroups.forEach((g, i) => {
    lines.push(`U${i + 1}: ${quote(g.name)} (proposed by the user)${g.hint ? `. Hint: ${clip(g.hint, 120)}` : ""}`);
  });
  input.existingGroups.forEach(({ group, tabs }, i) => {
    const examples = tabs
      .slice(0, 8)
      .map((t) => quote(clip(cleanTitle(t.title, t.url), 60)))
      .join("; ");
    lines.push(`E${i + 1}: ${quote(group.title || "Unnamed group")} (existing group)${examples ? `. It holds: ${examples}` : ""}`);
  });
  topics.forEach((name, i) => lines.push(`N${i + 1}: ${quote(name)} (new topic, already used for other tabs)`));
  if (lines.length === 1) lines.push("None yet.");
  lines.push("", "Tabs:");
  batch.forEach((t, i) => {
    const title = cleanTitle(t.title, t.url);
    // The website only helps with very short titles ("useEffect"); otherwise it tempts the model to group by site.
    const short = title.split(/\s+/).length < 4;
    lines.push(`${i + 1}. ${clip(title, 100)}${short && hostOf(t.url) ? ` (on ${hostOf(t.url)})` : ""}`);
  });
  lines.push(
    "",
    `For each of the ${batch.length} tabs, answer with its number, its subject, and its group: a group id, a new topic name, or "none".`,
  );
  return lines.join("\n");
}

/** Reads the model's answer into tab number -> { subject, group }. Throws when it isn't the expected JSON. */
export function parseAnswer(raw: string): Map<number, { subject: string; group: string }> {
  const json = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const data = JSON.parse(json) as { tabs?: { tab?: unknown; subject?: unknown; group?: unknown }[] };
  if (!Array.isArray(data.tabs)) throw new Error("Answer has no tabs");
  const out = new Map<number, { subject: string; group: string }>();
  for (const a of data.tabs) {
    if (typeof a.tab === "number" && typeof a.group === "string") {
      out.set(a.tab, { subject: typeof a.subject === "string" ? a.subject : "", group: a.group });
    }
  }
  return out;
}

/** The complete answers in an answer that was cut off part way. */
export function parsePartialAnswer(raw: string): Map<number, { subject: string; group: string }> {
  const out = new Map<number, { subject: string; group: string }>();
  for (const m of raw.matchAll(/\{[^{}]*\}/g)) {
    try {
      const a = JSON.parse(m[0]) as { tab?: unknown; subject?: unknown; group?: unknown };
      if (typeof a.tab === "number" && typeof a.group === "string") out.set(a.tab, { subject: String(a.subject ?? ""), group: a.group });
    } catch {
      // Not finished.
    }
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

/**
 * Sorts tabs with a language model (see ./model.ts for the models it can use).
 * For each tab the model writes a subject and then picks a group, in one answer.
 * - Tabs go to the model in batches that fit its context window. Topic names
 *   from earlier batches are offered to later ones, so topics stay consistent.
 * - Answers are remembered per tab until forget() is called, so re-scans only ask about new tabs
 *   and suggestions stay put while the user reviews them.
 * - Website names are rejected as topics; a topic with a single tab goes to Leftovers.
 * - Tabs the model fails on are sorted by website.
 */
export class ModelSorter implements Sorter {
  readonly label: string;
  /** Tabs the model failed on in the last sort, which were sorted by website instead. */
  lastFallbackCount = 0;
  /** The last error from the model in the last sort, if any. */
  lastError: string | null = null;
  /** Whether the user stopped the last sort before the model was done. */
  stopped = false;
  private cache = new Map<string, { subject: string; target: SortTarget }>();
  private lastSubjects = new Map<number, string>();

  constructor(
    readonly model: Model,
    private readonly fallback: Sorter = new SiteSorter(),
  ) {
    this.label = `Sorted by ${model.name}`;
  }

  /**
   * Forgets every remembered answer, so the next sort asks about all tabs again.
   * Answers are otherwise kept, so suggestions don't shift while the user reviews them.
   */
  forget(): void {
    this.cache.clear();
  }

  /** What the model said the tab is about, from the last sort. */
  subjectOf(tabId: number): string | undefined {
    return this.lastSubjects.get(tabId);
  }

  async sort(input: SortInput, options: SortOptions = {}): Promise<Map<number, SortTarget>> {
    const { signal, onProgress, onModel, stop } = options;
    const modelSignal = stop && signal ? AbortSignal.any([signal, stop]) : (stop ?? signal);
    this.lastError = null;
    this.stopped = false;
    const siteLabels = new Set(
      [...input.tabs, ...input.existingGroups.flatMap((g) => g.tabs)].map((t) => siteLabel(t.url)).filter((l): l is string => !!l),
    );

    const result = new Map<number, SortTarget>();
    this.lastSubjects = new Map();
    const todo: TabInfo[] = [];
    for (const t of input.tabs) {
      const hit = this.cache.get(tabKey(t));
      if (hit) {
        result.set(t.id, hit.target);
        if (hit.subject) this.lastSubjects.set(t.id, hit.subject);
      } else todo.push(t);
    }

    const topics: string[] = [];
    const addTopic = (name: string) => {
      const found = topics.find((t) => normName(t) === normName(name));
      if (found) return found;
      topics.push(name);
      return name;
    };
    for (const v of result.values()) if (v.kind === "new") addTopic(v.name);

    let batch: TabInfo[] = [];
    let offered: string[] = [];
    let partial = "";
    const useAnswers = (answers: Map<number, { subject: string; group: string }>) => {
      batch.forEach((t, k) => {
        const answer = answers.get(k + 1);
        if (!answer) return;
        let subject = answer.subject.trim().replace(/\s+/g, " ");
        if (isSiteName(subject, siteLabels)) subject = cleanTitle(t.title, t.url);
        subject = clip(subject, 60);
        let target = resolveAnswer(answer.group, input, offered);
        // A website name is not a topic: fall back to the subject, which still groups identical subjects.
        if (target.kind === "new" && isSiteName(target.name, siteLabels)) target = { kind: "new", name: subject };
        if (target.kind === "new") target = { kind: "new", name: addTopic(target.name) };
        this.cache.set(tabKey(t), { subject, target });
        this.lastSubjects.set(t.id, subject);
        result.set(t.id, target);
      });
    };

    onProgress?.(0, todo.length);
    let size = this.model.maxBatch;
    let i = 0;
    while (i < todo.length) {
      signal?.throwIfAborted();
      if (stop?.aborted) break;
      batch = todo.slice(i, i + size);
      partial = "";
      try {
        const request = (prompt: string): ModelRequest => ({ system: SYSTEM_PROMPT, prompt, schema: SCHEMA, signal: modelSignal });
        let prompt = buildPrompt(input, topics, batch);
        while (batch.length > MIN_BATCH && !(await untilAborted(fits(this.model, request(prompt), batch.length), modelSignal))) {
          size = Math.max(MIN_BATCH, Math.floor(batch.length * 0.6));
          batch = todo.slice(i, i + size);
          prompt = buildPrompt(input, topics, batch);
        }
        const ids: Record<string, string> = {};
        input.userGroups.forEach((g, n) => (ids[`U${n + 1}`] = g.name));
        input.existingGroups.forEach(({ group }, n) => (ids[`E${n + 1}`] = group.title || "Unnamed group"));
        topics.forEach((name, n) => (ids[`N${n + 1}`] = name));
        onModel?.({ kind: "input", items: batch.map((t) => cleanTitle(t.title, t.url)), groups: ids });
        offered = [...topics];
        const raw = await untilAborted(this.model.complete({
          ...request(prompt),
          onText: (text) => {
            partial = text;
            onModel?.({ kind: "output", text });
          },
          onStatus: (text) => onModel?.({ kind: "status", text }),
        }), modelSignal);
        useAnswers(parseAnswer(raw));
      } catch (e) {
        if (signal?.aborted) throw e;
        if (stop?.aborted) {
          // Keep the answers the model had finished before it was stopped.
          useAnswers(parsePartialAnswer(partial));
          this.stopped = true;
          break;
        }
        this.lastError = e instanceof Error ? (e.name === "Error" ? e.message : `${e.name}: ${e.message}`) : String(e);
        onModel?.({ kind: "error", text: this.lastError });
        console.warn(`${this.model.name} couldn't sort a batch of tabs; sorting them by website.`, e);
      }
      i += batch.length;
      onProgress?.(i, todo.length);
    }
    if (stop?.aborted) this.stopped = true;

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

/**
 * Rejects as soon as `signal` aborts, even if `promise` never notices: some model
 * calls (such as loading Chrome's built-in model) can't be cancelled.
 */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Stopped", "AbortError"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Whether a request and its answer fit in the model's context. */
async function fits(model: Model, request: ModelRequest, count: number): Promise<boolean> {
  const need = model.measure ? await model.measure(request) : estimateTokens(request.system + request.prompt + JSON.stringify(request.schema));
  return need + count * OUTPUT_TOKENS_PER_ITEM <= model.contextTokens * 0.9;
}
