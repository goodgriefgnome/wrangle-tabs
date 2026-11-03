import "./style.css";
import { applyActions, switchToTab, type Actions } from "../chrome/apply";
import { takeSnapshot } from "../chrome/snapshot";
import { downloadNano, nanoSessionFactory, nanoStatus, type NanoStatus } from "../chrome/nano";
import { loadState, saveLeftoversWindowId, saveSorterPref, saveUserGroups, type SorterPref } from "../chrome/storage";
import { NanoSorter } from "../core/nanoSorter";
import { buildPlan, type ManualTarget, type NewGroupPlan, type Plan } from "../core/plan";
import { SiteSorter } from "../core/siteSorter";
import type { Sorter } from "../core/sorter";
import { GROUP_COLORS, type GroupColor, type GroupInfo, type Snapshot, type TabInfo, type UserGroup } from "../core/types";

/* ---------------------------------------------------------------- state */

const siteSorter = new SiteSorter();
const nanoSorter = new NanoSorter(nanoSessionFactory(), siteSorter);

const S = {
  snapshot: null as Snapshot | null,
  plan: null as Plan | null,
  userGroups: [] as UserGroup[],
  leftoversWindowId: null as number | null,
  /** Tabs the user moved by hand. Re-sorting leaves them where they were put. */
  manual: new Map<number, ManualTarget>(),
  aiOverrides: new Map<string, { name?: string; color?: GroupColor }>(),
  /** Item keys the user unticked. Everything else starts ticked. */
  unticked: new Set<string>(),
  collapsed: new Set<string>(),
  cursor: null as string | null,
  lastIdx: 0,
  filter: "",
  renaming: null as string | null,
  modal: null as null | ((e: KeyboardEvent) => void),
  busy: false,
  /** Progress of a slow (AI) sort, while one is running. */
  sorting: null as null | { done: number; total: number },
  aiStatus: "unsupported" as NanoStatus,
  sorterPref: "ai" as SorterPref,
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

const ticked = (key: string) => !S.unticked.has(key);

/* ---------------------------------------------------------------- rows */

type SectionKey = "dupe" | "existing" | "new" | "left";

interface Block {
  key: string;
  section: "existing" | "new";
  groupId?: number;
  newGroup?: NewGroupPlan;
  tabIds: number[];
}

type Row =
  | { type: "section"; section: SectionKey; count: number }
  | { type: "info"; text: string }
  | { type: "block"; key: string; block: Block }
  | { type: "item"; key: string; section: SectionKey; block: Block | null; tabId: number };

const SECTIONS: Record<SectionKey, { title: string; hint: string }> = {
  dupe: { title: "Close duplicates", hint: "One copy stays open. Copies in two different groups are never touched." },
  existing: { title: "Add to your groups", hint: "Your existing groups never lose tabs or get mixed together." },
  new: {
    title: "New groups",
    hint: "Created in the window that already holds most of their tabs. Press n to propose your own.",
  },
  left: { title: "Leftovers window", hint: "Tabs that don't fit a group." },
};
const SECTION_ORDER: SectionKey[] = ["dupe", "existing", "new", "left"];

const itemKey = (prefix: string, tabId: number) => `${prefix}|${tabId}`;

function blocksOf(plan: Plan): Block[] {
  return [
    ...plan.addToExisting.map((a) => ({
      key: `existing:${a.groupId}`,
      section: "existing" as const,
      groupId: a.groupId,
      tabIds: a.tabIds,
    })),
    ...plan.newGroups.map((g) => ({ key: `new:${g.key}`, section: "new" as const, newGroup: g, tabIds: g.tabIds })),
  ];
}

let rows: Row[] = [];
const navRows = () => rows.filter((r): r is Extract<Row, { key: string }> => "key" in r);

function buildRows(plan: Plan): Row[] {
  const out: Row[] = [];
  const blocks = blocksOf(plan);

  const dupes = plan.duplicates.filter((d) => matches(d.closeId));
  out.push({ type: "section", section: "dupe", count: plan.duplicates.length });
  for (const d of dupes) {
    out.push({ type: "item", key: itemKey("close", d.closeId), section: "dupe", block: null, tabId: d.closeId });
  }
  if (!S.filter) for (const text of plan.notes) out.push({ type: "info", text });
  if (!dupes.length) out.push({ type: "info", text: S.filter ? "No matches." : "No duplicates." });

  for (const section of ["existing", "new"] as const) {
    const bs = blocks.filter(
      (b) => b.section === section && (!S.filter ? true : b.tabIds.some(matches)),
    );
    out.push({ type: "section", section, count: bs.reduce((n, b) => n + b.tabIds.length, 0) });
    for (const b of bs) {
      out.push({ type: "block", key: b.key, block: b });
      if (!S.collapsed.has(b.key)) {
        for (const id of b.tabIds.filter(matches)) {
          out.push({ type: "item", key: itemKey(b.key, id), section, block: b, tabId: id });
        }
      }
      if (b.newGroup?.mine && !b.tabIds.length) {
        out.push({ type: "info", text: "No matching tabs yet. Move tabs here with m." });
      }
    }
    if (!bs.length) out.push({ type: "info", text: S.filter ? "No matches." : "Nothing to do here." });
  }

  const left = plan.leftovers.filter(matches);
  out.push({ type: "section", section: "left", count: plan.leftovers.length });
  for (const id of left) out.push({ type: "item", key: itemKey("left", id), section: "left", block: null, tabId: id });
  if (!left.length) out.push({ type: "info", text: S.filter ? "No matches." : "Nothing to do here." });

  return out;
}

function blockState(b: Block): "" | "on" | "part" {
  const on = b.tabIds.filter((id) => ticked(itemKey(b.key, id))).length;
  return on === 0 ? "" : on === b.tabIds.length ? "on" : "part";
}

function blockWindow(b: Block): number | null {
  if (b.groupId !== undefined) return groups.get(b.groupId)?.windowId ?? null;
  return majorityWindow(b.tabIds);
}

function rowId(key: string) {
  return "r-" + key.replace(/[^a-zA-Z0-9_-]/g, "_");
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
    const st = blockState(b);
    const caret = `<span class="caret" aria-hidden="true">${S.collapsed.has(b.key) ? "▸" : "▾"}</span>`;
    let name: string;
    let hint = "";
    let meta: string;
    const win = blockWindow(b);
    if (b.groupId !== undefined) {
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
      meta =
        (g.mine ? `<span class="chip ghost">yours</span>` : "") +
        `<span class="win">new${win !== null ? " · " + winShort(win) : ""}</span>`;
    }
    return `<div class="row block on-row${cur}" id="${rowId(r.key)}" data-key="${esc(r.key)}" role="option" aria-selected="${st === "on"}">${caret}<span class="cb ${st}" data-cb></span>${name}<span class="title hintx">${esc(hint)}</span>${meta}</div>`;
  }

  const t = tabs.get(r.tabId);
  if (!t) return "";
  const on = ticked(r.key);
  let tail: string;
  if (r.section === "dupe") {
    const keepId = S.plan!.duplicates.find((d) => d.closeId === r.tabId)?.keepId;
    const k = keepId !== undefined ? tabs.get(keepId) : undefined;
    const where = k
      ? `keeps ${winShort(k.windowId)}${k.pinned ? " pinned" : ""}${k.groupId !== -1 ? " " + esc(groups.get(k.groupId)?.title || "group") : ""}`
      : "";
    tail = `<span class="closetag">close</span><span class="win">${winShort(t.windowId)}${where ? " · " + where : ""}</span>`;
  } else {
    const target = r.section === "left" ? S.leftoversWindowId : r.block ? blockWindow(r.block) : null;
    tail =
      r.section === "left" && target === null
        ? `<span class="win">${winShort(t.windowId)} <span class="mv">→ new window</span></span>`
        : target !== null && target !== t.windowId
          ? `<span class="win">${winShort(t.windowId)} <span class="mv">→ ${winShort(target)}</span></span>`
          : `<span class="win">${winShort(t.windowId)}</span>`;
  }
  const flat = r.block ? "" : " flat";
  return (
    `<div class="row item${flat}${on ? " on-row" : ""}${cur}" id="${rowId(r.key)}" data-key="${esc(r.key)}" role="option" aria-selected="${on}">` +
    `<span class="cb ${on ? "on" : ""}" data-cb></span><img class="fav" src="${esc(favicon(t.url))}" alt="">` +
    `<span class="title">${esc(t.title)}</span><span class="host">${esc(host(t.url))}</span>${tail}</div>`
  );
}

/* ---------------------------------------------------------------- render */

function render() {
  renderSorter();
  if (!S.plan) {
    const p = S.sorting;
    listEl.innerHTML = `<div class="row info">${p ? `Sorting your tabs with on-device AI… ${p.done} of ${p.total}` : "Reading your tabs…"}</div>`;
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
  const dupes = S.plan?.duplicates.length ?? 0;
  $("#stats").innerHTML =
    `<span><b>${all.length}</b> tabs</span><span><b>${windows.size}</b> windows</span>` +
    `<span class="warn"><b>${ungrouped}</b> ungrouped</span><span><b>${dupes}</b> duplicates</span>`;
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

function collectActions(): Actions {
  const p = S.plan!;
  return {
    close: p.duplicates.map((d) => d.closeId).filter((id) => ticked(itemKey("close", id))),
    addToExisting: p.addToExisting
      .map((a) => ({ groupId: a.groupId, tabIds: a.tabIds.filter((id) => ticked(itemKey(`existing:${a.groupId}`, id))) }))
      .filter((a) => a.tabIds.length),
    newGroups: p.newGroups
      .map((g) => ({ key: g.key, name: g.name, color: g.color, tabIds: g.tabIds.filter((id) => ticked(itemKey(`new:${g.key}`, id))) }))
      .filter((g) => g.tabIds.length),
    leftovers: p.leftovers.filter((id) => ticked(itemKey("left", id))),
  };
}

function summaryParts(a: Actions): string[] {
  const parts: string[] = [];
  const add = a.addToExisting.reduce((n, x) => n + x.tabIds.length, 0);
  const fresh = a.newGroups.reduce((n, x) => n + x.tabIds.length, 0);
  if (a.close.length) parts.push(`close <b>${a.close.length}</b> duplicate${a.close.length > 1 ? "s" : ""}`);
  if (add) parts.push(`add <b>${add}</b> to your groups`);
  if (a.newGroups.length) parts.push(`create <b>${a.newGroups.length}</b> group${a.newGroups.length > 1 ? "s" : ""} (${fresh} tabs)`);
  if (a.leftovers.length) parts.push(`move <b>${a.leftovers.length}</b> to Leftovers`);
  return parts;
}

function renderSummary() {
  const parts = summaryParts(collectActions());
  $("#summary").innerHTML = parts.length ? "Ticked: " + parts.join(" · ") : "Nothing ticked.";
  $<HTMLButtonElement>("#apply").disabled = !parts.length || S.busy || !!S.sorting;
}

function renderStatusLine() {
  const el = $("#cururl");
  const r = curRow();
  if (!r) {
    el.innerHTML = `<span class="url">Nothing selected</span>`;
    return;
  }
  if (r.type === "block") {
    const name = r.block.groupId !== undefined ? groups.get(r.block.groupId)?.title || "Unnamed group" : r.block.newGroup!.name;
    el.innerHTML = `<span class="url">Group: ${esc(name)}</span>`;
    return;
  }
  const t = tabs.get(r.tabId);
  let html = `<span class="url main">${esc(t?.url ?? "")}</span>`;
  if (r.section === "dupe") {
    const keepId = S.plan!.duplicates.find((d) => d.closeId === r.tabId)?.keepId;
    const k = keepId !== undefined ? tabs.get(keepId) : undefined;
    if (k) html += `<span class="url">keeps ${esc(k.url)}</span>`;
  }
  el.innerHTML = html;
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
  return S.sorterPref === "ai" && S.aiStatus === "available" ? nanoSorter : siteSorter;
}

let replanGeneration = 0;
let replanAbort: AbortController | null = null;

/** Re-sorts. A newer call cancels an older one that is still running. */
async function replan() {
  if (!S.snapshot) return;
  const generation = ++replanGeneration;
  replanAbort?.abort();
  const abort = new AbortController();
  replanAbort = abort;
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
        onProgress: (done, total) => {
          if (!current() || total === 0) return;
          S.sorting = { done, total };
          if (S.plan) {
            renderSorter();
            renderSummary();
          } else render();
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

function renderSorter() {
  const el = $("#sorter");
  const button = (act: string, label: string, title = "") =>
    `<button type="button" class="link" data-act="${act}"${title ? ` title="${esc(title)}"` : ""}>${label}</button>`;
  if (S.sorting) {
    el.innerHTML = `Sorting with on-device AI… ${S.sorting.done} of ${S.sorting.total} tabs`;
    return;
  }
  if (S.download !== null) {
    el.innerHTML = `Downloading the AI model… ${Math.round(S.download * 100)}%`;
    return;
  }
  if (activeSorter() === nanoSorter) {
    const fb = nanoSorter.lastFallbackCount;
    el.innerHTML = `Sorted by on-device AI${fb ? ` (${fb} by website)` : ""} · ${button("site", "Sort by website instead")}`;
    return;
  }
  const why: Record<NanoStatus, string> = {
    available: button("ai", "Use on-device AI"),
    downloadable: button(
      "download",
      "Use on-device AI",
      "Downloads Chrome's built-in model (Gemini Nano) once. It runs on this computer; your tabs are never sent anywhere.",
    ),
    downloading: button("download", "Use on-device AI (download in progress)"),
    unavailable: "On-device AI isn't available on this computer.",
    unsupported: "On-device AI needs Chrome 138 or later.",
  };
  el.innerHTML = `Sorted by website · ${why[S.aiStatus]}`;
}

$("#sorter").addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "site" || act === "ai") void setSorterPref(act);
  else if (act === "download") void startDownload();
});

async function setSorterPref(pref: SorterPref) {
  S.sorterPref = pref;
  await saveSorterPref(pref);
  renderSorter();
  await replan();
}

async function startDownload() {
  S.download = 0;
  // Start the download first: Chrome only allows it straight after a click.
  const done = downloadNano((f) => {
    S.download = f;
    renderSorter();
  });
  renderSorter();
  try {
    await done;
    S.aiStatus = await nanoStatus();
    S.download = null;
    await setSorterPref("ai");
  } catch (e) {
    S.download = null;
    S.aiStatus = await nanoStatus();
    renderSorter();
    toast(`Couldn't download the AI model: ${e instanceof Error ? e.message : String(e)}`);
  }
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
  const ci = SECTION_ORDER.indexOf(cur ? sectionOf(cur) : "dupe");
  for (let s = ci + d; s >= 0 && s < SECTION_ORDER.length; s += d) {
    const first = nav.find((r) => sectionOf(r) === SECTION_ORDER[s]);
    if (first) {
      setCursor(first.key);
      render();
      return;
    }
  }
}

function itemKeysOf(r: Extract<Row, { key: string }>): string[] {
  return r.type === "block" ? r.block.tabIds.map((id) => itemKey(r.block.key, id)) : [r.key];
}

function setTicked(keys: string[], on: boolean) {
  for (const k of keys) on ? S.unticked.delete(k) : S.unticked.add(k);
}

function toggle(r = curRow()) {
  if (!r) return;
  const keys = itemKeysOf(r);
  setTicked(keys, !keys.every(ticked));
  render();
}

function toggleSection() {
  const r = curRow();
  if (!r) return;
  const section = sectionOf(r);
  const keys = rows
    .filter((x): x is Extract<Row, { key: string }> => "key" in x && x.type === "item" && x.section === section)
    .map((x) => x.key);
  // Include items hidden inside collapsed groups.
  for (const x of rows) if (x.type === "block" && x.block.section === section) keys.push(...itemKeysOf(x));
  const unique = [...new Set(keys)];
  setTicked(unique, !unique.every(ticked));
  render();
}

function collapse(r = curRow()) {
  if (!r) return;
  if (r.type === "item" && r.block) setCursor(r.block.key);
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
  if (!r) return undefined;
  return r.type === "block" ? r.block.newGroup : r.block?.newGroup;
}

async function cycleColor() {
  const r = curRow();
  const g = newGroupOf(r);
  if (!g) return toast(r && (r.type === "block" || r.block) ? "Existing groups keep their color." : "Put the cursor on a new group first.");
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
  if (!g) return toast(r && (r.type === "block" || r.block) ? "Rename existing groups in Chrome itself." : "Put the cursor on a new group first.");
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
  const r = curRow();
  if (!r || r.type !== "item") return toast("Put the cursor on a tab to move it.");
  if (r.section === "dupe") return toast("Duplicates can only be closed or kept.");
  const tabId = r.tabId;
  const currentKey = r.block?.key ?? "left";
  const moveTo = async (target: ManualTarget, cursorPrefix: string) => {
    S.manual.set(tabId, target);
    await replan();
    setCursor(itemKey(cursorPrefix, tabId));
    render();
  };

  const opts: Option[] = [];
  for (const g of groups.values()) {
    const key = `existing:${g.id}`;
    if (key === currentKey) continue;
    opts.push({
      label: g.title || "Unnamed group",
      color: g.color,
      meta: `existing · ${winShort(g.windowId)}`,
      go: () => moveTo({ kind: "existing", groupId: g.id }, key),
    });
  }
  for (const g of S.plan!.newGroups) {
    const key = `new:${g.key}`;
    if (key === currentKey) continue;
    opts.push({
      label: g.name,
      color: g.color,
      meta: g.mine ? "yours" : "new",
      go: () => moveTo({ kind: "new", key: g.key }, key),
    });
  }
  if (currentKey !== "left") opts.push({ label: "Leftovers window", meta: "", go: () => moveTo({ kind: "left" }, "left") });
  opts.push({
    label: "New group…",
    meta: "",
    go: async () => {
      const g = await addUserGroup("New group", "");
      S.manual.set(tabId, { kind: "new", key: `user:${g.id}` });
      await replan();
      S.renaming = `new:user:${g.id}`;
      setCursor(S.renaming);
      render();
    },
  });
  if (S.manual.has(tabId)) {
    opts.push({
      label: "Let the sorter decide",
      meta: "undo your move",
      go: async () => {
        S.manual.delete(tabId);
        await replan();
      },
    });
  }
  openPicker(`Move “${esc(tabs.get(tabId)?.title ?? "")}”`, opts);
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

function openApply() {
  const actions = collectActions();
  const parts = summaryParts(actions);
  if (S.sorting) return toast("Still sorting. Try again in a moment.");
  if (!parts.length) return toast("Tick something first.");
  const total =
    actions.close.length +
    actions.leftovers.length +
    actions.addToExisting.reduce((n, a) => n + a.tabIds.length, 0) +
    actions.newGroups.reduce((n, a) => n + a.tabIds.length, 0);
  showOverlay(`<div class="dialog" role="dialog" aria-modal="true" aria-label="Apply changes">
    <header>Apply ${total} change${total > 1 ? "s" : ""}?<small>Unticked suggestions stay on this page for later.</small></header>
    <div class="body"><ul>${parts.map((p) => `<li>${p.charAt(0).toUpperCase() + p.slice(1)}</li>`).join("")}</ul></div>
    <footer><button type="button" id="ap-cancel">Cancel<kbd>esc</kbd></button><button type="button" class="primary" id="ap-go">Apply<kbd>↵</kbd></button></footer></div>`);
  const go = () => {
    closeModal();
    void doApply(actions);
  };
  S.modal = (e) => {
    if (e.key === "Escape") closeModal();
    else if (e.key === "Enter") go();
    else return;
    e.preventDefault();
  };
  $("#ap-go").addEventListener("click", go);
  $("#ap-cancel").addEventListener("click", closeModal);
  $("#ap-go").focus();
}

async function doApply(actions: Actions) {
  S.busy = true;
  renderSummary();
  try {
    const result = await applyActions(actions, S.leftoversWindowId);
    if (result.leftoversWindowId !== S.leftoversWindowId) {
      S.leftoversWindowId = result.leftoversWindowId;
      await saveLeftoversWindowId(S.leftoversWindowId);
    }
    // Proposed groups that now exist in Chrome are done.
    const created = new Set(actions.newGroups.map((g) => (g as { key?: string }).key));
    S.userGroups = S.userGroups.filter((u) => !created.has(`user:${u.id}`));
    await saveUserGroups(S.userGroups);
    const parts = summaryParts(actions).map((p) => p.replace(/<\/?b>/g, ""));
    toast(result.errors.length ? `Done, with problems: ${result.errors.join("; ")}` : "Done: " + parts.join(" · "));
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
    [["x", "space"], "Tick or untick row or group"],
    [["a"], "Tick or untick whole section"],
    [["m"], "Move tab to another group"],
    [["n"], "Propose your own group"],
    [["d"], "Delete a group you proposed"],
    [["e"], "Rename new group"],
    [["c"], "Change new group's color"],
    [["↵"], "Switch to that tab"],
    [["y"], "Copy the tab's full URL"],
    [["/"], "Filter"],
    [["r"], "Re-scan tabs"],
    [["⇧", "↵"], "Apply ticked changes"],
    [["esc"], "Close dialog / clear filter"],
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
  if (e.metaKey || e.ctrlKey || e.altKey || S.busy || !S.plan) return;
  const r = curRow();
  const k = e.key;
  let handled = true;
  if (k === "j" || k === "ArrowDown") moveCursor(1);
  else if (k === "k" || k === "ArrowUp") moveCursor(-1);
  else if (k === "J") jumpSection(1);
  else if (k === "K") jumpSection(-1);
  else if (k === "g") moveCursor(-1e6);
  else if (k === "G") moveCursor(1e6);
  else if ((k === "x" || k === " ") && onListOrBody(e)) toggle(r);
  else if (k === "a") toggleSection();
  else if (k === "h" || k === "ArrowLeft") collapse(r);
  else if (k === "l" || k === "ArrowRight") expand(r);
  else if (k === "m") openMove();
  else if (k === "n") openPropose();
  else if (k === "d") void deleteUserGroup();
  else if (k === "e" || k === "F2") startRename();
  else if (k === "c") void cycleColor();
  else if (k === "/") {
    filterEl.focus();
    filterEl.select();
  } else if (k === "?") openHelp();
  else if (k === "r") void rescan().then(() => toast("Re-scanned your tabs."));
  else if (k === "y") {
    if (r?.type !== "item") toast("Put the cursor on a tab to copy its URL.");
    else
      navigator.clipboard.writeText(tabs.get(r.tabId)?.url ?? "").then(
        () => toast("Copied URL."),
        () => toast("Couldn't copy. The URL is shown at the bottom."),
      );
  } else if (k === "Enter" && e.shiftKey) openApply();
  else if (k === "Enter" && r && onListOrBody(e)) {
    if (r.type === "item") void switchToTab(r.tabId);
    else {
      S.collapsed.has(r.block.key) ? S.collapsed.delete(r.block.key) : S.collapsed.add(r.block.key);
      render();
    }
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
  if (el.closest("[data-cb]")) toggle(r);
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

$("#apply").addEventListener("click", openApply);
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

(async () => {
  const stored = await loadState();
  S.userGroups = stored.userGroups;
  S.leftoversWindowId = stored.leftoversWindowId;
  S.sorterPref = stored.sorterPref;
  S.aiStatus = await nanoStatus();
  await rescan();
  listEl.focus({ preventScroll: true });
})();
