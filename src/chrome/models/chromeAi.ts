import type { Model, ModelRequest } from "../../core/model";

/**
 * Chrome's built-in model (Gemini Nano) through the Prompt API.
 * Available to extensions from Chrome 138. Only the parts this extension uses are typed here.
 */
type Availability = "unavailable" | "downloadable" | "downloading" | "available";
interface Session {
  prompt(input: string, options?: { responseConstraint?: object; signal?: AbortSignal }): Promise<string>;
  promptStreaming?(input: string, options?: { responseConstraint?: object; signal?: AbortSignal }): ReadableStream<string>;
  measureContextUsage?(input: string, options?: { responseConstraint?: object }): Promise<number>;
  readonly contextUsage?: number;
  readonly contextWindow?: number;
  clone(options?: { signal?: AbortSignal }): Promise<Session>;
  destroy(): void;
}
interface LanguageModelStatic {
  availability(options?: object): Promise<Availability>;
  create(options?: object): Promise<Session>;
}
declare const LanguageModel: LanguageModelStatic | undefined;

/** "unsupported" means this Chrome has no Prompt API at all. */
export type ChromeAiStatus = Availability | "unsupported";

const LANGUAGES = {
  // The system prompt is English; tab titles may be in any supported language.
  expectedInputs: [{ type: "text", languages: ["en", "es", "de", "fr", "ja"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

function api(): LanguageModelStatic {
  if (typeof LanguageModel === "undefined" || !LanguageModel) throw new Error("This version of Chrome has no built-in AI.");
  return LanguageModel;
}

export async function chromeAiStatus(): Promise<ChromeAiStatus> {
  if (typeof LanguageModel === "undefined" || !LanguageModel) return "unsupported";
  try {
    return await LanguageModel.availability(LANGUAGES);
  } catch {
    return "unavailable";
  }
}

/** Starts (or joins) the model download. Must be called from a click. */
export async function downloadChromeAi(onProgress: (fraction: number) => void): Promise<void> {
  const session = await api().create({
    ...LANGUAGES,
    monitor(m: EventTarget) {
      m.addEventListener("downloadprogress", (e) => onProgress((e as ProgressEvent).loaded));
    },
  });
  session.destroy();
}

/**
 * Keeps one base session per system prompt; each request gets a clone of it,
 * so requests don't see each other's history.
 */
export function chromeAiModel(): Model {
  const bases = new Map<string, Promise<Session>>();
  let contextWindow = 4096;
  const base = (system: string) => {
    let b = bases.get(system);
    if (!b) {
      b = api().create({ ...LANGUAGES, initialPrompts: [{ role: "system", content: system }] });
      bases.set(system, b);
      b.catch(() => bases.delete(system));
    }
    return b;
  };

  return {
    name: "on-device AI",
    maxBatch: 30,
    get contextTokens() {
      return contextWindow;
    },
    async measure({ system, prompt, schema }: ModelRequest) {
      const s = await base(system);
      contextWindow = s.contextWindow ?? contextWindow;
      const need = s.measureContextUsage ? await s.measureContextUsage(prompt, { responseConstraint: schema }) : prompt.length / 4;
      return (s.contextUsage ?? 0) + need;
    },
    async complete({ system, prompt, schema, signal, onText }: ModelRequest) {
      const session = await (await base(system)).clone({ signal });
      try {
        const options = { responseConstraint: schema, signal };
        if (!session.promptStreaming) {
          const raw = await session.prompt(prompt, options);
          onText?.(raw);
          return raw;
        }
        let text = "";
        const reader = session.promptStreaming(prompt, options).getReader();
        // Stop reading as soon as the request is cancelled, even if the stream doesn't notice.
        signal?.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
        for (;;) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          // Older Chrome versions sent the whole answer so far in each chunk; newer ones send only the new part.
          text = value.startsWith(text) && text ? value : text + value;
          onText?.(text);
        }
        signal?.throwIfAborted();
        return text;
      } finally {
        session.destroy();
      }
    },
  };
}
