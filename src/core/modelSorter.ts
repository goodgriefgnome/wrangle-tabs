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
Tabs are listed in the order they sit in the browser, window by window. Tabs next to each other were often opened together, so they are more likely to share a subject. When a tab could fit more than one group, or its title says little, prefer the group of its neighbours, or the group it is marked as next to.
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

/** Where tabs sit: window, then position in the window. */
export const byPosition = (a: TabInfo, b: TabInfo) => a.windowId - b.windowId || a.index - b.index;

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
  // Existing-group tabs by position, to tell the model which group a tab sits next to.
  const groupAt = new Map<string, string>();
  input.existingGroups.forEach(({ tabs }, i) => tabs.forEach((t) => groupAt.set(`${t.windowId}:${t.index}`, `E${i + 1}`)));
  const windows = [...new Set(batch.map((t) => t.windowId))];
  batch.forEach((t, i) => {
    if (windows.length > 1 && (i === 0 || batch[i - 1].windowId !== t.windowId)) {
      lines.push(`(window ${windows.indexOf(t.windowId) + 1})`);
    }
    const title = cleanTitle(t.title, t.url);
    // The website only helps with very short titles ("useEffect"); otherwise it tempts the model to group by site.
    const short = title.split(/\s+/).length < 4;
    const near = [...new Set([t.index - 1, t.index + 1].map((n) => groupAt.get(`${t.windowId}:${n}`)).filter(Boolean))];
    lines.push(
      `${i + 1}. ${clip(title, 100)}${short && hostOf(t.url) ? ` (on ${hostOf(t.url)})` : ""}${near.length ? ` [next to ${near.join(" and ")}]` : ""}`,
    );
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

/** What the sorter knows about each tab right now. */
export interface SortResults {
  /** Tabs the model has answered for. */
  targets: Map<number, SortTarget>;
  /** Tabs the model failed on, or that were skipped when the user stopped it: sort these another way. */
  fallback: TabInfo[];
  /** Tabs still waiting for the model. */
  pending: TabInfo[];
}

export type RunOptions = SortOptions & {
  /** Called whenever new answers arrive, as they stream in. */
  onAnswer?: () => void;
};

/**
 * Sorts tabs with a language model (see ./model.ts for the models it can use).
 * For each tab the model writes a subject and then picks a group, in one answer.
 * - run() works through a queue: before each batch it asks for the current tabs and groups,
 *   so it keeps going across re-scans, and tabs asked about again (forgetTabs) jump the queue.
 * - Answers are stored as they stream in, per tab, until forgotten; results() reads them.
 * - Tabs go to the model in the order they sit in the browser, and the prompt says so,
 *   because neighbouring tabs are more likely to be related.
 * - Batches fit the model's context window. Topic names already in use are offered to later batches.
 * - Website names are rejected as topics. settle() sends single-tab topics to Leftovers, and
 *   puts a leftover between two neighbours of the same group into that group.
 * - Tabs the model fails on, or that are skipped when it's stopped, are left to a fallback sorter.
 */
export class ModelSorter implements Sorter {
  readonly label: string;
  /** Tabs sorted by the fallback in the last sort() (the dashboard sets this too). */
  lastFallbackCount = 0;
  /** The last error from the model in the last run, if any. */
  lastError: string | null = null;
  private cache = new Map<string, { subject: string; target: SortTarget }>();
  private failed = new Set<string>();
  private skipped = new Set<string>();
  private priority = new Set<string>();
  private keys = new Map<number, string>();

  constructor(
    readonly model: Model,
    private readonly fallback: Sorter = new SiteSorter(),
  ) {
    this.label = `Sorted by ${model.name}`;
  }

  /** Whether the user stopped the model before it reached some tabs. */
  get stopped(): boolean {
    return this.skipped.size > 0;
  }

  /** Forgets every answer, failure and skip, so every tab is asked about again. */
  forget(): void {
    this.cache.clear();
    this.failed.clear();
    this.skipped.clear();
    this.priority.clear();
  }

  /** Forgets what is known about these tabs, and asks about them before any others. */
  forgetTabs(tabs: TabInfo[]): void {
    for (const t of tabs) {
      const k = this.key(t);
      this.cache.delete(k);
      this.failed.delete(k);
      this.skipped.delete(k);
      this.priority.add(k);
    }
  }

  /** What the model said the tab is about. */
  subjectOf(tabId: number): string | undefined {
    const k = this.keys.get(tabId);
    return k ? this.cache.get(k)?.subject || undefined : undefined;
  }

  /** "answered", "failed", "skipped" (the user stopped the model) or "pending". */
  statusOf(tab: TabInfo): "answered" | "failed" | "skipped" | "pending" {
    const k = this.key(tab);
    return this.cache.has(k) ? "answered" : this.failed.has(k) ? "failed" : this.skipped.has(k) ? "skipped" : "pending";
  }

  /** Tabs still to ask about, in the order they'll be asked: re-sort requests first, then by position. */
  waiting(tabs: TabInfo[]): TabInfo[] {
    return tabs
      .filter((t) => this.statusOf(t) === "pending")
      .sort((a, b) => Number(this.priority.has(this.key(b))) - Number(this.priority.has(this.key(a))) || byPosition(a, b));
  }

  results(tabs: TabInfo[]): SortResults {
    const out: SortResults = { targets: new Map(), fallback: [], pending: [] };
    for (const t of tabs) {
      const hit = this.cache.get(this.key(t));
      if (hit) out.targets.set(t.id, hit.target);
      else if (this.statusOf(t) === "pending") out.pending.push(t);
      else out.fallback.push(t);
    }
    return out;
  }

  private key(t: TabInfo): string {
    const k = tabKey(t);
    this.keys.set(t.id, k);
    return k;
  }

  /**
   * Asks the model about every waiting tab, batch by batch, until none are left.
   * `getInput` is called before each batch, so tabs and groups may change meanwhile.
   * Stopping (options.stop) keeps the answers so far and skips the rest.
   */
  async run(getInput: () => SortInput, options: RunOptions = {}): Promise<void> {
    const { signal, onProgress, onModel, onAnswer, stop } = options;
    const modelSignal = stop && signal ? AbortSignal.any([signal, stop]) : (stop ?? signal);
    this.lastError = null;
    let done = 0;
    let size = this.model.maxBatch;
    for (;;) {
      signal?.throwIfAborted();
      const input = getInput();
      const todo = this.waiting(input.tabs);
      if (stop?.aborted) {
        for (const t of todo) this.skipped.add(this.key(t));
        break;
      }
      onProgress?.(done, done + todo.length);
      if (!todo.length) break;

      const siteLabels = new Set(
        [...input.tabs, ...input.existingGroups.flatMap((g) => g.tabs)].map((t) => siteLabel(t.url)).filter((l): l is string => !!l),
      );
      // Topics already given to tabs, in browser order.
      const topics: string[] = [];
      const addTopic = (name: string) => {
        const found = topics.find((t) => normName(t) === normName(name));
        if (found) return found;
        topics.push(name);
        return name;
      };
      for (const t of [...input.tabs].sort(byPosition)) {
        const hit = this.cache.get(this.key(t));
        if (hit?.target.kind === "new") addTopic(hit.target.name);
      }

      const request = (prompt: string): ModelRequest => ({ system: SYSTEM_PROMPT, prompt, schema: SCHEMA, signal: modelSignal });
      let batch = todo.slice(0, size);
      const used = new Set<number>();
      let offered: string[] = [];
      const useAnswers = (answers: Map<number, { subject: string; group: string }>) => {
        let added = false;
        batch.forEach((t, k) => {
          const answer = answers.get(k + 1);
          if (!answer || used.has(k)) return;
          used.add(k);
          let subject = answer.subject.trim().replace(/\s+/g, " ");
          if (isSiteName(subject, siteLabels)) subject = cleanTitle(t.title, t.url);
          subject = clip(subject, 60);
          let target = resolveAnswer(answer.group, input, offered);
          // A website name is not a topic: fall back to the subject, which still groups identical subjects.
          if (target.kind === "new" && isSiteName(target.name, siteLabels)) target = { kind: "new", name: subject };
          if (target.kind === "new") target = { kind: "new", name: addTopic(target.name) };
          const key = this.key(t);
          this.cache.set(key, { subject, target });
          this.priority.delete(key);
          added = true;
        });
        if (added) onAnswer?.();
      };

      try {
        let prompt = buildPrompt(input, topics, batch);
        while (batch.length > MIN_BATCH && !(await untilAborted(fits(this.model, request(prompt), batch.length), modelSignal))) {
          size = Math.max(MIN_BATCH, Math.floor(batch.length * 0.6));
          batch = todo.slice(0, size);
          prompt = buildPrompt(input, topics, batch);
        }
        const ids: Record<string, string> = {};
        input.userGroups.forEach((g, n) => (ids[`U${n + 1}`] = g.name));
        input.existingGroups.forEach(({ group }, n) => (ids[`E${n + 1}`] = group.title || "Unnamed group"));
        topics.forEach((name, n) => (ids[`N${n + 1}`] = name));
        onModel?.({ kind: "input", items: batch.map((t) => cleanTitle(t.title, t.url)), tabIds: batch.map((t) => t.id), groups: ids });
        offered = [...topics];
        const raw = await untilAborted(this.model.complete({
          ...request(prompt),
          onText: (text) => {
            onModel?.({ kind: "output", text });
            useAnswers(parsePartialAnswer(text));
          },
          onStatus: (text) => onModel?.({ kind: "status", text }),
        }), modelSignal);
        useAnswers(parseAnswer(raw));
      } catch (e) {
        if (signal?.aborted) throw e;
        if (stop?.aborted) continue; // Skips the rest at the top of the loop.
        this.lastError = e instanceof Error ? (e.name === "Error" ? e.message : `${e.name}: ${e.message}`) : String(e);
        onModel?.({ kind: "error", text: this.lastError });
        console.warn(`${this.model.name} couldn't sort a batch of tabs; sorting them by website.`, e);
      }
      // Tabs the model didn't answer for won't be asked about again until forgotten.
      batch.forEach((t, k) => {
        if (!used.has(k)) this.failed.add(this.key(t));
      });
      done += batch.length;
      onProgress?.(done, done + this.waiting(getInput().tabs).length);
    }
  }

  /** Sorts tabs in one go: the model's answers, the fallback for the rest, settled. */
  async sort(input: SortInput, options: SortOptions = {}): Promise<Map<number, SortTarget>> {
    await this.run(() => input, options);
    const { targets, fallback, pending } = this.results(input.tabs);
    const rest = [...fallback, ...pending];
    this.lastFallbackCount = rest.length;
    if (rest.length) {
      const fb = await this.fallback.sort({ ...input, tabs: rest }, { signal: options.signal });
      for (const [id, target] of fb) targets.set(id, target);
    }
    return settle(input.tabs, targets, true).targets;
  }
}

/**
 * Tidies a set of answers:
 * - A topic needs at least two tabs to become a group. With `final`, a lone topic goes to Leftovers;
 *   otherwise more tabs may still join it, so it is returned as `tentative` instead (tab id -> topic).
 * - A leftover between two neighbours of the same group joins that group.
 */
export function settle(
  tabs: TabInfo[],
  answers: Map<number, SortTarget>,
  final: boolean,
): { targets: Map<number, SortTarget>; tentative: Map<number, string> } {
  const targets = new Map(answers);
  const tentative = new Map<number, string>();
  const counts = new Map<string, number>();
  for (const v of targets.values()) if (v.kind === "new") counts.set(normName(v.name), (counts.get(normName(v.name)) ?? 0) + 1);
  for (const [id, v] of targets) {
    if (v.kind !== "new" || counts.get(normName(v.name))! >= 2) continue;
    if (final) targets.set(id, { kind: "left" });
    else {
      targets.delete(id);
      tentative.set(id, v.name);
    }
  }
  fillBetweenNeighbours(tabs, targets);
  return { targets, tentative };
}

const sameTarget = (a: SortTarget, b: SortTarget) =>
  a.kind === b.kind &&
  (a.kind === "existing" ? a.groupId === (b as typeof a).groupId
    : a.kind === "user" ? a.id === (b as typeof a).id
    : a.kind === "new" ? normName(a.name) === normName((b as typeof a).name)
    : true);

/**
 * A leftover tab whose nearest neighbours on both sides (in the same window, among the tabs
 * being sorted) go to the same group joins that group: tabs that sit together tend to belong together.
 */
export function fillBetweenNeighbours(tabs: TabInfo[], result: Map<number, SortTarget>): void {
  const sorted = [...tabs].sort(byPosition);
  const before = new Map(result);
  sorted.forEach((t, i) => {
    if (before.get(t.id)?.kind !== "left") return;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    if (!prev || !next || prev.windowId !== t.windowId || next.windowId !== t.windowId) return;
    const a = before.get(prev.id);
    const b = before.get(next.id);
    if (a && b && a.kind !== "left" && sameTarget(a, b)) result.set(t.id, a);
  });
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
