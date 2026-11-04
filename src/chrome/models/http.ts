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

/** How long to wait before each retry when a service is busy. Tests shorten these. */
export const retry = { delaysMs: [2000, 5000, 10000, 20000] };

const BUSY_STATUSES = [429, 500, 502, 503, 504];

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * fetch, retrying with growing waits while the service is busy (429, 5xx) or the
 * request fails outright. An overloaded service's error replies often can't be read
 * by an extension page, so they show up as failed requests rather than as a 503.
 * `onStatus` hears about each retry. Returns the last response; throws when every
 * attempt failed outright.
 */
export async function fetchOrExplain(
  url: string,
  service: string,
  init: RequestInit,
  onStatus?: (text: string) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null;
    let failure: unknown = null;
    try {
      response = await fetch(url, init);
    } catch (e) {
      if (init.signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) throw e;
      failure = e;
      console.error(`${service}: request to ${new URL(url).origin} failed`, e);
    }
    const busy = failure !== null || (response !== null && BUSY_STATUSES.includes(response.status));
    if (!busy || attempt >= retry.delaysMs.length) {
      if (response) return response;
      throw new Error(
        `${service}: no readable answer from ${new URL(url).host} after ${attempt + 1} tries (${failure instanceof Error ? failure.message : String(failure)}). ` +
          `Usually the service is overloaded (its error replies can't be read by extensions); try again later, or pick another model in AI settings. ` +
          `It can also mean something blocked the request: the browser console on this page (F12, then Console) shows the exact reason. ` +
          `A local server (such as Ollama) may need to allow requests from extensions, for example with OLLAMA_ORIGINS=chrome-extension://*.`,
      );
    }
    const wait = retry.delaysMs[attempt];
    onStatus?.(
      `${service} is busy${response ? ` (${response.status})` : ""}. Trying again in ${Math.round(wait / 1000)} s (try ${attempt + 2} of ${retry.delaysMs.length + 1}).`,
    );
    await sleep(wait, init.signal);
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
          : response.status === 503
            ? "the service is overloaded right now; try again later, or pick another model in AI settings (for Gemini, for example gemini-flash-lite-latest)"
            : response.status >= 500
              ? `the service had a problem (${response.status}); try again later`
              : `it answered ${response.status}`;
  return new Error(`${service}: ${what}${detail ? ` (${detail})` : ""}`);
}
