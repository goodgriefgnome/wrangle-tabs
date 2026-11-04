/** Yields the `data:` payloads of a server-sent-events response. */
export async function* sseData(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += value;
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = done ? "" : events.pop()!;
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
    if (done) return;
  }
}

/** fetch, but when the server can't be reached at all, says what to check. */
export async function fetchOrExplain(url: string, service: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error(
      `${service}: couldn't connect. Check the address and your connection. A local server (such as Ollama) may also need to allow requests from extensions, for example by setting OLLAMA_ORIGINS=chrome-extension://*.`,
    );
  }
}

/** A readable error for a failed API response. */
export async function apiError(response: Response, service: string): Promise<Error> {
  let detail = "";
  try {
    const body = await response.text();
    try {
      const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      detail = (typeof json.error === "string" ? json.error : json.error?.message) ?? json.message ?? body;
    } catch {
      detail = body;
    }
  } catch {
    // No body.
  }
  detail = detail.trim().slice(0, 300);
  const what =
    response.status === 401 || response.status === 403
      ? "the API key was refused"
      : response.status === 429
        ? "the rate limit was reached; try again later"
        : response.status === 404
          ? "the model or address wasn't found"
          : `it answered ${response.status}`;
  return new Error(`${service}: ${what}${detail ? ` (${detail})` : ""}`);
}
