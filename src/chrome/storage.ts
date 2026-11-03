import type { UserGroup } from "../core/types";
import { DEFAULT_AI_SETTINGS, type AiSettings } from "./aiSettings";

interface Stored {
  userGroups?: UserGroup[];
  leftoversWindowId?: number | null;
  ai?: AiSettings;
  /** Before AI settings existed: "ai" meant Chrome's built-in AI, "site" no AI. */
  sorterPref?: "ai" | "site";
}

export async function loadState(): Promise<{ userGroups: UserGroup[]; leftoversWindowId: number | null; ai: AiSettings }> {
  const s = (await chrome.storage.local.get(["userGroups", "leftoversWindowId", "ai", "sorterPref"])) as Stored;
  const ai: AiSettings = {
    ...DEFAULT_AI_SETTINGS,
    ...s.ai,
    gemini: { ...DEFAULT_AI_SETTINGS.gemini, ...s.ai?.gemini },
    openai: { ...DEFAULT_AI_SETTINGS.openai, ...s.ai?.openai },
  };
  if (!s.ai && s.sorterPref === "site") ai.choice = "site";
  return { userGroups: s.userGroups ?? [], leftoversWindowId: s.leftoversWindowId ?? null, ai };
}

export function saveUserGroups(userGroups: UserGroup[]): Promise<void> {
  return chrome.storage.local.set({ userGroups });
}

export function saveLeftoversWindowId(id: number | null): Promise<void> {
  return chrome.storage.local.set({ leftoversWindowId: id });
}

/** API keys are stored only in this browser (local storage is not synced). */
export function saveAiSettings(ai: AiSettings): Promise<void> {
  return chrome.storage.local.set({ ai });
}
