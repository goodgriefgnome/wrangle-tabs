/**
 * The one thing the AI sorter needs from a language model: send a prompt,
 * get an answer back as JSON text. Each way of reaching a model (Chrome's
 * built-in AI, the Gemini API, OpenAI-compatible APIs, …) implements this.
 */
export interface ModelRequest {
  /** Instructions that stay the same for every request. */
  system: string;
  prompt: string;
  /** JSON Schema the answer must follow. Models that can't enforce it get it as guidance only. */
  schema: object;
  signal?: AbortSignal;
  /** Called with the whole answer so far, as it streams in. */
  onText?: (textSoFar: string) => void;
}

export interface Model {
  /** How the dashboard refers to it, e.g. "on-device AI" or "Gemini API". */
  readonly name: string;
  /** Most tabs to send in one request. */
  readonly maxBatch: number;
  /** Tokens one request may use, prompt and answer together. */
  readonly contextTokens: number;
  /** Tokens a request's prompt would use. Without it, they're estimated from its length. */
  measure?(request: ModelRequest): Promise<number>;
  /** Sends one request and returns the whole answer. */
  complete(request: ModelRequest): Promise<string>;
}

/** Rough token count for models that can't measure: about four characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
