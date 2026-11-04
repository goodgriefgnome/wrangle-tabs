import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiModel } from "../src/chrome/models/gemini";
import { retry } from "../src/chrome/models/http";
import { openAiCompatibleModel } from "../src/chrome/models/openAiCompatible";

/** A server-sent-events response made of these `data:` payloads, split at awkward places. */
function sse(payloads: string[], status = 200): Response {
  const text = payloads.map((p) => `data: ${p}\n\n`).join("");
  const pieces = text.match(/[\s\S]{1,13}/g) ?? [];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

const request = { system: "Be helpful.", prompt: "Sort these.", schema: { type: "object" } };

beforeEach(() => {
  retry.delaysMs = [1, 1];
});
afterEach(() => vi.unstubAllGlobals());

describe("Gemini API", () => {
  it("sends the system prompt, prompt and schema, and streams the answer", async () => {
    const fetch = vi.fn(async () =>
      sse([
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"tabs":' }] } }] }),
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "[]}" }] } }] }),
      ]),
    );
    vi.stubGlobal("fetch", fetch);
    const seen: string[] = [];
    const out = await geminiModel({ apiKey: "KEY", model: "gemini-flash-latest" }).complete({ ...request, onText: (t) => seen.push(t) });
    expect(out).toBe('{"tabs":[]}');
    expect(seen).toEqual(['{"tabs":', '{"tabs":[]}']);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("KEY");
    expect(JSON.parse(init.body as string)).toEqual({
      systemInstruction: { parts: [{ text: "Be helpful." }] },
      contents: [{ role: "user", parts: [{ text: "Sort these." }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" }, temperature: 0.2 },
    });
  });

  it("explains a refused key", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 }));
    await expect(geminiModel({ apiKey: "bad", model: "m" }).complete(request)).rejects.toThrow("Gemini API: it answered 400 (API key not valid.)");
  });

  it("explains when the server can't be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(geminiModel({ apiKey: "k", model: "m" }).complete(request)).rejects.toThrow("Gemini API: no readable answer from generativelanguage.googleapis.com after 3 tries (Failed to fetch)");
  });

  it("retries while the service is busy, saying so", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(async () => sse([JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] })]));
    vi.stubGlobal("fetch", fetch);
    const status: string[] = [];
    const out = await geminiModel({ apiKey: "k", model: "m" }).complete({ ...request, onStatus: (t) => status.push(t) });
    expect(out).toBe("{}");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(status[0]).toMatch(/^Gemini API is busy \(503\)\. Trying again/);
  });

  it("explains an overloaded service once retries run out", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "The model is overloaded." } }), { status: 503 }));
    await expect(geminiModel({ apiKey: "k", model: "m" }).complete(request)).rejects.toThrow("overloaded right now");
  });

  it("explains a rate limit", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429 }));
    await expect(geminiModel({ apiKey: "k", model: "m" }).complete(request)).rejects.toThrow("rate limit");
  });
});

describe("OpenAI-compatible API", () => {
  const settings = { baseUrl: "https://openrouter.ai/api/v1/", apiKey: "KEY", model: "some/model:free" };

  it("streams chat completions with a JSON schema", async () => {
    const fetch = vi.fn(async () =>
      sse([JSON.stringify({ choices: [{ delta: { content: '{"tabs"' } }] }), JSON.stringify({ choices: [{ delta: { content: ":[]}" } }] }), "[DONE]"]),
    );
    vi.stubGlobal("fetch", fetch);
    const model = openAiCompatibleModel(settings);
    expect(model.name).toBe("some/model:free at openrouter.ai");
    expect(await model.complete(request)).toBe('{"tabs":[]}');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer KEY");
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Sort these." },
    ]);
    expect(body.response_format.json_schema.schema).toEqual({ type: "object" });
  });

  it("retries without a schema when the server rejects it, and remembers", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("response_format not supported", { status: 400 }))
      .mockImplementation(async () => sse([JSON.stringify({ choices: [{ delta: { content: "{}" } }] }), "[DONE]"]));
    vi.stubGlobal("fetch", fetch);
    const model = openAiCompatibleModel({ ...settings, apiKey: "" });
    expect(await model.complete(request)).toBe("{}");
    await model.complete(request);
    const bodies = fetch.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies.map((b) => "response_format" in b)).toEqual([true, false, false]);
    expect(bodies[1].messages[0].content).toContain("JSON Schema");
    expect((fetch.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("authorization");
  });
});
