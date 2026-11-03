import type { Model, ModelRequest } from "../../core/model";
import { apiError, sseData } from "./http";

/** The Gemini API (Google AI Studio), which has a free tier. Get a key at https://aistudio.google.com/apikey. */
export interface GeminiSettings {
  apiKey: string;
  /** For example "gemini-flash-latest". */
  model: string;
}

export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com/*";

export function geminiModel({ apiKey, model }: GeminiSettings): Model {
  return {
    name: "Gemini API",
    maxBatch: 150,
    contextTokens: 200_000,
    async complete({ system, prompt, schema, signal, onText }: ModelRequest) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const response = await fetch(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0.2 },
        }),
      });
      if (!response.ok) throw await apiError(response, "Gemini API");
      let text = "";
      for await (const data of sseData(response)) {
        const chunk = JSON.parse(data) as {
          candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
          promptFeedback?: { blockReason?: string };
        };
        if (chunk.promptFeedback?.blockReason) throw new Error(`Gemini API: the request was blocked (${chunk.promptFeedback.blockReason})`);
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) if (part.text && !part.thought) text += part.text;
        onText?.(text);
      }
      return text;
    },
  };
}
