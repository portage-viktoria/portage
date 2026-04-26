/**
 * Anthropic API client.
 *
 * Thin wrapper around Claude's messages endpoint. Used for both the section
 * classifier and (in milestone 4b) the module matcher.
 *
 * Configuration via env:
 *   ANTHROPIC_API_KEY — required
 *   ANTHROPIC_MODEL   — optional, defaults to a fast/cheap classifier model
 *
 * We deliberately don't use the official SDK to keep the dependency surface
 * small. A few hundred lines of fetch-based wrapping is fine for our needs.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    };

export type AnthropicCallOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
  messages: AnthropicMessage[];
};

export type AnthropicResponse = {
  content: Array<{ type: "text"; text: string }>;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
};

export async function callAnthropic(
  options: AnthropicCallOptions
): Promise<AnthropicResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const body: Record<string, unknown> = {
    model: options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? 1024,
    messages: options.messages,
  };
  if (options.system) body.system = options.system;
  if (typeof options.temperature === "number") body.temperature = options.temperature;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Anthropic API error (${res.status}): ${errorText.slice(0, 500)}`
    );
  }

  return res.json();
}

/**
 * Helper: extract the concatenated text from an Anthropic response.
 */
export function extractText(response: AnthropicResponse): string {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Helper: parse a JSON object from a model response, tolerating common
 * formatting issues (markdown code fences, leading/trailing prose).
 */
export function parseJsonResponse<T = unknown>(text: string): T {
  let cleaned = text.trim();

  // Strip markdown code fences if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  cleaned = cleaned.trim();

  // Find the outermost JSON object/array
  const firstBrace = cleaned.search(/[\{\[]/);
  if (firstBrace > 0) cleaned = cleaned.slice(firstBrace);

  const lastBrace = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (lastBrace >= 0 && lastBrace < cleaned.length - 1) {
    cleaned = cleaned.slice(0, lastBrace + 1);
  }

  return JSON.parse(cleaned) as T;
}