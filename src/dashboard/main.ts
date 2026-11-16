import "./style.css";
import { stableReview, unresolvedSnapshot } from "../core/review";
import { execute, restore, type Destination, type UndoRecord } from "../chrome/direct";
import { applyActions, switchToTab, type Actions } from "../chrome/apply";
import { takeSnapshot } from "../chrome/snapshot";
import { missingSetting, modelFor, requestPermission, type AiChoice, type AiSettings, DEFAULT_AI_SETTINGS } from "../chrome/aiSettings";
import { chromeAiStatus, downloadChromeAi, type ChromeAiStatus } from "../chrome/models/chromeAi";
import { loadState, saveAiSettings, saveLeftoversWindowId, saveUserGroups } from "../chrome/storage";
import { ModelSorter, settle } from "../core/modelSorter";
import { buildPlan, sortInputFor, type ManualTarget, type NewGroupPlan, type Plan, type PlanInput } from "../core/plan";
import { SiteSorter } from "../core/siteSorter";
import type { Sorter, SortTarget } from "../core/sorter";
import { GROUP_COLORS, type GroupColor, type GroupInfo, type Snapshot, type TabInfo, type UserGroup } from "../core/types";

/* ---------------------------------------------------------------- state */

const siteSorter = new SiteSorter();
/** The AI sorter for the current settings; rebuilt when they change, which also drops its remembered answers. */
let modelSorter: ModelSorter | null = null;

/** AI answers that have arrived but aren't shown yet: per block, and new blocks per section. */
interface Ready {
  total: number;
  byBlock: Map<string, number>;
  ghosts: Map<SectionKey, string[]>;
}
const NO_READY: Ready = { total: 0, byBlock: new Map(), ghosts: new Map() };

const S = {
  snapshot: null as Snapshot | null,
  /** The plan on screen: only the AI answers the user has pulled in. */
  plan: null as Plan | null,
  /** The plan with every AI answer that has arrived. */
  arrived: null as Plan | null,
  ready: NO_READY,
  /** Tabs whose AI answers are shown. */
  pulled: new Set<number>(),
  /** Tabs the AI (or the fallback) has an answer for. */
  answered: [] as number[],
  /** Pull answers in as they arrive, until the user starts reviewing. */
  autoPull: true,
  userGroups: [] as UserGroup[],
  leftoversWindowId: null as number | null,
  /** Tabs the user moved by hand. Re-sorting leaves them where they were put. */
  manual: new Map<number, ManualTarget>(),
  aiOverrides: new Map<string, { name?: string; color?: GroupColor }>(),
  /** Tabs selected for a bulk move or close. */
  selected: new Set<number>(),
  collapsed: new Set<string>(),
  cursor: null as string | null,
  lastIdx: 0,
  filter: "",
  renaming: null as string | null,
  modal: null as null | ((e: KeyboardEvent) => void),
  busy: false,
  /** Progress of a slow (AI) sort, while one is running. */
  sorting: null as null | {
    done: number;
    total: number;
    /** When the current batch went to the model. */
    batchStart?: number;
    /** Titles and tabs in the current batch, the group ids the model may use, and its answer so far. */
    input?: string[];
    tabIds?: number[];
    groupIds?: Record<string, string>;
    output?: string;
    error?: string;
    /** News while waiting, such as "busy, trying again". */
    status?: string;
  },
  ai: DEFAULT_AI_SETTINGS as AiSettings,
  /** Whether Chrome's built-in AI is ready, for the "chrome" choice. */
  aiStatus: "unsupported" as ChromeAiStatus,
  /** Model download progress (0..1) while this page is downloading it. */
  download: null as number | null,
};

let undoRecord: UndoRecord | null = null;
const resolved = new Map<number, string>();

const tabs = new Map<number, TabInfo>();
const groups = new Map<number, GroupInfo>();

/* ---------------------------------------------------------------- helpers */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const listEl = $("#list");
const filterEl = $<HTMLInputElement>("#filter");

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function host(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname || u.protocol.replace(":", "");
  } catch {
    return "";
  }
}

function favicon(url: string): string {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", url);
  u.searchParams.set("size", "32");
  return u.toString();
}

function windowOrder(): number[] {
  const ids = new Set([...tabs.values()].map((t) => t.windowId));
  return [...ids].filter((id) => id !== S.leftoversWindowId).sort((a, b) => a - b);
}
function winShort(id: number): string {
  if (id === S.leftoversWindowId) return "Left";
  return "W" + (windowOrder().indexOf(id) + 1);
}

function majorityWindow(ids: number[]): number | null {
  const counts = new Map<number, number>();
  for (const id of ids) {
    const t = tabs.get(id);
    if (t) counts.set(t.windowId, (counts.get(t.windowId) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function matches(id: number): boolean {
  if (!S.filter) return true;
  const t = tabs.get(id);
  if (!t) return false;
  const q = S.filter.toLowerCase();
  return t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q);
}

function toast(msg: string) {
  const root = $("#toastRoot");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  root.replaceChildren(el);
  clearTimeout((toast as { t?: number }).t);
  (toast as { t?: number }).t = window.setTimeout(() => root.replaceChildren(), msg.length > 100 ? 8000 : 3000);
}

/* ---------------------------------------------------------------- rows */

type SectionKey = "close" | "existing" | "new" | "left" | "wait";

/** A group of suggestions you review and apply as a whole. */
interface Block {
  key: string;
  section: SectionKey;
  groupId?: number;
  newGroup?: NewGroupPlan;
  tabIds: number[];
}

type Row =
  | { type: "info"; text: string; ready?: boolean }
  | { type: "block"; key: string; block: Block }
  | { type: "item"; key: string; section: SectionKey; block: Block; tabId: number };

const SECTION_ORDER: SectionKey[] = ["close", "existing", "new", "left", "wait"];

const itemKey = (_blockKey: string, tabId: number) => `tab:${tabId}`;

function blocksOf(plan: Plan): Block[] {
  return [
    { key: "close", section: "close", tabIds: plan.close.map((c) => c.tabId) },
    ...plan.addToExisting.map((a) => ({
      key: `existing:${a.groupId}`,
      section: "existing" as const,
      groupId: a.groupId,
      tabIds: a.tabIds,
    })),
    ...plan.newGroups.map((g) => ({ key: `new:${g.key}`, section: "new" as const, newGroup: g, tabIds: g.tabIds })),
    { key: "left", section: "left", tabIds: plan.leftovers },
    { key: "wait", section: "wait", tabIds: plan.unsorted.map((u) => u.tabId) },
  ];
}

/** What pulling in would change: arrived answers that land somewhere other than where the tab is shown. */
function computeReady(shown: Plan, arrived: Plan): Ready {
  const where = (plan: Plan) => {
    const m = new Map<number, string>();
    for (const b of blocksOf(plan)) for (const id of b.tabIds) m.set(id, b.key);
    return m;
  };
  const was = where(shown);
  const byBlock = new Map<string, number>();
  let total = 0;
  for (const [id, key] of where(arrived)) {
    if (key === "wait" || was.get(id) === key) continue;
    total++;
    byBlock.set(key, (byBlock.get(key) ?? 0) + 1);
  }
  const visible = new Set(blocksOf(shown).filter((b) => b.tabIds.length || b.newGroup?.mine).map((b) => b.key));
  const ghosts = new Map<SectionKey, string[]>();
  for (const b of blocksOf(arrived)) {
    const n = byBlock.get(b.key);
    if (!n || visible.has(b.key)) continue;
    ghosts.set(b.section, [...(ghosts.get(b.section) ?? []), `${blockName(b)} (${n})`]);
  }
  return { total, byBlock, ghosts };
}

let rows: Row[] = [];
const navRows = () => rows.filter((r): r is Extract<Row, { key: string }> => "key" in r);

function buildRows(plan: Plan): Row[] {
  const out: Row[] = [];
  const blocks = blocksOf(plan);
  for (const section of SECTION_ORDER) {
    const bs = blocks.filter(
      (b) =>
        b.section === section &&
        (S.filter ? b.tabIds.some(matches) : b.tabIds.length > 0 || b.newGroup?.mine),
    );
    const ghosts = S.filter ? [] : (S.ready.ghosts.get(section) ?? []);
    if (!bs.length && !ghosts.length) continue;
    // Group headers provide the hierarchy without repeating section headings.
    for (const b of bs) {
      out.push({ type: "block", key: b.key, block: b });
      if (!S.collapsed.has(b.key)) {
        for (const id of b.tabIds.filter(matches)) out.push({ type: "item", key: itemKey(b.key, id), section, block: b, tabId: id });
      }
      if (b.newGroup?.mine && !b.tabIds.length) out.push({ type: "info", text: "No matching tabs yet. Move tabs here with m." });
    }
    if (section === "close" && !S.filter) for (const text of plan.notes) out.push({ type: "info", text });

  }
  if (!out.length) out.push({ type: "info", text: S.filter ? "No matches." : "All done." });
  return out;
}

/** Whether a block's tabs are all, some or none selected. */
function blockSelection(b: Block): "" | "on" | "part" {
  const n = b.tabIds.filter((id) => S.selected.has(id)).length;
  return n === 0 ? "" : n === b.tabIds.length ? "on" : "part";
}

function blockWindow(b: Block): number | null {
  if (b.section === "left") return S.leftoversWindowId;
  if (b.groupId !== undefined) return groups.get(b.groupId)?.windowId ?? null;
  return majorityWindow(b.tabIds);
}

function blockName(b: Block): string {
  if (b.section === "close") return "Close";
  if (b.section === "left") return "Leftovers window";
  if (b.section === "wait") return "Not sorted yet";
  if (b.groupId !== undefined) return groups.get(b.groupId)?.title || "Unnamed group";
  return b.newGroup!.name;
}

/** What applying a block does, as a button label. */
function applyLabel(b: Block): string {
  const n = b.tabIds.length;
  const tabsWord = `${n} ${n === 1 ? "tab" : "tabs"}`;
  if (b.section === "close") return `Close ${tabsWord}`;
  if (b.section === "left") return `Move ${tabsWord} to Leftovers`;
  if (b.section === "wait") return "Waiting for the AI";
  if (b.section === "existing") return `Add ${tabsWord} to “${blockName(b)}”`;
  return `Create “${blockName(b)}”`;
}

function rowId(key: string) {
  return "r-" + key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The block under the cursor: the group header, or the group of the tab under it. */
function curBlock(): Block | undefined {
  return curRow()?.block;
}

function rowHTML(r: Row): string {
  if (r.type === "info") return `<div class="row info${r.ready ? " readyline" : ""}">${esc(r.text)}</div>`;
  const cur = r.key === S.cursor ? " cur" : "";

  if (r.type === "block") {
    const b = r.block;
    const st = blockSelection(b);
    const caret = `<span class="caret" aria-hidden="true">${S.collapsed.has(b.key) ? "▸" : "▾"}</span>`;
    let name: string;
    let hint = "";
    let meta = "";
    const win = blockWindow(b);
    if (b.section === "close") {
      name = `<span class="chip closechip">Duplicates</span>`;
    } else if (b.section === "wait") {
      name = `<span class="chip ghost">Unsorted</span>`;
    } else if (b.section === "left") {
      name = `<span class="chip ghost">Ungrouped</span>`;
      meta = `<span class="win">${win !== null ? winShort(win) : "new window"}</span>`;
    } else if (b.groupId !== undefined) {
      const g = groups.get(b.groupId);
      name = S.renaming === b.key ? `<input class="rename" id="rename-input" value="${esc(g?.title || "")}" aria-label="Group name">` : `<span class="chip outline" style="--c: var(--tg-${g?.color ?? "grey"})">${esc(g?.title || "Unnamed group")}</span>`;
      meta = `<span class="win">existing${win !== null ? " · " + winShort(win) : ""}</span>`;
    } else {
      const g = b.newGroup!;
      name =
        S.renaming === b.key
          ? `<input class="rename" id="rename-input" value="${esc(g.name)}" aria-label="Group name">`
          : `<span class="chip" style="--c: var(--tg-${g.color})">${esc(g.name)}</span>`;
      hint = g.hint;
      meta = (g.mine ? `<span class="chip ghost">yours</span>` : "") + `<span class="win">new${win !== null ? " · " + winShort(win) : ""}</span>`;
    }
    const ready = S.ready.byBlock.get(b.key);
    if (ready) meta += `<span class="ready">+${ready} ready</span>`;
    const isCurBlock = !S.selected.size && curBlock()?.key === b.key;
    const apply = b.tabIds.length && b.section !== "wait"
      ? `<button type="button" class="applybtn${isCurBlock ? " primary" : ""}" data-apply="${esc(b.key)}" ${S.selected.size ? "disabled" : ""} aria-label="${esc(applyLabel(b))}">${b.section === "left" ? "Move to window" : b.section === "close" ? "Close duplicates" : "Accept"}${isCurBlock ? "<kbd>⇧↵</kbd>" : ""}</button>`
      : "";
    return `<div class="row block on-row${cur}" id="${rowId(r.key)}" data-key="${esc(r.key)}" role="option" aria-selected="${st === "on"}">${caret}<input type="checkbox" tabindex="-1" class="cb ${st}" data-cb data-partial="${st === "part"}" ${st === "on" ? "checked" : ""} aria-label="Select ${esc(blockName(b))}">${name}<span class="title hintx">${esc(hint)}</span>${meta}${apply}</div>`;
  }

  const t = tabs.get(r.tabId);
  if (!t) return "";
  const on = S.selected.has(r.tabId);
  let tail: string;
  if (r.section === "close") {
    const keepId = S.plan!.close.find((c) => c.tabId === r.tabId)?.keepId;
    const k = keepId !== undefined ? tabs.get(keepId) : undefined;
    const why = k
      ? `duplicate · keeps ${winShort(k.windowId)}${k.pinned ? " pinned" : ""}${k.groupId !== -1 ? " " + esc(groups.get(k.groupId)?.title || "group") : ""}`
      : "marked by you";
    tail = `<span class="win" title="${esc(k ? `Keeps ${k.title} — ${k.url}` : "Marked for closing")}">${winShort(t.windowId)} · ${why}</span>`;
  } else if (r.section === "wait") {
    const topic = S.plan!.unsorted.find((u) => u.tabId === r.tabId)?.topic;
    const state = S.answered.includes(r.tabId) && !S.pulled.has(r.tabId)
      ? `<span class="mv">ready</span>`
      : topic
        ? `→ “${esc(topic)}”?`
        : S.sorting?.tabIds?.includes(r.tabId)
          ? "reading…"
          : "waiting";
    tail = `<span class="win">${winShort(t.windowId)} · ${state}</span>`;
  } else {
    const target = blockWindow(r.block);
    tail =
      r.section === "left" && target === null
        ? `<span class="win">${winShort(t.windowId)} <span class="mv">→ new window</span></span>`
        : target !== null && target !== t.windowId
          ? `<span class="win">${winShort(t.windowId)} <span class="mv">→ ${winShort(target)}</span></span>`
          : `<span class="win">${winShort(t.windowId)}</span>`;
  }
  return (
    `<div class="row item on-row${on ? " sel" : ""}${cur}" id="${rowId(r.key)}" data-key="${esc(r.key)}" role="option" aria-selected="${on}">` +
    `<input type="checkbox" tabindex="-1" class="cb ${on ? "on" : ""}" data-cb ${on ? "checked" : ""} aria-label="Select ${esc(t.title)}"><img class="fav" src="${esc(favicon(t.url))}" alt="">` +
    `<span class="title">${esc(t.title)}</span><span class="host">${esc(host(t.url))}</span>${tail}${cur ? `<span class="row-actions"><button data-move aria-label="Move ${S.selected.size ? S.selected.size + " selected tabs" : "tab"}"><span class="action-word">${S.selected.size ? S.selected.size + " · " : ""}Move</span><kbd>m</kbd></button><button data-close-tab aria-label="Close ${S.selected.size ? S.selected.size + " selected tabs" : "tab"}"><span class="action-word">Close</span><kbd>#</kbd></button></span>` : ""}</div>`
  );
}

/* ---------------------------------------------------------------- render */

function render() {
  renderSorter();
  if (!S.plan) {
    listEl.innerHTML = `<div class="row info">${S.sorting ? "Sorting your tabs with AI. Progress is shown above." : "Reading your tabs…"}</div>`;
    return;
  }
  rows = buildRows(S.plan);
  const nav = navRows();
  if (!nav.some((r) => r.key === S.cursor)) {
    S.cursor = nav.length ? nav[Math.min(S.lastIdx, nav.length - 1)].key : null;
  }
  setHTML(listEl, rows.map(rowHTML).join(""));
  for (const checkbox of listEl.querySelectorAll<HTMLInputElement>("input[data-partial]")) checkbox.indeterminate = checkbox.dataset.partial === "true";
  if (S.cursor) listEl.setAttribute("aria-activedescendant", rowId(S.cursor));
  else listEl.removeAttribute("aria-activedescendant");
  if (S.renaming) {
    const input = $<HTMLInputElement>("#rename-input");
    input?.focus();
    input?.select();
  }
  renderSummary();
  renderStatusLine();
}

/** The changes that applying one block makes. */
function blockActions(b: Block): Actions {
  const none: Actions = { close: [], addToExisting: [], newGroups: [], leftovers: [] };
  if (b.section === "close") return { ...none, close: b.tabIds };
  if (b.section === "left") return { ...none, leftovers: b.tabIds };
  if (b.groupId !== undefined) return { ...none, addToExisting: [{ groupId: b.groupId, tabIds: b.tabIds }] };
  const g = b.newGroup!;
  return { ...none, newGroups: [{ name: g.name, color: g.color, tabIds: b.tabIds }] };
}

function renderSummary() {
  $("#undo").toggleAttribute("disabled", !undoRecord || S.busy);
}

function renderStatusLine() {
  const r = curRow();
  $("#cururl").textContent = r?.type === "item" ? tabs.get(r.tabId)?.url ?? "" : "";
}

/** Why sorting falls back to websites with the current AI settings, or null when the AI is in use. */
function whyNoAi(): string | null {
  if (S.ai.choice === "site") return "AI is switched off in AI settings";
  if (S.ai.choice === "chrome") {
    const why: Record<ChromeAiStatus, string | null> = {
      available: null,
      downloadable: "the on-device AI model isn't downloaded yet",
      downloading: "the on-device AI model is still downloading",
      unavailable: "Chrome says on-device AI isn't available on this computer",
      unsupported: "this Chrome has no on-device AI (needs Chrome 138 or later)",
    };
    return why[S.aiStatus];
  }
  const missing = missingSetting(S.ai);
  if (missing) return `AI settings are missing ${missing}`;
  return null;
}

/* ---------------------------------------------------------------- data */

async function rescan() {
  try { S.snapshot = await takeSnapshot(S.leftoversWindowId); }
  catch (e) { toast(`Couldn't read tabs: ${e instanceof Error ? e.message : e}`); return; }
  if (S.snapshot.leftoversWindowId !== S.leftoversWindowId) {
    S.leftoversWindowId = S.snapshot.leftoversWindowId;
    await saveLeftoversWindowId(S.leftoversWindowId);
  }
  tabs.clear();
  for (const t of S.snapshot.tabs) tabs.set(t.id, t);
  for (const id of S.selected) if (!tabs.has(id)) S.selected.delete(id);
  groups.clear();
  for (const g of S.snapshot.groups) groups.set(g.id, g);
  const remainingUserGroups = S.userGroups.filter(user => !S.snapshot!.groups.some(group => group.title === user.name));
  if (remainingUserGroups.length !== S.userGroups.length) { S.userGroups = remainingUserGroups; await saveUserGroups(S.userGroups); }
  // Forget hand moves for tabs that are gone.
  for (const id of S.manual.keys()) {
    const t = tabs.get(id);
    if (!t) S.manual.delete(id);
  }
  await refresh();
}

function activeSorter(): Sorter {
  if (whyNoAi()) return siteSorter;
  if (!modelSorter) {
    const model = modelFor(S.ai);
    modelSorter = model ? new ModelSorter(model, siteSorter) : null;
  }
  return modelSorter ?? siteSorter;
}

function planInput(): PlanInput {
  return { snapshot: unresolvedSnapshot(S.snapshot!, resolved), userGroups: S.userGroups, manual: S.manual, aiOverrides: S.aiOverrides };
}

/**
 * The AI run working through the tabs, if one is going. It keeps going across re-scans and
 * applies, picking up new tabs and the current groups before each batch.
 */
let job: { sorter: ModelSorter; abort: AbortController; stop: AbortController } | null = null;
/** Sorters whose run broke unexpectedly; not restarted until asked to re-sort. */
const crashed = new WeakSet<ModelSorter>();

function cancelJob() {
  if (!job) return;
  job.abort.abort();
  job = null;
  S.sorting = null;
}

/** Starts an AI run when there are tabs waiting for one and none is going. */
function ensureSorting() {
  const sorter = activeSorter();
  if (!(sorter instanceof ModelSorter) || !S.snapshot) return cancelJob();
  if (job?.sorter === sorter) return;
  cancelJob();
  if (crashed.has(sorter) || !sorter.waiting(sortInputFor(planInput()).tabs).length) return;
  const me = { sorter, abort: new AbortController(), stop: new AbortController() };
  job = me;
  S.sorting = { done: 0, total: 0 };
  const mine = () => job === me;
  sorter
    .run(() => sortInputFor(planInput()), {
      signal: me.abort.signal,
      stop: me.stop.signal,
      onProgress: (done, total) => {
        if (!mine() || !S.sorting) return;
        Object.assign(S.sorting, { done, total });
        renderSorter();
      },
      onModel: (event) => {
        if (!mine() || !S.sorting) return;
        if (event.kind === "input")
          Object.assign(S.sorting, { input: event.items, tabIds: event.tabIds, groupIds: event.groups, output: "", error: undefined, status: undefined, batchStart: Date.now() });
        else if (event.kind === "output") Object.assign(S.sorting, { output: event.text, status: undefined });
        else if (event.kind === "status") S.sorting.status = event.text;
        else S.sorting.error = event.text;
        renderBanner();
      },
      onAnswer: () => {
        if (mine()) scheduleRefresh();
      },
    })
    .catch((e) => {
      if (me.abort.signal.aborted) return;
      crashed.add(sorter);
      console.error(e);
      toast(`The AI run broke: ${e instanceof Error ? e.message : String(e)}`);
    })
    .finally(() => {
      if (!mine()) return;
      job = null;
      S.sorting = null;
      void refresh();
    });
}

let refreshTimer = 0;
/** Refreshes soon, at most a few times a second, while answers stream in. */
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    void refresh();
  }, 400);
}

let refreshGeneration = 0;

/**
 * Rebuilds the plan on screen (with the AI answers pulled in so far) and the plan with every
 * answer that has arrived, and starts the AI on tabs that are waiting for it.
 */
async function refresh() {
  if (!S.snapshot) return;
  const generation = ++refreshGeneration;
  const previous = S.plan;
  const input = planInput();
  const sortInput = sortInputFor(input);
  const sorter = activeSorter();
  if (!(sorter instanceof ModelSorter)) {
    cancelJob();
    const sorted = await sorter.sort(sortInput);
    if (generation !== refreshGeneration) return;
    S.plan = buildPlan(input, sorted);
    S.arrived = null;
    S.answered = [];
  } else {
    ensureSorting();
    const running = job !== null;
    const r = sorter.results(sortInput.tabs);
    // With no run going, tabs still waiting can't get an answer: sort them by website too.
    const fallbackTabs = running ? r.fallback : [...r.fallback, ...r.pending];
    const fb = fallbackTabs.length ? await siteSorter.sort({ ...sortInput, tabs: fallbackTabs }) : new Map<number, SortTarget>();
    if (generation !== refreshGeneration) return;
    sorter.lastFallbackCount = fallbackTabs.length;
    const all = new Map([...r.targets, ...fb]);
    S.answered = [...all.keys()];
    if (S.autoPull) for (const id of S.answered) S.pulled.add(id);
    const view = (answers: Map<number, SortTarget>) => {
      // Lone topics only go to Leftovers once no more tabs can join them.
      const { targets, tentative } = settle(sortInput.tabs, answers, !running && answers.size === all.size);
      const waiting = new Map<number, string | undefined>();
      for (const t of sortInput.tabs) if (!targets.has(t.id)) waiting.set(t.id, tentative.get(t.id));
      return buildPlan(input, targets, waiting);
    };
    S.plan = view(new Map([...all].filter(([id]) => S.pulled.has(id))));
    S.arrived = view(all);
  }
  S.plan = stableReview(previous, S.plan);
  S.ready = S.arrived ? computeReady(S.plan, S.arrived) : NO_READY;
  render();
}

/** u: shows every AI answer that has arrived. The cursor stays put, or moves to the next row that stayed. */
async function pull() {
  if (!S.ready.total) return toast(S.sorting ? "Nothing new yet. The AI is still working." : "Nothing new to pull in.");
  const n = S.ready.total;
  const anchor = S.cursor ? document.getElementById(rowId(S.cursor)) : null;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const oldScroll = window.scrollY;
  const was = S.cursor;
  const before = navRows().map((r) => r.key);
  const at = before.indexOf(was ?? "");
  const r = curRow();
  const follow = r?.type === "item" && r.section !== "wait" ? r.tabId : null;
  for (const id of S.answered) S.pulled.add(id);
  if (r?.type === "item" && S.arrived) {
    for (const block of blocksOf(S.arrived)) if (block.tabIds.includes(r.tabId)) S.collapsed.delete(block.key);
  }
  await refresh();
  const now = navRows();
  if (!now.some((x) => x.key === was)) {
    const same = follow !== null ? now.find((x) => x.type === "item" && x.tabId === follow) : undefined;
    const keys = new Set(now.map((x) => x.key));
    const next = same?.key ?? before.slice(at + 1).find((k) => keys.has(k)) ?? before.slice(0, Math.max(0, at)).reverse().find((k) => keys.has(k));
    if (next) {
      setCursor(next);
      render();
    }
  }
  const newTop = was ? document.getElementById(rowId(was))?.getBoundingClientRect().top : undefined;
  if (anchorTop !== undefined && newTop !== undefined) window.scrollTo(0, oldScroll + newTop - anchorTop);
  toast(`Imported ${n}.`);
}

/** Forgets every AI answer and sorts all tabs again; answers come in as they arrive. */
function resortAll() {
  if (modelSorter) {
    cancelJob();
    modelSorter.forget();
  }
  S.pulled.clear();
  void refresh();
}

/** Asks the AI again about some tabs, ahead of any others. Tabs placed by hand stay put. */
function resortTabs(ids: number[]) {
  const sorter = activeSorter();
  if (!(sorter instanceof ModelSorter)) return toast(`Re-sorting asks the AI again, but ${whyNoAi()}.`);
  const list = ids.map((id) => tabs.get(id)).filter((t): t is TabInfo => !!t && !S.manual.has(t.id));
  if (!list.length) return toast("Nothing to re-sort: you placed these tabs yourself.");
  sorter.forgetTabs(list);
  for (const t of list) S.pulled.delete(t.id);
  void refresh();
  toast(`Asking the AI again about ${list.length} ${list.length === 1 ? "tab" : "tabs"}. Press u when the answers are in.`);
}

/** R: re-sort the selection, the group under the cursor, or everything. */
function openResort() {
  const opts: Option[] = [];
  if (S.selected.size) {
    const ids = [...S.selected];
    opts.push({ label: `Selected tabs`, meta: `${ids.length}`, go: () => {
      S.selected.clear();
      resortTabs(ids);
    } });
  }
  const b = curBlock();
  if (b && b.section !== "close" && b.section !== "wait" && b.tabIds.length) {
    const ids = b.tabIds.filter((id) => !S.manual.has(id));
    if (ids.length) opts.push({ label: blockName(b), color: b.newGroup?.color ?? (b.groupId !== undefined ? groups.get(b.groupId)?.color : undefined), meta: `${ids.length} ${ids.length === 1 ? "tab" : "tabs"}`, go: () => resortTabs(ids) });
  }
  opts.push({ label: "Everything", meta: "forgets all AI answers", go: () => {
    resortAll();
    toast("Sorting all tabs again.");
  } });
  openPicker("Ask the AI again about…", opts);
}

/** A prominent notice above the list: AI progress, or why tabs are only grouped by website. */
/** Sets an element's HTML only when it changed, so buttons inside aren't replaced mid-click. */
const lastHTML = new WeakMap<Element, string>();
function setHTML(el: Element, html: string) {
  if (lastHTML.get(el) === html) return;
  lastHTML.set(el, html);
  el.innerHTML = html;
}

function renderBanner() {
  const sorter = activeSorter();
  const error = sorter instanceof ModelSorter ? sorter.lastError : undefined;
  $("#sorter").title = error ?? "";
}

// Keeps the "so far" seconds counting while the model works on a batch.
setInterval(() => {
  if (S.sorting?.batchStart) renderBanner();
}, 1000);

function onAiAction(e: Event) {
  const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "download") void startDownload();
  else if (act === "settings") openAiSettings();
  else if (act === "pull") void pull();
  else if (act === "retry") {
    const sorter = activeSorter();
    if (sorter instanceof ModelSorter && S.snapshot) {
      resortTabs(sortInputFor(planInput()).tabs.filter((t) => sorter.statusOf(t) === "failed").map((t) => t.id));
    }
  }
  else if (act === "stop") {
    job?.stop.abort();
    toast("Stopped. The tabs the AI hadn't reached are sorted by website.");
  }
}
$("#sorter").addEventListener("click", onAiAction);

function renderSorter() {
  renderBanner();
  const ready = S.ready.total;
  const sorter = activeSorter();
  const name = sorter instanceof ModelSorter ? sorter.model.name : "Website";
  const fallback = sorter instanceof ModelSorter ? sorter.lastFallbackCount : 0;
  const error = sorter instanceof ModelSorter ? sorter.lastError : null;
  const unavailable = whyNoAi();
  const status = S.sorting ? `${name} · Sorting ${S.sorting.done}/${S.sorting.total}` : S.download !== null ? `Downloading ${Math.round(S.download * 100)}%` : error ? `${name} · ${fallback} by website · AI error` : ready ? `${name} · Finished` : unavailable && S.ai.choice !== "site" ? "Website · AI unavailable" : `${name} · Up to date`;
  setHTML($("#sorter"), `<span class="ai-status">${esc(status)}</span><span class="ai-actions">${ready ? `<button data-act="pull">Import ${ready} ready<kbd>u</kbd></button>` : ""}${S.sorting ? `<button data-act="stop">Stop</button>` : ""}</span>`);
}

/** Applies new AI settings and re-sorts. */
async function setAiSettings(ai: AiSettings) {
  S.ai = ai;
  modelSorter = null;
  S.pulled.clear();
  await saveAiSettings(ai);
  if (ai.choice === "chrome") S.aiStatus = await chromeAiStatus();
  renderSorter();
  await refresh();
}

/** `resume` joins a download that is already running, without asking for a click. */
async function startDownload(resume = false) {
  S.download = 0;
  // Start the download first: Chrome only allows it straight after a click.
  const done = downloadChromeAi((f) => {
    S.download = f;
    renderSorter();
  });
  renderSorter();
  try {
    await done;
    S.download = null;
    S.aiStatus = await chromeAiStatus();
    // Only re-sort; never change the choice, which the user may have changed meanwhile.
    modelSorter = null;
    S.pulled.clear();
      renderSorter();
    await refresh();
  } catch (e) {
    S.download = null;
    S.aiStatus = await chromeAiStatus();
    renderSorter();
    if (!resume) toast(`Couldn't download the AI model: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function openAiSettings() {
  const a = S.ai;
  const chromeNote: Record<ChromeAiStatus, string> = {
    available: "Ready.",
    downloadable: "Needs a one-time download of a few GB.",
    downloading: "Downloading.",
    unavailable: "Not available on this computer.",
    unsupported: "Needs Chrome 138 or later.",
  };
  const radio = (choice: AiChoice, title: string, note: string, fields = "") =>
    `<label class="choice"><input type="radio" name="ai-choice" value="${choice}"${a.choice === choice ? " checked" : ""}>` +
    `<span><strong>${title}</strong><small>${note}</small></span></label>${fields ? `<div class="fields" data-for="${choice}">${fields}</div>` : ""}`;
  const field = (id: string, label: string, value: string, extra = "") =>
    `<label class="field"><span>${label}</span><input id="${id}" value="${esc(value)}" autocomplete="off" spellcheck="false"${extra}></label>`;
  showOverlay(`<div class="dialog wide" role="dialog" aria-modal="true" aria-label="AI settings">
    <header>AI settings<small>Which AI groups your tabs by subject. ↑↓ to choose · Tab to move between fields · Enter to save · Esc to cancel</small></header>
    <div class="body settings">
      ${radio("chrome", "Chrome's built-in AI", `Runs on this computer; nothing is sent anywhere. ${chromeNote[S.aiStatus]}`)}
      ${radio(
        "gemini",
        "Gemini API",
        `Google's online model, with a free tier. Get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Tab titles are sent to Google, which may use free-tier data to improve its products.`,
        field("ai-gemini-key", "API key", a.gemini.apiKey, ' type="password"') + field("ai-gemini-model", "Model", a.gemini.model),
      )}
      ${radio(
        "openai",
        "OpenAI-compatible API",
        "OpenRouter, Groq, a local Ollama or LM Studio, and others. Tab titles are sent to that service.",
        field("ai-openai-url", "Address", a.openai.baseUrl, ' placeholder="https://openrouter.ai/api/v1"') +
          field("ai-openai-key", "API key", a.openai.apiKey, ' type="password" placeholder="Not needed for local servers"') +
          field("ai-openai-model", "Model", a.openai.model, ' placeholder="e.g. google/gemma-4-31b-it:free"'),
      )}
      ${radio("site", "No AI", "Group tabs by website.")}
      ${activeSorter() instanceof ModelSorter && modelSorter?.lastError ? `<p class="error">${esc(modelSorter.lastError)}</p>` : ""}
      ${whyNoAi() ? `<p>${esc(whyNoAi()!)}</p>` : ""}
      ${S.aiStatus === "downloadable" || S.aiStatus === "downloading" ? `<button type="button" id="ai-download">Download on-device model</button>` : ""}
      <p class="error" id="ai-error" hidden></p>
    </div>
    <footer><button type="button" id="ai-cancel">Cancel<kbd>esc</kbd></button><button type="button" class="primary" id="ai-save">Save<kbd>↵</kbd></button></footer></div>`);
  const value = (id: string) => $<HTMLInputElement>(`#${id}`).value;
  const choice = () => (document.querySelector<HTMLInputElement>('input[name="ai-choice"]:checked')?.value ?? "chrome") as AiChoice;
  const showFields = () => {
    for (const f of document.querySelectorAll<HTMLElement>(".settings .fields")) f.hidden = f.dataset.for !== choice();
  };
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="ai-choice"]')) r.addEventListener("change", showFields);
  showFields();
  const save = async () => {
    const next: AiSettings = {
      choice: choice(),
      gemini: { apiKey: value("ai-gemini-key").trim(), model: value("ai-gemini-model").trim() || DEFAULT_AI_SETTINGS.gemini.model },
      openai: { baseUrl: value("ai-openai-url").trim(), apiKey: value("ai-openai-key").trim(), model: value("ai-openai-model").trim() },
    };
    const error = $("#ai-error");
    const missing = missingSetting(next);
    if (missing) {
      error.textContent = `Please fill in ${missing}.`;
      error.hidden = false;
      return;
    }
    // Asking for permission needs the click or key press that's happening right now. Saving doesn't wait
    // for the answer: without the permission, the extension still tries, and errors say what went wrong.
    void requestPermission(next);
    closeModal();
    await setAiSettings(next);
  };
  S.modal = (e) => {
    if (e.key === "Escape") closeModal();
    else if (e.key === "Enter" && !(e.target as HTMLElement).closest("a, button")) void save();
    else return;
    e.preventDefault();
  };
  document.querySelector("#ai-download")?.addEventListener("click", () => { closeModal(); void startDownload(); });
  $("#ai-save").addEventListener("click", () => void save());
  $("#ai-cancel").addEventListener("click", closeModal);
  document.querySelector<HTMLInputElement>('input[name="ai-choice"]:checked')?.focus();
}

/* ---------------------------------------------------------------- actions */

function curRow() {
  return navRows().find((r) => r.key === S.cursor);
}

function setCursor(key: string | null) {
  S.cursor = key;
  const idx = navRows().findIndex((r) => r.key === key);
  if (idx >= 0) S.lastIdx = idx;
  requestAnimationFrame(() => { if (!S.modal) document.getElementById(rowId(key ?? ""))?.scrollIntoView({ block: "nearest" }); });
}

function moveCursor(d: number) {
  const nav = navRows();
  if (!nav.length) return;
  let i = nav.findIndex((r) => r.key === S.cursor);
  i = Math.max(0, Math.min(nav.length - 1, i + d));
  setCursor(nav[i].key);
  render();
}

function jumpSection(d: number) {
  const headers = navRows().filter(r => r.type === "block");
  const key = curBlock()?.key;
  const at = headers.findIndex(r => r.key === key);
  const next = headers[Math.max(0, Math.min(headers.length - 1, at + d))];
  if (next) { setCursor(next.key); render(); }
}

/** Selects or unselects a tab, or all of a group's tabs. */
function toggleSelect(r = curRow()) {
  if (!r) return;
  const ids = r.type === "block" ? r.block.tabIds : [r.tabId];
  const all = ids.every((id) => S.selected.has(id));
  for (const id of ids) all ? S.selected.delete(id) : S.selected.add(id);
  render();
}

/** The tabs a bulk action applies to: the selection, or else the tab under the cursor. */
function actionTabs(): number[] {
  if (S.selected.size) return [...S.selected];
  const r = curRow();
  return r?.type === "item" ? [r.tabId] : [];
}

/** Puts tabs where the user said, keeps them there through re-sorts, and clears the selection. */
async function direct(ids: number[], destination: Destination) {
  if (S.busy || !ids.length) return;
  S.busy = true;
  S.autoPull = false;
  try {
    const result = await execute(ids, destination);
    if (result.undo.originals.length) undoRecord = result.undo;
    for (const id of result.succeeded) {
      const tab = tabs.get(id);
      if (tab) resolved.set(id, tab.url);
      S.selected.delete(id);
    }
    await chrome.storage.session.set({ resolved: [...resolved] });
    toast(result.errors.length ? result.errors.join("; ") : destination.kind === "close" ? `Closed ${result.succeeded.length}. Undo reopens URLs.` : `Moved ${result.succeeded.length}.`);
  } catch (e) { toast(`Couldn't complete action: ${e instanceof Error ? e.message : e}`); }
  finally { S.busy = false; await rescan(); }
}

async function undo() {
  if (!undoRecord || S.busy) return;
  S.busy = true;
  try {
    const result = await restore(undoRecord);
    for (const id of result.restored) resolved.delete(id);
    undoRecord.originals = undoRecord.originals.filter(o => !result.restored.includes(o.tab.id!));
    if (!undoRecord.originals.length && !undoRecord.groupChange) undoRecord = null;
    await chrome.storage.session.set({ resolved: [...resolved] });
    toast(result.errors.length ? result.errors.join("; ") : "Undone.");
  } catch (e) { toast(`Couldn't undo: ${e instanceof Error ? e.message : e}`); } finally { S.busy = false; await rescan(); }
}

async function moveTabs(ids: number[], target: ManualTarget) {
  if (target.kind === "new") {
    const group = S.plan?.newGroups.find(g => g.key === target.key);
    if (group) await direct(ids, { kind: "new", name: group.name, color: group.color });
  } else await direct(ids, target.kind === "left" ? { kind: "ungrouped" } : target);
}

async function markClose() {
  const ids = actionTabs();
  if (!ids.length) return toast("Focus or select tabs first.");
  await direct(ids, { kind: "close" });
}

function collapse(r = curRow()) {
  if (!r) return;
  if (r.type === "item") setCursor(r.block.key);
  else if (r.type === "block") S.collapsed.add(r.block.key);
  render();
}

function expand(r = curRow()) {
  if (r?.type === "block") {
    S.collapsed.delete(r.block.key);
    render();
  }
}

function newGroupOf(r: Extract<Row, { key: string }> | undefined): NewGroupPlan | undefined {
  return r?.block.newGroup;
}

async function cycleColor() {
  const r = curRow();
  if (r?.block.groupId !== undefined) {
    const g = groups.get(r.block.groupId)!;
    await updateExisting(g.id, { color: GROUP_COLORS[(GROUP_COLORS.indexOf(g.color) + 1) % GROUP_COLORS.length] });
    return;
  }
  const g = newGroupOf(r);
  if (!g) return toast(r?.block.section === "existing" ? "Existing groups keep their color." : "Put the cursor on a new group first.");
  const color = GROUP_COLORS[(GROUP_COLORS.indexOf(g.color) + 1) % GROUP_COLORS.length];
  await updateNewGroup(g, { color });
}

async function updateNewGroup(g: NewGroupPlan, change: { name?: string; color?: GroupColor }) {
  if (g.mine) {
    const id = g.key.slice("user:".length);
    S.userGroups = S.userGroups.map((u) => (u.id === id ? { ...u, ...change } : u));
    await saveUserGroups(S.userGroups);
  } else {
    S.aiOverrides.set(g.key, { ...S.aiOverrides.get(g.key), ...change });
  }
  await refresh();
}

async function updateExisting(id: number, change: { title?: string; color?: GroupColor }) {
  if (S.busy) return;
  S.busy = true;
  try {
    const before = await chrome.tabGroups.get(id);
    await chrome.tabGroups.update(id, change);
    const after = await chrome.tabGroups.get(id);
    undoRecord = { originals: [], groupChange: { before, after } };
    toast("Updated group.");
  } catch (e) { toast(`Couldn't update group: ${e instanceof Error ? e.message : e}`); }
  finally { S.busy = false; await rescan(); }
}

function startRename() {
  const r = curRow();
  if (r?.block.groupId !== undefined) { S.renaming = r.block.key; setCursor(S.renaming); render(); return; }
  const g = newGroupOf(r);
  if (!g) return toast(r?.block.section === "existing" ? "Rename existing groups in Chrome itself." : "Put the cursor on a new group first.");
  S.renaming = `new:${g.key}`;
  setCursor(S.renaming);
  render();
}

async function finishRename(save: boolean) {
  const key = S.renaming;
  if (!key) return;
  const input = $<HTMLInputElement>("#rename-input");
  const value = input?.value.trim() ?? "";
  S.renaming = null;
  const g = S.plan?.newGroups.find((x) => `new:${x.key}` === key);
  if (save && value && key.startsWith("existing:")) await updateExisting(Number(key.slice(9)), { title: value });
  else if (save && g && value && value !== g.name) await updateNewGroup(g, { name: value });
  else render();
  listEl.focus();
}

listEl.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).id !== "rename-input") return;
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    void finishRename(true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    void finishRename(false);
  }
});
listEl.addEventListener("focusout", (e) => {
  if ((e.target as HTMLElement).id === "rename-input" && S.renaming) void finishRename(true);
});

function nextUserColor(): GroupColor {
  const used = new Set([...groups.values()].map((g) => g.color).concat(S.plan?.newGroups.map((g) => g.color) ?? []));
  return GROUP_COLORS.find((c) => c !== "grey" && !used.has(c)) ?? GROUP_COLORS[(S.userGroups.length + 1) % GROUP_COLORS.length];
}

async function deleteUserGroup() {
  const g = newGroupOf(curRow());
  if (!g?.mine) return toast("Only groups you proposed can be deleted.");
  const id = g.key.slice("user:".length);
  S.userGroups = S.userGroups.filter((u) => u.id !== id);
  for (const [tabId, m] of S.manual) if (m.kind === "new" && m.key === g.key) S.manual.delete(tabId);
  await saveUserGroups(S.userGroups);
  resortAll();
  toast(`Deleted “${g.name}”. Its tabs went back to the suggestions.`);
}

/* ---------------------------------------------------------------- dialogs */

function closeModal() {
  $("#overlayRoot").replaceChildren();
  S.modal = null;
  (modalReturn?.isConnected && modalReturn !== document.body ? modalReturn : listEl).focus();
}

let modalReturn: HTMLElement | null = null;
function showOverlay(html: string): HTMLElement {
  S.autoPull = false;
  modalReturn = document.activeElement as HTMLElement;
  const root = $("#overlayRoot");
  root.innerHTML = `<div class="overlay" data-close>${html}</div>`;
  root.querySelector("[data-close]")!.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).hasAttribute("data-close")) closeModal();
  });
  return root;
}

interface Option {
  label: string;
  color?: GroupColor;
  meta: string;
  go: () => void | Promise<void>;
}

function openPicker(title: string, opts: Option[]) {
  let q = "";
  let idx = 0;
  showOverlay(`<div class="dialog" role="dialog" aria-modal="true" aria-label="${title.replace(/<[^>]*>|"/g, "")}">
    <header>${title}<small>Type to filter · ↑↓ to choose · Enter to pick · Esc to cancel</small></header>
    <input id="picker-q" placeholder="Group name" autocomplete="off" aria-label="Filter groups">
    <div class="opts" id="picker-opts" role="listbox"></div></div>`);
  const input = $<HTMLInputElement>("#picker-q");
  const visible = () => opts.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const draw = () => {
    const v = visible();
    idx = Math.min(idx, Math.max(0, v.length - 1));
    $("#picker-opts").innerHTML =
      v
        .map(
          (o, i) =>
            `<div class="opt${i === idx ? " cur" : ""}" data-i="${i}" role="option" aria-selected="${i === idx}">` +
            (o.color ? `<span class="chip" style="--c: var(--tg-${o.color})">${esc(o.label)}</span>` : `<span>${esc(o.label)}</span>`) +
            `<span class="meta">${esc(o.meta)}</span></div>`,
        )
        .join("") || `<div class="opt">No match</div>`;
  };
  const choose = (i: number) => {
    const o = visible()[i];
    if (!o) return;
    closeModal();
    void o.go();
  };
  S.modal = (e) => {
    if (e.key === "Escape") closeModal();
    else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) {
      idx = Math.min(visible().length - 1, idx + 1);
      draw();
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) {
      idx = Math.max(0, idx - 1);
      draw();
    } else if (e.key === "Enter") choose(idx);
    else return;
    e.preventDefault();
  };
  input.addEventListener("input", () => {
    q = input.value;
    idx = 0;
    draw();
  });
  $("#picker-opts").addEventListener("click", (e) => {
    const o = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (o) choose(Number(o.dataset.i));
  });
  draw();
  input.focus();
}

function openMove() {
  const ids = actionTabs();
  if (!ids.length) return toast("Put the cursor on a tab, or select tabs with x, first.");
  const r = curRow();
  // Leave out the group the tabs are already in, when they're all in the same one.
  const currentKey = !S.selected.size && r?.type === "item" ? r.block.key : null;
  const moveTo = (target: ManualTarget) => moveTabs(ids, target);

  const opts: Option[] = [];
  for (const g of groups.values()) {
    const key = `existing:${g.id}`;
    if (key === currentKey) continue;
    opts.push({
      label: g.title || "Unnamed group",
      color: g.color,
      meta: `existing · ${winShort(g.windowId)}`,
      go: () => moveTo({ kind: "existing", groupId: g.id }),
    });
  }
  for (const g of S.plan!.newGroups) {
    const key = `new:${g.key}`;
    if (key === currentKey) continue;
    opts.push({ label: g.name, color: g.color, meta: g.mine ? "yours" : "new", go: () => moveTo({ kind: "new", key: g.key }) });
  }
  if (currentKey !== "left") opts.push({ label: "Leave ungrouped", meta: "keep in original window", go: () => moveTo({ kind: "left" }) });
  if (currentKey !== "close") opts.push({ label: "Close", meta: "#", go: () => moveTo({ kind: "close" }) });
  opts.push({ label: "New group…", meta: "", go: () => openPropose(ids) });
  const what = ids.length === 1 ? `“${esc(tabs.get(ids[0])?.title ?? "")}”` : `${ids.length} tabs`;
  openPicker(`Move ${what}`, opts);
}

function openPropose(ids = actionTabs()) {
  if (!ids.length) return toast("Focus or select tabs to create a group.");
  showOverlay(`<div class="dialog" role="dialog" aria-modal="true" aria-label="New group"><header>New group<small>${ids.length} ${ids.length === 1 ? "tab" : "tabs"}</small></header><input id="pg-name" placeholder="Group name" autocomplete="off" aria-label="Group name"><footer><button id="pg-cancel">Cancel</button><button class="primary" id="pg-go">Create<kbd>↵</kbd></button></footer></div>`);
  const go = () => {
    const name = $<HTMLInputElement>("#pg-name").value.trim();
    if (!name) return;
    closeModal();
    void direct(ids, { kind: "new", name, color: nextUserColor() });
  };
  S.modal = e => {
    if (e.key === "Escape") closeModal();
    else if (e.key === "Enter") go();
    else return;
    e.preventDefault();
  };
  $("#pg-go").addEventListener("click", go);
  $("#pg-cancel").addEventListener("click", closeModal);
  $("#pg-name").focus();
}

/** Shift+Enter: carries out the group under the cursor, as reviewed. */
async function applyGroup(b = curBlock()) {
  if (b?.section === "wait") return toast("These tabs are waiting for the AI. Move them yourself with m, or wait.");
  if (!b || !b.tabIds.length) return toast("Put the cursor on a group with tabs to apply it.");
  if (S.selected.size) return toast("Clear selection to accept a group.");
  if (b.section === "close") return direct(b.tabIds, { kind: "close" });
  if (b.groupId !== undefined) return direct(b.tabIds, { kind: "existing", groupId: b.groupId });
  if (b.newGroup) return direct(b.tabIds, { kind: "new", name: b.newGroup.name, color: b.newGroup.color });
  // Moving unmatched tabs into a window is an explicit optional action.
  if (S.busy) return;
  S.busy = true;
  try {
    const result = await applyActions(blockActions(b), S.leftoversWindowId);
    S.leftoversWindowId = result.leftoversWindowId;
    await saveLeftoversWindowId(S.leftoversWindowId);
    for (const id of b.tabIds) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab && !tab.pinned && tab.windowId === S.leftoversWindowId && tab.groupId === -1) resolved.set(id, tab.url ?? "");
    }
    await chrome.storage.session.set({ resolved: [...resolved] });
    toast(result.errors.length ? result.errors.join("; ") : "Moved to Leftovers window.");
  } finally { S.busy = false; await rescan(); }
}

function openHelp() {
  const keys: [string[], string][] = [
    [["j", "↓"], "Next row"],
    [["k", "↑"], "Previous row"],
    [["J"], "Next group"],
    [["K"], "Previous group"],
    [["g"], "First row"],
    [["G"], "Last row"],
    [["h", "←"], "Collapse group"],
    [["l", "→"], "Expand group"],
    [["x", "space"], "Select tab, or all of a group's tabs"],
    [["m"], "Move selected tabs (or the tab) to another group"],
    [["#"], "Close focused or selected tabs immediately"],
    [["n"], "Create group from focused or selected tabs now"],
    [["d"], "Delete a group you proposed"],
    [["e"], "Rename focused group"],
    [["c"], "Change focused group color"],
    [["↵"], "Switch to that tab"],
    [["y"], "Copy the tab's full URL"],
    [["/"], "Filter"],
    [["u"], "Import ready AI suggestions"],
    [["r"], "Re-scan tabs (only new tabs are sorted)"],
    [["R"], "Ask the AI again: the group under the cursor, the selected tabs, or everything"],
    [["s"], "AI settings"],
    [["⇧", "↵"], "Apply the group under the cursor"],
    [["Ctrl/Cmd+Z"], "Undo last action; closed tabs reopen URLs, without page state"],
    [["esc"], "Clear selection / filter"],
  ];
  showOverlay(`<div class="dialog wide" tabindex="0" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <header>Keyboard shortcuts<small>Press Esc or ? to close</small></header>
    <div class="help">${keys.map(([ks, d]) => `<div><span>${ks.map((k) => `<kbd>${k}</kbd>`).join("")}</span><span>${d}</span></div>`).join("")}</div></div>`);
  $("#overlayRoot .dialog").focus();
  S.modal = (e) => {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      closeModal();
    }
  };
}

/* ---------------------------------------------------------------- keys */

filterEl.addEventListener("input", () => {
  S.filter = filterEl.value.trim();
  render();
});
filterEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    filterEl.value = "";
    S.filter = "";
    render();
    listEl.focus();
    e.preventDefault();
  } else if (e.key === "Enter" || e.key === "ArrowDown") {
    listEl.focus();
    e.preventDefault();
  }
});

function onListOrBody(e: Event) {
  return e.target === listEl || e.target === document.body;
}

document.addEventListener("keydown", (e) => {
  if (S.modal) {
    if (e.key === "Tab") {
      const controls = [...document.querySelectorAll<HTMLElement>('#overlayRoot button:not([disabled]), #overlayRoot input, #overlayRoot select, #overlayRoot a, #overlayRoot [tabindex="0"]')].filter(el => el.getClientRects().length);
      const at = controls.indexOf(document.activeElement as HTMLElement);
      if (controls.length && (e.shiftKey && at <= 0 || !e.shiftKey && at === controls.length - 1)) {
        e.preventDefault(); controls[e.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
    return S.modal(e);
  }
  const target = e.target as HTMLElement;
  if (target.matches("input, textarea, select, [contenteditable=true]")) return;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); void undo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || S.busy) return;
  const k = e.key;
  // These work even before the first sort has finished.
  if (k === "s" || k === "?" || k === "n") {
    S.autoPull = false;
    e.preventDefault();
    if (k === "s") openAiSettings();
    else if (k === "?") openHelp();
    else openPropose();
    return;
  }
  if (!S.plan) return;
  // Once AI answers are on screen and the user starts working through them, new ones wait for u.
  if (k !== "u") S.autoPull = false;
  const r = curRow();
  let handled = true;
  if (k === "j" || k === "ArrowDown") moveCursor(1);
  else if (k === "k" || k === "ArrowUp") moveCursor(-1);
  else if (k === "J") jumpSection(1);
  else if (k === "K") jumpSection(-1);
  else if (k === "g") moveCursor(-1e6);
  else if (k === "G") moveCursor(1e6);
  else if ((k === "x" || k === " ") && onListOrBody(e)) toggleSelect(r);
  else if (k === "#") void markClose();
  else if (k === "h" || k === "ArrowLeft") collapse(r);
  else if (k === "l" || k === "ArrowRight") expand(r);
  else if (k === "m") openMove();
  else if (k === "d") void deleteUserGroup();
  else if (k === "e" || k === "F2") startRename();
  else if (k === "c") void cycleColor();
  else if (k === "/") {
    filterEl.focus();
    filterEl.select();
  } else if (k === "r") void rescan().then(() => toast("Re-scanned your tabs."));
  else if (k === "R") openResort();
  else if (k === "u") void pull();
  else if (k === "y") {
    if (r?.type !== "item") toast("Put the cursor on a tab to copy its URL.");
    else
      navigator.clipboard.writeText(tabs.get(r.tabId)?.url ?? "").then(
        () => toast("Copied URL."),
        () => toast("Couldn't copy. The URL is shown at the bottom."),
      );
  } else if (k === "Enter" && e.shiftKey) void applyGroup();
  else if (k === "Enter" && r && onListOrBody(e)) {
    if (r.type === "item") void switchToTab(r.tabId);
    else {
      S.collapsed.has(r.block.key) ? S.collapsed.delete(r.block.key) : S.collapsed.add(r.block.key);
      render();
    }
  } else if (k === "Escape" && S.selected.size) {
    S.selected.clear();
    render();
  } else if (k === "Escape" && S.filter) {
    filterEl.value = "";
    S.filter = "";
    render();
  } else handled = false;
  if (handled) e.preventDefault();
});

listEl.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const row = el.closest<HTMLElement>("[data-key]");
  if (!row || el.closest(".rename")) return;
  setCursor(row.dataset.key!);
  S.autoPull = false;
  const r = curRow();
  if (el.closest("[data-move]")) { openMove(); render(); return; }
  if (el.closest("[data-close-tab]")) { void markClose(); return; }
  const apply = el.closest<HTMLElement>("[data-apply]");
  if (apply) {
    const b = S.plan && blocksOf(S.plan).find((x) => x.key === apply.dataset.apply);
    if (b) void applyGroup(b);
    return;
  }
  if (el.closest("[data-cb]")) toggleSelect(r);
  else if (el.closest(".caret") && r?.type === "block") {
    S.collapsed.has(r.block.key) ? S.collapsed.delete(r.block.key) : S.collapsed.add(r.block.key);
    render();
  } else render();
  listEl.focus();
});
listEl.addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
  const r = row ? navRows().find((x) => x.key === row.dataset.key) : undefined;
  if (r?.type === "item") void switchToTab(r.tabId);
});

$("#propose").addEventListener("click", () => openPropose());
$("#help").addEventListener("click", openHelp);
$("#settings").addEventListener("click", openAiSettings);
$("#undo").addEventListener("click", () => void undo());

// Re-scan whenever the dashboard comes back into view, or the toolbar button is pressed again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !S.busy && !S.modal) void rescan();
});
chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === "rescan" && !S.busy) void rescan();
});

/* ---------------------------------------------------------------- start */

new ResizeObserver(entries => {
  const height = entries[0].target.getBoundingClientRect().height + 24;
  document.documentElement.style.setProperty("--footer-clearance", `${height}px`);
}).observe($(".applybar"));

$("#version").textContent = `v${chrome.runtime.getManifest().version}`;

(async () => {
  const decisions = await chrome.storage.session.get("resolved");
  for (const [id, url] of decisions.resolved ?? []) resolved.set(id, url);
  const stored = await loadState();
  S.userGroups = stored.userGroups;
  S.leftoversWindowId = stored.leftoversWindowId;
  S.ai = stored.ai;
  S.aiStatus = await chromeAiStatus();
  if (S.aiStatus === "downloading" && S.ai.choice === "chrome") void startDownload(true);
  await rescan();
  listEl.focus({ preventScroll: true });
})();
