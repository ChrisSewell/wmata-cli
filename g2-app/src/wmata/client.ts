// Thin HTTP client for the WMATA REST API.
//
// Direct port of wmata/api/client.py. Uses `fetch` + `AbortController`
// instead of `requests.Session` + a `timeout=` kwarg, but error
// semantics and messages are kept aligned with the Python so that any
// shared UX strings (e.g., the validate flow) read the same.

import { VALIDATE } from "./endpoints";

/** Raised when a WMATA API call fails. Mirrors Python's `WmataError`. */
export class WmataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WmataError";
  }
}

const TIMEOUT_MS = 15_000;

/** Best-effort `.Message` extraction from a parsed error body. */
function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "Message" in body) {
    const m = (body as { Message: unknown }).Message;
    if (typeof m === "string") return m;
  }
  return fallback;
}

export class WmataClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Perform a GET request and return parsed JSON.
   *
   * The `T` generic is asserted at the boundary — callers are
   * responsible for picking a shape that matches the endpoint.
   *
   * @throws WmataError on network, timeout, HTTP, or decode failures.
   */
  async get<T>(url: string, params?: Record<string, string>): Promise<T> {
    const finalUrl = params ? `${url}?${new URLSearchParams(params).toString()}` : url;

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
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new WmataError("Request timed out. The WMATA API may be slow — try again.");
      }
      throw new WmataError("Could not connect to the WMATA API. Check your internet connection.");
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 401) {
      throw new WmataError("Invalid or expired API key (HTTP 401).");
    }

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

  /**
   * Return `true` iff the API key is accepted by WMATA.
   *
   * Catches every error and returns false — mirrors the Python's
   * `except requests.RequestException` and the broader intent of
   * never throwing from validate().
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
