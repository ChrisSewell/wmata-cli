// Thin HTTP client for the WMATA REST API. `fetch` + `AbortController` with a
// per-attempt timeout, typed `WmataError` mapping, and a bounded retry/backoff
// branch for rate-limit (429) and transient (503) responses — WMATA's free
// tier is 10 req/s, and a poller that briefly trips it should back off, not
// surface an error.

import { VALIDATE } from "./endpoints";

/** Raised when a WMATA API call fails. */
export class WmataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WmataError";
  }
}

const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2; // 3 attempts total
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 4_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Best-effort `.Message` extraction from a parsed error body. */
function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "Message" in body) {
    const m = (body as { Message: unknown }).Message;
    if (typeof m === "string") return m;
  }
  return fallback;
}

/** Parse a Retry-After header (integer seconds) into ms, or null. */
function retryAfterMs(resp: Response): number | null {
  const h = resp.headers.get("Retry-After");
  if (!h) return null;
  const secs = Number(h);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

/** Exponential backoff with jitter for attempt `n` (0-based). */
function backoffMs(n: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** n);
  return base / 2 + Math.random() * (base / 2);
}

export class WmataClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Perform a GET and return parsed JSON. The `T` generic is asserted at the
   * boundary — callers pick a shape matching the endpoint.
   *
   * Retries network failures and 429/503 up to `MAX_RETRIES` times, honoring
   * `Retry-After` when present. Never retries 400/401 (client errors).
   *
   * @throws WmataError on network, timeout, HTTP, or decode failures.
   */
  async get<T>(url: string, params?: Record<string, string>): Promise<T> {
    const finalUrl = params ? `${url}?${new URLSearchParams(params).toString()}` : url;

    let lastError: WmataError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(finalUrl, {
          method: "GET",
          headers: { api_key: this.apiKey },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        lastError =
          err instanceof DOMException && err.name === "AbortError"
            ? new WmataError("Request timed out. The WMATA API may be slow — try again.")
            : new WmataError("Could not connect to the WMATA API. Check your internet connection.");
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      // Client errors — never retried.
      if (resp.status === 401) throw new WmataError("Invalid or expired API key (HTTP 401).");
      if (resp.status === 400) {
        const raw = await resp.text();
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          body = { Message: raw };
        }
        throw new WmataError(`Bad request: ${extractMessage(body, raw)}`);
      }

      // Rate-limit / transient — back off and retry.
      if (resp.status === 429 || resp.status === 503) {
        lastError = new WmataError(
          resp.status === 429
            ? "WMATA API rate limit reached (HTTP 429)."
            : "WMATA API temporarily unavailable (HTTP 503).",
        );
        if (attempt < MAX_RETRIES) {
          await sleep(retryAfterMs(resp) ?? backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (!resp.ok) {
        const raw = await resp.text();
        throw new WmataError(`WMATA API returned HTTP ${resp.status}: ${raw.slice(0, 200)}`);
      }

      const raw = await resp.text();
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new WmataError("WMATA API returned non-JSON response.");
      }
    }
    // Unreachable: the loop either returns or throws. Satisfy the type checker.
    throw lastError ?? new WmataError("WMATA request failed.");
  }

  /**
   * Return `true` iff the API key is accepted by WMATA. Never throws —
   * any error (network, timeout, non-200) maps to `false`.
   */
  async validate(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(VALIDATE, {
        method: "GET",
        headers: { api_key: this.apiKey },
        signal: controller.signal,
      });
      return resp.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
