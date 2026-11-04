import type { Model } from "../core/model";
import { chromeAiModel } from "./models/chromeAi";
import { geminiModel, type GeminiSettings } from "./models/gemini";
import { openAiCompatibleModel, type OpenAiCompatibleSettings } from "./models/openAiCompatible";

/**
 * Which model groups tabs by subject. To add another kind of model: implement
 * `Model` (src/core/model.ts) in src/chrome/models/, add a choice here, and add
 * its fields to the settings dialog in the dashboard.
 */
export type AiChoice = "chrome" | "gemini" | "openai" | "site";

export interface AiSettings {
  choice: AiChoice;
  gemini: GeminiSettings;
  openai: OpenAiCompatibleSettings;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  choice: "chrome",
  gemini: { apiKey: "", model: "gemini-flash-latest" },
  openai: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "", model: "" },
};

/** What's missing before a choice can be used, or null when nothing is. */
export function missingSetting(s: AiSettings): string | null {
  if (s.choice === "gemini") {
    if (!s.gemini.apiKey.trim()) return "an API key";
    if (!s.gemini.model.trim()) return "a model name";
  }
  if (s.choice === "openai") {
    try {
      new URL(s.openai.baseUrl);
    } catch {
      return "a valid address";
    }
    if (!s.openai.model.trim()) return "a model name";
  }
  return null;
}

/**
 * Websites the extension asks permission to reach for a choice. The Gemini API
 * accepts requests from extension pages without it; OpenAI-compatible servers
 * may not (a local Ollama, for one), so for those it's asked for, but not required.
 */
export function originsFor(s: AiSettings): string[] {
  if (s.choice === "openai") {
    try {
      return [`${new URL(s.openai.baseUrl).origin}/*`];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Asks for permission to reach the model's website, if it needs asking. Must be
 * called straight from a click or key press. Never throws: false when refused or failed.
 */
export async function requestPermission(s: AiSettings): Promise<boolean> {
  const origins = originsFor(s);
  if (!origins.length) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch (e) {
    console.warn("Couldn't ask for permission to reach", origins, e);
    return false;
  }
}

let chromeModel: Model | null = null;

/** The model for a choice, or null for "site". */
export function modelFor(s: AiSettings): Model | null {
  switch (s.choice) {
    case "chrome":
      return (chromeModel ??= chromeAiModel());
    case "gemini":
      return geminiModel({ apiKey: s.gemini.apiKey.trim(), model: s.gemini.model.trim() });
    case "openai":
      return openAiCompatibleModel({ baseUrl: s.openai.baseUrl.trim(), apiKey: s.openai.apiKey.trim(), model: s.openai.model.trim() });
    case "site":
      return null;
  }
}
