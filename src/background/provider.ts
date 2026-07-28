/**
 * The one place in this extension that talks to a model provider.
 *
 * It lives in the service worker because the API key does. A content script shares a page
 * with YouTube's own JavaScript, so a key that reached one would be readable by the page.
 * Nothing here is ever imported by content-script code.
 *
 * The wire format is OpenAI's chat completions API, which is the de facto standard: OpenAI,
 * OpenRouter, Groq, Together, LM Studio and Ollama's compatibility endpoint all speak it, so
 * one request builder covers every provider a user is likely to configure. There is no
 * provider abstraction here on purpose, because there is currently no second shape to
 * abstract over.
 *
 * Nothing throws. Every failure is a typed result carrying the provider's own error text,
 * because "the analysis failed" is useless to somebody who has actually mistyped their key
 * and needs to be told so.
 */

import type { Settings } from '../core/types.ts';

export type ProviderFailureReason =
  | 'no-key'
  | 'network'
  | 'auth'
  | 'rate-limit'
  | 'http'
  | 'empty';

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * How long one completion is allowed to take before it is abandoned.
 *
 * Generous, because rating a long transcript is a genuinely large generation. Bounded at all,
 * because without it a provider that accepts the connection and then stalls leaves the popup
 * saying "Rating difficulty..." forever with no way to tell that from slow progress. Four
 * minutes is also about as long as this can usefully wait: Chrome terminates an idle MV3
 * service worker, and a request outliving the worker takes its own answer down with it.
 */
export const REQUEST_TIMEOUT_MS = 240_000;

export type ProviderResult =
  | { ok: true; content: string; usage: ProviderUsage; elapsedMs: number }
  | { ok: false; reason: ProviderFailureReason; message: string; elapsedMs: number };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A trailing slash on the configured base URL must not produce a double slash. */
export function completionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
}

/** The origin pattern to request through chrome.permissions for a configured base URL. */
export function originPattern(baseUrl: string): string | null {
  try {
    return `${new URL(baseUrl.trim()).origin}/*`;
  } catch {
    return null;
  }
}

/**
 * Pulls something human-readable out of an error body.
 *
 * Providers disagree about the shape. OpenAI sends `{error: {message}}`, some proxies send
 * `{message}`, and a misconfigured base URL usually sends an HTML error page. The last case
 * is why the raw body is truncated rather than shown whole.
 */
function describeError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === 'string' && message.length > 0) return message;
  } catch {
    // Not JSON. Fall through to the raw body.
  }

  const trimmed = body.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : `The provider returned HTTP ${status}.`;
}

function classify(status: number): ProviderFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  return 'http';
}

interface RequestOptions {
  maxTokens?: number;
  /** Off for the connection test, which asks for two tokens of anything. */
  jsonMode?: boolean;
  signal?: AbortSignal;
}

/**
 * One chat completion.
 *
 * `response_format: {type: 'json_object'}` is requested when json mode is on, and dropped on
 * a single retry if the endpoint rejects it. Spec 7.1 asks for exactly that tolerance: local
 * runtimes and older proxies frequently 400 on a parameter they do not implement, and the
 * prompt already demands raw JSON on its own, so the parameter is a help rather than a
 * requirement.
 */
export async function requestCompletion(
  settings: Settings,
  messages: ChatMessage[],
  options: RequestOptions = {},
): Promise<ProviderResult> {
  const startedAt = Date.now();
  const since = () => Date.now() - startedAt;

  if (settings.apiKey.trim().length === 0) {
    return {
      ok: false,
      reason: 'no-key',
      message: 'No API key is set. Add one in the extension options.',
      elapsedMs: since(),
    };
  }

  const { maxTokens, jsonMode = true, signal } = options;
  const url = completionsUrl(settings.baseUrl);

  // A fresh timeout per attempt rather than one budget across both, since the json-mode
  // retry is a second request and not a continuation of the first.
  const send = async (withJsonMode: boolean): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: settings.model,
        // Difficulty is a judgement, not a creative act, and a cached analysis should be
        // reproducible. Sampling buys nothing here.
        temperature: 0,
        messages,
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let response: Response;
  try {
    response = await send(jsonMode);
    if (!response.ok && jsonMode && (await mentionsResponseFormat(response))) {
      response = await send(false);
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      reason: 'network',
      message: timedOut
        ? `The provider did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`
        : error instanceof Error && error.name === 'AbortError'
          ? 'The request was cancelled.'
          : `Could not reach ${url}. Check the base URL and that the extension has permission for it.`,
      elapsedMs: since(),
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      reason: classify(response.status),
      message: describeError(response.status, body),
      elapsedMs: since(),
    };
  }

  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return {
      ok: false,
      reason: 'empty',
      message: 'The provider returned a response that was not JSON.',
      elapsedMs: since(),
    };
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    return {
      ok: false,
      reason: 'empty',
      message: 'The provider returned an empty completion.',
      elapsedMs: since(),
    };
  }

  return {
    ok: true,
    content,
    usage: {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
    },
    elapsedMs: since(),
  };
}

/**
 * True when a failed response is complaining about the json mode parameter specifically.
 *
 * Reads the body through a clone so the original response can still be consumed by the
 * caller if this returns false.
 */
async function mentionsResponseFormat(response: Response): Promise<boolean> {
  const body = await response
    .clone()
    .text()
    .catch(() => '');
  return /response_format/i.test(body);
}

/** Spec 6.6's Test connection: the smallest completion that proves the settings work. */
export async function testConnection(settings: Settings): Promise<ProviderResult> {
  return requestCompletion(
    settings,
    [{ role: 'user', content: 'Reply with the single word: ok' }],
    { maxTokens: 2, jsonMode: false },
  );
}
