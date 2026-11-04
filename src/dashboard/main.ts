import "./style.css";
import { applyActions, switchToTab, type Actions } from "../chrome/apply";
import { takeSnapshot } from "../chrome/snapshot";
import { missingSetting, modelFor, requestPermission, type AiChoice, type AiSettings, DEFAULT_AI_SETTINGS } from "../chrome/aiSettings";
import { chromeAiStatus, downloadChromeAi, type ChromeAiStatus } from "../chrome/models/chromeAi";
import { loadState, saveAiSettings, saveLeftoversWindowId, saveUserGroups } from "../chrome/storage";
import { ModelSorter, parsePartialAnswer } from "../core/modelSorter";
import { buildPlan, type ManualTarget, type NewGroupPlan, type Plan } from "../core/plan";
import { SiteSorter } from "../core/siteSorter";
import type { Sorter } from "../core/sorter";
import { GROUP_COLORS, type GroupColor, type GroupInfo, type Snapshot, type TabInfo, type UserGroup } from "../core/types";

/* ---------------------------------------------------------------- state */

const siteSorter = new SiteSorter();
/** The AI sorter for the current settings; rebuilt when they change, which also drops its remembered answers. */
let modelSorter: ModelSorter | null = null;

const S = {
  snapshot: null as Snapshot | null,
  plan: null as Plan | null,
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
    /** Titles in the current batch, the group ids the model may use, and its answer so far. */
    input?: string[];
    groupIds?: Record<string, string>;
    output?: string;
    error?: string;
  },
  ai: DEFAULT_AI_SETTINGS as AiSettings,
  /** Whether Chrome's built-in AI is ready, for the "chrome" choice. */
  aiStatus: "unsupported" as ChromeAiStatus,
  /** Model download progress (0..1) while this page is downloading it. */
  download: null as number | null,
};

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
function winLong(id: number): string {
  if (id === S.leftoversWindowId) return "Leftovers";
  return "Window " + (windowOrder().indexOf(id) + 1);
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
  (toast as { t?: number }).t = window.setTimeout(() => root.replaceChildren(), 3000);
}

/* ---------------------------------------------------------------- rows */

type SectionKey = "close" | "existing" | "new" | "left";

/** A group of suggestions you review and apply as a whole. */
interface Block {
  key: string;
  section: SectionKey;
  groupId?: number;
  newGroup?: NewGroupPlan;
  tabIds: number[];
}

type Row =
  | { type: "section"; section: SectionKey; count: number }
  | { type: "info"; text: string }
  | { type: "block"; key: string; block: Block }
  | { type: "item"; key: string; section: SectionKey; block: Block; tabId: number };

const SECTIONS: Record<SectionKey, { title: string; hint: string }> = {
  close: { title: "Close", hint: "Duplicates, and tabs you marked with #. Duplicates in two different groups are never touched." },
  existing: { title: "Add to your groups", hint: "Your existing groups never lose tabs or get mixed together." },
  new: {
    title: "New groups",
    hint: "Created in the window that already holds most of their tabs. Press n to propose your own.",
  },
  left: { title: "Leftovers", hint: "Tabs that don't fit a group go to one window." },
};
const SECTION_ORDER: SectionKey[] = ["close", "existing", "new", "left"];

const itemKey = (blockKey: string, tabId: number) => `${blockKey}|${tabId}`;

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
  ];
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
    out.push({ type: "section", section, count: bs.reduce((n, b) => n + b.tabIds.length, 0) });
    for (const b of bs) {
      out.push({ type: "block", key: b.key, block: b });
      if (!S.collapsed.has(b.key)) {
        for (const id of b.tabIds.filter(matches)) out.push({ type: "item", key: itemKey(b.key, id), section, block: b, tabId: id });
      }
      if (b.newGroup?.mine && !b.tabIds.length) out.push({ type: "info", text: "No matching tabs yet. Move tabs here with m." });
    }
    if (section === "close" && !S.filter) for (const text of plan.notes) out.push({ type: "info", text });
    if (!bs.length) out.push({ type: "info", text: S.filter ? "No matches." : "Nothing to do here." });
  }
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
  if (b.groupId !== undefined) return groups.get(b.groupId)?.title || "Unnamed group";
  return b.newGroup!.name;
}

/** What applying a block does, as a button label. */
function applyLabel(b: Block): string {
  const n = b.tabIds.length;
  const tabsWord = `${n} ${n === 1 ? "tab" : "tabs"}`;
  if (b.section === "close") return `Close ${tabsWord}`;
  if (b.section === "left") return `Move ${tabsWord} to Leftovers`;
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
  if (r.type === "section") {
    const s = SECTIONS[r.section];
    return `<div class="sec"><h2>${s.title}</h2><span class="count">${r.count} ${r.count === 1 ? "tab" : "tabs"}</span><span class="hint">${s.hint}</span></div>`;
  }
  if (r.type === "info") return `<div class="row info">${esc(r.text)}</div>`;
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
      name = `<span class="chip closechip">Close</span>`;
    } else if (b.section === "left") {
      name = `<span class="chip ghost">Leftovers window</span>`;
      meta = `<span class="win">${win !== null ? winShort(win) : "new window"}</span>`;
    } else if (b.groupId !== undefined) {
      const g = groups.get(b.groupId);
      name = `<span class="chip outline" style="--c: var(--tg-${g?.color ?? "grey"})">${esc(g?.title || "Unnamed group")}</span>`;
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
    const isCurBlock = curBlock()?.key === b.key;
    const apply = b.tabIds.length
      ? `<button type="button" class="applybtn${isCurBlock ? " primary" : ""}" data-apply="${esc(b.key)}">${esc(applyLabel(b))}${isCurBlock ? "<kbd>⇧↵</kbd>" : ""}</button>`
      : "";
    return `<div class="row block on-row${cur}" id="${rowId(r.key)}" data-key="${esc(r.key)}" role="option" aria-selected="${st === "on"}">${caret}<span class="cb ${st}" data-cb></span>${name}<span class="title hintx">${esc(hint)}</span>${meta}${apply}</div>`;
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
    tail = `<span class="win">${winShort(t.windowId)} · ${why}</span>`;
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
    `<span class="cb ${on ? "on" : ""}" data-cb></span><img class="fav" src="${esc(favicon(t.url))}" alt="">` +
    `<span class="title">${esc(t.title)}</span><span class="host">${esc(host(t.url))}</span>${tail}</div>`
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
  listEl.innerHTML = rows.map(rowHTML).join("");
  if (S.cursor) {
    listEl.setAttribute("aria-activedescendant", rowId(S.cursor));
    document.getElementById(rowId(S.cursor))?.scrollIntoView({ block: "nearest" });
  }
  if (S.renaming) {
    const input = $<HTMLInputElement>("#rename-input");
    input?.focus();
    input?.select();
  }
  renderStats();
  renderWindows();
  renderSummary();
  renderStatusLine();
}

function renderStats() {
  const all = [...tabs.values()].filter((t) => !t.pinned);
  const windows = new Set(all.map((t) => t.windowId));
  const ungrouped = all.filter((t) => t.groupId === -1 && t.windowId !== S.leftoversWindowId).length;
  const toClose = S.plan?.close.length ?? 0;
  const toReview = S.plan ? blocksOf(S.plan).filter((b) => b.tabIds.length).length : 0;
  $("#stats").innerHTML =
    `<span><b>${all.length}</b> tabs</span><span><b>${windows.size}</b> windows</span>` +
    `<span class="warn"><b>${ungrouped}</b> ungrouped</span><span><b>${toClose}</b> to close</span>` +
    `<span><b>${toReview}</b> ${toReview === 1 ? "group" : "groups"} to review</span>`;
}

function renderWindows() {
  const all = [...tabs.values()].filter((t) => !t.pinned);
  const ids = windowOrder();
  if (S.leftoversWindowId !== null && all.some((t) => t.windowId === S.leftoversWindowId)) ids.push(S.leftoversWindowId);
  $("#windows").innerHTML =
    ids
      .map((w) => {
        const inWin = all.filter((t) => t.windowId === w);
        if (!inWin.length) return "";
        const chips = [...groups.values()]
          .filter((g) => g.windowId === w)
          .map((g) => {
            const n = inWin.filter((t) => t.groupId === g.id).length;
            return `<span class="chip" style="--c: var(--tg-${g.color})">${esc(g.title || "Unnamed")} ${n}</span>`;
          })
          .join("");
        const loose = inWin.filter((t) => t.groupId === -1).length;
        return `<div class="wnd"><div class="wname">${winLong(w)}<span>${inWin.length} ${inWin.length === 1 ? "tab" : "tabs"}</span></div><div class="chips">${chips}${loose ? `<span class="chip ghost">${loose} ungrouped</span>` : ""}</div></div>`;
      })
      .join("") || `<div class="row info">No tabs.</div>`;
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
  const n = S.selected.size;
  const b = curBlock();
  $("#summary").innerHTML = n
    ? `<b>${n}</b> ${n === 1 ? "tab" : "tabs"} selected · <kbd>m</kbd> move · <kbd>#</kbd> close · <kbd>esc</kbd> clear`
    : b?.tabIds.length
      ? `Looks right? <kbd>⇧↵</kbd> applies “${esc(blockName(b))}”.`
      : "Move the cursor to a group to review it.";
  const apply = $<HTMLButtonElement>("#apply");
  apply.disabled = !b?.tabIds.length || S.busy;
  apply.innerHTML = `${b?.tabIds.length ? esc(applyLabel(b)) : "Apply group"}<kbd>⇧↵</kbd>`;
}

function renderStatusLine() {
  const el = $("#cururl");
  const r = curRow();
  if (!r) {
    el.innerHTML = `<span class="url">Nothing selected</span>`;
    return;
  }
  if (r.type === "block") {
    el.innerHTML = `<span class="url">Group: ${esc(blockName(r.block))}</span>`;
    return;
  }
  const t = tabs.get(r.tabId);
  let html = `<span class="url main">${esc(t?.url ?? "")}</span>`;
  if (r.section === "close") {
    const keepId = S.plan!.close.find((c) => c.tabId === r.tabId)?.keepId;
    const k = keepId !== undefined ? tabs.get(keepId) : undefined;
    html += `<span class="url">${k ? `Duplicate. Keeps ${esc(k.url)}` : "Marked for closing by you. Move it with m to keep it."}</span>`;
  } else html += `<span class="url">${esc(sortExplanation(r.tabId))}</span>`;
  el.innerHTML = html;
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

/** One line on how the current tab was sorted, for checking the AI's work. */
function sortExplanation(tabId: number): string {
  const sorter = activeSorter();
  if (!(sorter instanceof ModelSorter)) return `Sorted by website: ${whyNoAi()}.`;
  const subject = sorter.subjectOf(tabId);
  if (!subject) {
    if (sorter.stopped) return "AI: stopped before it reached this tab, so it was sorted by website. Press R to sort everything again.";
    const err = sorter.lastError;
    return `AI: no answer for this tab, so it was sorted by website.${err ? ` Error: ${err}` : ""}`;
  }
  return `AI: about “${subject}”`;
}

/* ---------------------------------------------------------------- data */

async function rescan() {
  S.snapshot = await takeSnapshot(S.leftoversWindowId);
  if (S.snapshot.leftoversWindowId !== S.leftoversWindowId) {
    S.leftoversWindowId = S.snapshot.leftoversWindowId;
    await saveLeftoversWindowId(S.leftoversWindowId);
  }
  tabs.clear();
  for (const t of S.snapshot.tabs) tabs.set(t.id, t);
  groups.clear();
  for (const g of S.snapshot.groups) groups.set(g.id, g);
  // Forget hand moves for tabs that are gone or already grouped.
  for (const id of S.manual.keys()) {
    const t = tabs.get(id);
    if (!t || t.groupId !== -1) S.manual.delete(id);
  }
  await replan();
}

function activeSorter(): Sorter {
  if (whyNoAi()) return siteSorter;
  if (!modelSorter) {
    const model = modelFor(S.ai);
    modelSorter = model ? new ModelSorter(model, siteSorter) : null;
  }
  return modelSorter ?? siteSorter;
}

let replanGeneration = 0;
let replanAbort: AbortController | null = null;
/** Stops the AI sort that's running; the rest of the tabs get sorted by website. */
let replanStop: AbortController | null = null;

/** Re-sorts. A newer call cancels an older one that is still running. */
async function replan() {
  if (!S.snapshot) return;
  const generation = ++replanGeneration;
  replanAbort?.abort();
  const abort = new AbortController();
  replanAbort = abort;
  const stop = new AbortController();
  replanStop = stop;
  const current = () => generation === replanGeneration;
  try {
    const plan = await buildPlan({
      snapshot: S.snapshot,
      userGroups: S.userGroups,
      manual: S.manual,
      aiOverrides: S.aiOverrides,
      sorter: activeSorter(),
      sortOptions: {
        signal: abort.signal,
        stop: stop.signal,
        onProgress: (done, total) => {
          if (!current() || total === 0) return;
          S.sorting = { ...S.sorting, done, total };
          if (S.plan) {
            renderSorter();
            renderSummary();
          } else render();
        },
        onModel: (event) => {
          if (!current() || !S.sorting) return;
          if (event.kind === "input")
            Object.assign(S.sorting, { input: event.items, groupIds: event.groups, output: "", error: undefined, batchStart: Date.now() });
          else if (event.kind === "output") S.sorting.output = event.text;
          else S.sorting.error = event.text;
          renderBanner();
        },
      },
    });
    if (!current()) return;
    S.plan = plan;
  } catch (e) {
    if (abort.signal.aborted) return;
    throw e;
  } finally {
    if (current()) S.sorting = null;
  }
  render();
}

/** Complete `{ tab, subject, group }` answers in a partly streamed model answer, in order. */
function answeredTabs(output: string): { tab: number; subject: string; group: string }[] {
  return [...parsePartialAnswer(output)].map(([tab, a]) => ({ tab, ...a }));
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
  const el = $("#aibanner");
  let text = "";
  let actions = "";
  let extra = "";
  let muted = false;
  const sorter = activeSorter();
  const name = sorter instanceof ModelSorter ? sorter.model.name : "AI";
  const bar = (pct: number) =>
    `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width:${pct}%"></div></div>`;
  if (S.sorting) {
    const p = S.sorting;
    const finishedAnswers = answeredTabs(p.output ?? "");
    // Tabs the model has finished answering in the current batch, counted from the streamed answer.
    const done = Math.min(p.total, p.done + Math.min(p.input?.length ?? 0, finishedAnswers.length));
    const pct = p.total ? Math.round((done / p.total) * 100) : 0;
    const secs = p.batchStart ? Math.floor((Date.now() - p.batchStart) / 1000) : 0;
    // The answers the model has finished so far, newest last, as "title → subject → group".
    const finished = finishedAnswers.map((a) => {
      const id = a.group.trim().toUpperCase().replace(/\s+/g, "");
      const group = /^none$/i.test(a.group.trim()) ? "Leftovers" : (p.groupIds?.[id] ?? a.group);
      return `${p.input?.[a.tab - 1] ?? `Tab ${a.tab}`} → “${a.subject}” → ${group}`;
    });
    const outLines = p.error
      ? [`<span class="txt err">failed: ${esc(p.error)}</span>`]
      : finished.length
        ? finished.slice(-3).map((line) => `<span class="txt">${esc(line)}</span>`)
        : [`<span class="txt muted">${p.output ? "The model is writing its answer…" : "Waiting for the model…"}</span>`];
    text =
      `<strong>Sorting with ${esc(name)}… ${done} of ${p.total} tabs</strong>` +
      `<span>${p.input ? `This batch: ${p.input.length} tabs, ${secs} s so far` : "Starting the model…"}</span>`;
    actions =
      `<button type="button" data-act="settings">AI settings</button>` +
      `<button type="button" data-act="stop" title="The tabs not sorted yet are sorted by website">Stop</button>`;
    extra =
      bar(pct) +
      (p.input
        ? `<div class="modelio"><div><span class="dir">in</span><span class="txt">${esc(p.input.join(" · "))}</span></div>` +
          outLines.map((line, i) => `<div><span class="dir">${i === 0 ? "out" : ""}</span>${line}</div>`).join("") +
          `</div>`
        : "");
  } else if (S.download !== null) {
    const pct = Math.round(S.download * 100);
    text =
      `<strong>Downloading Chrome's on-device AI model… ${pct}%</strong>` +
      `<span>Tabs stay grouped by website until it finishes. You can keep using this page meanwhile.</span>`;
    actions = `<button type="button" data-act="settings">AI settings</button>`;
    extra = bar(pct);
  } else if (S.ai.choice === "chrome" && (S.aiStatus === "downloadable" || S.aiStatus === "downloading")) {
    text =
      `<strong>Tabs are grouped by website for now</strong>` +
      `<span>Download Chrome's on-device AI model to group them by subject instead. It's a one-time download of a few GB. It runs on this computer, and your tabs are never sent anywhere. Or use an online model in AI settings.</span>`;
    actions =
      `<button type="button" data-act="settings">AI settings</button>` +
      `<button type="button" class="primary" data-act="download">${S.aiStatus === "downloading" ? "Finish downloading" : "Download AI model"}</button>`;
  } else if (S.ai.choice === "chrome" && (S.aiStatus === "unavailable" || S.aiStatus === "unsupported")) {
    muted = true;
    text =
      `<strong>Tabs are grouped by website</strong><span>` +
      (S.aiStatus === "unsupported"
        ? "Chrome's on-device AI needs Chrome 138 or later."
        : "Chrome says its on-device AI isn't available on this computer. It needs 22 GB of free disk space and either a GPU with more than 4 GB of video memory or 16 GB of RAM. chrome://on-device-internals shows the details.") +
      ` You can use an online model instead.</span>`;
    actions = `<button type="button" data-act="settings">AI settings</button>`;
  } else if ((S.ai.choice === "gemini" || S.ai.choice === "openai") && whyNoAi()) {
    text = `<strong>Tabs are grouped by website for now</strong><span>Because ${esc(whyNoAi()!)}.</span>`;
    actions =
      `<button type="button" data-act="settings">AI settings</button>`;
  }
  el.classList.toggle("muted", muted);
  el.hidden = !text;
  setHTML($("#ab-text"), text);
  setHTML($("#ab-actions"), actions);
  setHTML($("#ab-extra"), extra);
}

// Keeps the "so far" seconds counting while the model works on a batch.
setInterval(() => {
  if (S.sorting?.batchStart) renderBanner();
}, 1000);

function onAiAction(e: Event) {
  const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "download") void startDownload();
  else if (act === "settings") openAiSettings();
  else if (act === "stop") {
    replanStop?.abort();
    toast("Stopped. The tabs the AI hadn't reached are sorted by website.");
  }
}
$("#aibanner").addEventListener("click", onAiAction);
$("#sorter").addEventListener("click", onAiAction);

function renderSorter() {
  renderBanner();
  const el = $("#sorter");
  const settings = `<button type="button" class="link" data-act="settings">AI settings</button>`;
  const sorter = activeSorter();
  if (S.sorting) {
    setHTML(el, `Sorting with ${esc(sorter instanceof ModelSorter ? sorter.model.name : "AI")}… · ${settings}`);
  } else if (S.download !== null) {
    setHTML(el, `Downloading the AI model… ${Math.round(S.download * 100)}%`);
  } else if (sorter instanceof ModelSorter) {
    const fb = sorter.lastFallbackCount;
    const err = sorter.lastError;
    const why = sorter.stopped ? "you stopped the AI" : "the AI failed on them";
    setHTML(el, `${esc(sorter.label)}${fb ? ` <span${err ? ` title="${esc(err)}"` : ""}>(${fb} by website, ${why})</span>` : ""} · ${settings}`);
  } else {
    setHTML(el, `Sorted by website · ${settings}`);
  }
}

/** Applies new AI settings and re-sorts. */
async function setAiSettings(ai: AiSettings) {
  S.ai = ai;
  modelSorter = null;
  await saveAiSettings(ai);
  if (ai.choice === "chrome") S.aiStatus = await chromeAiStatus();
  renderSorter();
  await replan();
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
    renderSorter();
    await replan();
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
    else if (e.key === "Enter" && !(e.target as HTMLElement).closest("a")) void save();
    else return;
    e.preventDefault();
  };
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
}

function moveCursor(d: number) {
  const nav = navRows();
  if (!nav.length) return;
  let i = nav.findIndex((r) => r.key === S.cursor);
  i = Math.max(0, Math.min(nav.length - 1, i + d));
  setCursor(nav[i].key);
  render();
}

function sectionOf(r: Extract<Row, { key: string }>): SectionKey {
  return r.type === "block" ? r.block.section : r.section;
}

function jumpSection(d: number) {
  const nav = navRows();
  const cur = curRow();
  const ci = SECTION_ORDER.indexOf(cur ? sectionOf(cur) : "close");
  for (let s = ci + d; s >= 0 && s < SECTION_ORDER.length; s += d) {
    const first = nav.find((r) => sectionOf(r) === SECTION_ORDER[s]);
    if (first) {
      setCursor(first.key);
      render();
      return;
    }
  }
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
async function moveTabs(ids: number[], target: ManualTarget) {
  // Keep the cursor where it was: on the next row that isn't moving, so you can carry on down the group.
  const nav = navRows();
  const at = nav.findIndex((r) => r.key === S.cursor);
  const stays = (r: (typeof nav)[number]) => r.type === "block" || !ids.includes(r.tabId);
  const next = nav.slice(at).find(stays) ?? nav.slice(0, at).reverse().find(stays);
  for (const id of ids) S.manual.set(id, target);
  S.selected.clear();
  await replan();
  if (next && navRows().some((r) => r.key === next.key)) {
    setCursor(next.key);
    render();
  }
}

/** # : marks tabs for closing, or unmarks tabs already marked. */
async function markClose() {
  const ids = actionTabs();
  if (!ids.length) return toast("Put the cursor on a tab, or select tabs with x, first.");
  const marked = ids.filter((id) => S.manual.get(id)?.kind === "close");
  if (marked.length === ids.length) {
    for (const id of ids) S.manual.delete(id);
    S.selected.clear();
    await replan();
    toast(`Unmarked ${ids.length} ${ids.length === 1 ? "tab" : "tabs"}.`);
    return;
  }
  await moveTabs(ids, { kind: "close" });
  toast(`${ids.length} ${ids.length === 1 ? "tab" : "tabs"} will close when you apply the Close group.`);
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
  await replan();
}

function startRename() {
  const r = curRow();
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
  if (save && g && value && value !== g.name) await updateNewGroup(g, { name: value });
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

async function addUserGroup(name: string, hint: string): Promise<UserGroup> {
  const g: UserGroup = { id: crypto.randomUUID(), name, hint, color: nextUserColor() };
  S.userGroups = [g, ...S.userGroups];
  await saveUserGroups(S.userGroups);
  return g;
}

async function deleteUserGroup() {
  const g = newGroupOf(curRow());
  if (!g?.mine) return toast("Only groups you proposed can be deleted.");
  const id = g.key.slice("user:".length);
  S.userGroups = S.userGroups.filter((u) => u.id !== id);
  for (const [tabId, m] of S.manual) if (m.kind === "new" && m.key === g.key) S.manual.delete(tabId);
  await saveUserGroups(S.userGroups);
  modelSorter?.forget();
  await replan();
  toast(`Deleted “${g.name}”. Its tabs went back to the suggestions.`);
}

/* ---------------------------------------------------------------- dialogs */

function closeModal() {
  $("#overlayRoot").replaceChildren();
  S.modal = null;
  listEl.focus();
}

function showOverlay(html: string): HTMLElement {
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
  showOverlay(`<div class="dialog" role="dialog" aria-modal="true" aria-label="Move tab">
    <header>${title}<small>Type to filter · ↑↓ to choose · Enter to move · Esc to cancel</small></header>
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
  if (currentKey !== "left") opts.push({ label: "Leftovers window", meta: "", go: () => moveTo({ kind: "left" }) });
  if (currentKey !== "close") opts.push({ label: "Close", meta: "#", go: () => moveTo({ kind: "close" }) });
  opts.push({
    label: "New group…",
    meta: "",
    go: async () => {
      const g = await addUserGroup("New group", "");
      await moveTabs(ids, { kind: "new", key: `user:${g.id}` });
      S.renaming = `new:user:${g.id}`;
      setCursor(S.renaming);
      render();
    },
  });
  if (ids.some((id) => S.manual.has(id))) {
    opts.push({
      label: "Let the sorter decide",
      meta: "undo your move",
      go: async () => {
        for (const id of ids) S.manual.delete(id);
        S.selected.clear();
        await replan();
      },
    });
  }
  const what = ids.length === 1 ? `“${esc(tabs.get(ids[0])?.title ?? "")}”` : `${ids.length} tabs`;
  openPicker(`Move ${what}`, opts);
}

function openPropose() {
  showOverlay(`<div class="dialog" role="dialog" aria-modal="true" aria-label="Propose a group">
    <header>Propose a group<small>Ungrouped tabs are re-sorted to fill it. Tab to switch fields · Enter to add · Esc to cancel</small></header>
    <input id="pg-name" placeholder="Name, e.g. Weekend reading" autocomplete="off" aria-label="Group name">
    <input id="pg-hint" placeholder="Optional hint, e.g. hacker news, wikipedia, articles" autocomplete="off" aria-label="Hint for the sorter">
    <footer><button type="button" id="pg-cancel">Cancel<kbd>esc</kbd></button><button type="button" class="primary" id="pg-go">Add group<kbd>↵</kbd></button></footer></div>`);
  const go = async () => {
    const name = $<HTMLInputElement>("#pg-name").value.trim();
    if (!name) {
      $("#pg-name").focus();
      return;
    }
    const hint = $<HTMLInputElement>("#pg-hint").value.trim();
    closeModal();
    const g = await addUserGroup(name, hint);
    // Sort every tab again, so the new group can collect the tabs that fit it.
    modelSorter?.forget();
    await replan();
    setCursor(`new:user:${g.id}`);
    render();
    const n = S.plan!.newGroups.find((x) => x.key === `user:${g.id}`)?.tabIds.length ?? 0;
    toast(n ? `${n} tab${n > 1 ? "s" : ""} sorted into “${name}”.` : `Added “${name}”. No tabs matched yet.`);
  };
  S.modal = (e) => {
    if (e.key === "Escape") closeModal();
    else if (e.key === "Enter") void go();
    else return;
    e.preventDefault();
  };
  $("#pg-go").addEventListener("click", () => void go());
  $("#pg-cancel").addEventListener("click", closeModal);
  $("#pg-name").focus();
}

/** Shift+Enter: carries out the group under the cursor, as reviewed. */
async function applyGroup(b = curBlock()) {
  if (!b || !b.tabIds.length) return toast("Put the cursor on a group with tabs to apply it.");
  if (S.busy) return;
  S.busy = true;
  const label = applyLabel(b);
  renderSummary();
  try {
    const result = await applyActions(blockActions(b), S.leftoversWindowId);
    if (result.leftoversWindowId !== S.leftoversWindowId) {
      S.leftoversWindowId = result.leftoversWindowId;
      await saveLeftoversWindowId(S.leftoversWindowId);
    }
    // A proposed group that now exists in Chrome is done.
    if (b.newGroup?.mine) {
      S.userGroups = S.userGroups.filter((u) => `user:${u.id}` !== b.newGroup!.key);
      await saveUserGroups(S.userGroups);
    }
    for (const id of b.tabIds) {
      S.manual.delete(id);
      S.selected.delete(id);
    }
    toast(result.errors.length ? `Done, with problems: ${result.errors.join("; ")}` : `Done: ${label}.`);
  } finally {
    S.busy = false;
    await rescan();
  }
}

function openHelp() {
  const keys: [string[], string][] = [
    [["j", "↓"], "Next row"],
    [["k", "↑"], "Previous row"],
    [["J"], "Next section"],
    [["K"], "Previous section"],
    [["g"], "First row"],
    [["G"], "Last row"],
    [["h", "←"], "Collapse group"],
    [["l", "→"], "Expand group"],
    [["x", "space"], "Select tab, or all of a group's tabs"],
    [["m"], "Move selected tabs (or the tab) to another group"],
    [["#"], "Mark selected tabs (or the tab) for closing"],
    [["n"], "Propose your own group"],
    [["d"], "Delete a group you proposed"],
    [["e"], "Rename new group"],
    [["c"], "Change new group's color"],
    [["↵"], "Switch to that tab"],
    [["y"], "Copy the tab's full URL"],
    [["/"], "Filter"],
    [["r"], "Re-scan tabs (only new tabs are sorted)"],
    [["R"], "Re-sort all tabs from scratch"],
    [["s"], "AI settings"],
    [["⇧", "↵"], "Apply the group under the cursor"],
    [["esc"], "Clear selection / filter"],
  ];
  showOverlay(`<div class="dialog wide" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <header>Keyboard shortcuts<small>Press Esc or ? to close</small></header>
    <div class="help">${keys.map(([ks, d]) => `<div><span>${ks.map((k) => `<kbd>${k}</kbd>`).join("")}</span><span>${d}</span></div>`).join("")}</div></div>`);
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
  if (S.modal) return S.modal(e);
  const target = e.target as HTMLElement;
  if (target === filterEl || target.id === "rename-input") return;
  if (e.metaKey || e.ctrlKey || e.altKey || S.busy) return;
  const k = e.key;
  // These work even before the first sort has finished.
  if (k === "s" || k === "?" || k === "n") {
    e.preventDefault();
    if (k === "s") openAiSettings();
    else if (k === "?") openHelp();
    else openPropose();
    return;
  }
  if (!S.plan) return;
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
  else if (k === "R") {
    modelSorter?.forget();
    void rescan().then(() => toast("Re-sorted all tabs."));
  }
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
  const r = curRow();
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

$("#apply").addEventListener("click", () => void applyGroup());
$("#propose").addEventListener("click", openPropose);
$("#rescan").addEventListener("click", () => void rescan().then(() => toast("Re-scanned your tabs.")));

// Re-scan whenever the dashboard comes back into view, or the toolbar button is pressed again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !S.busy && !S.modal) void rescan();
});
chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === "rescan" && !S.busy) void rescan();
});

/* ---------------------------------------------------------------- start */

$("#version").textContent = `v${chrome.runtime.getManifest().version}`;

(async () => {
  const stored = await loadState();
  S.userGroups = stored.userGroups;
  S.leftoversWindowId = stored.leftoversWindowId;
  S.ai = stored.ai;
  S.aiStatus = await chromeAiStatus();
  if (S.aiStatus === "downloading" && S.ai.choice === "chrome") void startDownload(true);
  await rescan();
  listEl.focus({ preventScroll: true });
})();
