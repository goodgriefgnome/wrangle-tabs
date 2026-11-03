import type { ModelSession, SessionFactory } from "../core/nanoSorter";

/**
 * Chrome's built-in model (Gemini Nano) through the Prompt API.
 * Available to extensions from Chrome 138. Only the parts this extension uses are typed here.
 */
type Availability = "unavailable" | "downloadable" | "downloading" | "available";
interface CreateMonitor extends EventTarget {}
interface LanguageModelStatic {
  availability(options?: object): Promise<Availability>;
  create(options?: object): Promise<ModelSession & { clone(options?: { signal?: AbortSignal }): Promise<ModelSession> }>;
}
declare const LanguageModel: LanguageModelStatic | undefined;

/** "unsupported" means this Chrome has no Prompt API at all. */
export type NanoStatus = Availability | "unsupported";

const LANGUAGES = {
  // The system prompt is English; tab titles may be in any supported language.
  expectedInputs: [{ type: "text", languages: ["en", "es", "de", "fr", "ja"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

function api(): LanguageModelStatic | null {
  return typeof LanguageModel === "undefined" || !LanguageModel ? null : LanguageModel;
}

export async function nanoStatus(): Promise<NanoStatus> {
  const lm = api();
  if (!lm) return "unsupported";
  try {
    return await lm.availability(LANGUAGES);
  } catch {
    return "unavailable";
  }
}

/** Starts (or joins) the model download. Must be called from a click. */
export async function downloadNano(onProgress: (fraction: number) => void): Promise<void> {
  const lm = api();
  if (!lm) throw new Error("This version of Chrome has no built-in AI.");
  const session = await lm.create({
    ...LANGUAGES,
    monitor(m: CreateMonitor) {
      m.addEventListener("downloadprogress", (e) => onProgress((e as ProgressEvent).loaded));
    },
  });
  session.destroy();
}

/**
 * Sessions for the sorter. One base session holds the system prompt; each batch
 * gets a clone of it, so batches don't see each other's history.
 */
export function nanoSessionFactory(): SessionFactory {
  let base: Promise<Awaited<ReturnType<LanguageModelStatic["create"]>>> | null = null;
  let basePrompt = "";
  return async (systemPrompt, signal) => {
    const lm = api();
    if (!lm) throw new Error("This version of Chrome has no built-in AI.");
    if (!base || basePrompt !== systemPrompt) {
      basePrompt = systemPrompt;
      base = lm.create({ ...LANGUAGES, initialPrompts: [{ role: "system", content: systemPrompt }] });
      base.catch(() => (base = null));
    }
    return (await base).clone({ signal });
  };
}
