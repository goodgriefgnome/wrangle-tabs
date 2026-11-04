import type { Model, ModelRequest } from "../../core/model";
import { apiError, fetchOrExplain, sseData } from "./http";

/**
 * Any API that speaks OpenAI's chat-completions format: OpenRouter, Groq,
 * a local Ollama or LM Studio, and many more.
 */
export interface OpenAiCompatibleSettings {
  /** For example "https://openrouter.ai/api/v1" or "http://localhost:11434/v1". */
  baseUrl: string;
  /** Can be empty for local servers. */
  apiKey: string;
  model: string;
}

export function openAiCompatibleModel({ baseUrl, apiKey, model }: OpenAiCompatibleSettings): Model {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // Shown as typed.
  }
  // Remembers when the server rejected a JSON schema, so later requests don't try again.
  let schemaSupported = true;

  const send = (request: ModelRequest, withSchema: boolean) =>
    fetchOrExplain(url, host, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        // OpenRouter shows these in its dashboard; other servers ignore them.
        "x-title": "Wrangle Tabs",
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: withSchema
              ? request.system
              : `${request.system}\nYour answer must be JSON matching this JSON Schema:\n${JSON.stringify(request.schema)}`,
          },
          { role: "user", content: request.prompt },
        ],
        ...(withSchema
          ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema: request.schema, strict: false } } }
          : {}),
      }),
    });

  return {
    name: `${model} at ${host}`,
    maxBatch: 100,
    contextTokens: 32_000,
    async complete(request: ModelRequest) {
      let response = await send(request, schemaSupported);
      // Some servers and models don't support JSON schemas: try once more with the schema in the instructions.
      if (response.status === 400 && schemaSupported) {
        schemaSupported = false;
        response = await send(request, false);
      }
      if (!response.ok) throw await apiError(response, host);
      let text = "";
      for await (const data of sseData(response)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[]; error?: { message?: string } };
        if (chunk.error) throw new Error(`${host}: ${chunk.error.message ?? "error"}`);
        text += chunk.choices?.[0]?.delta?.content ?? "";
        request.onText?.(text);
      }
      return text;
    },
  };
}
