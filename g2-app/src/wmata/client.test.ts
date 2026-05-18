// Unit tests for the WMATA HTTP client wrapper.
//
// Acceptance surface (mirrors client.ts):
//   - Constructor stores apiKey; every GET sends it as `api_key` header.
//   - Successful GET parses JSON of type T.
//   - Query-string params get appended via URLSearchParams.
//   - 401 → WmataError "Invalid or expired API key (HTTP 401).".
//   - 400 with JSON body containing `Message` → "Bad request: <Message>".
//   - 400 with plain-text body → "Bad request: <text>".
//   - 400 with malformed JSON → degrades to raw text in the message.
//   - 5xx → "WMATA API returned HTTP <n>: <first 200 chars>".
//   - Network-layer throw → "Could not connect to the WMATA API. ...".
//   - AbortError → "Request timed out. ...".
//   - Non-JSON 200 body → "WMATA API returned non-JSON response.".
//   - validate() returns true/false; never throws.
//
// We mock fetch via `vi.stubGlobal` (same pattern other tests use through
// `Pick<WmataClient, 'get'>` doubles, just at the global-fetch boundary
// instead).

import { afterEach, describe, expect, it, vi } from "vitest";
import { WmataClient, WmataError } from "./client";
import { VALIDATE } from "./endpoints";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a `Response`-ish object the client's code-paths inspect. */
function makeResponse(opts: {
  status: number;
  body: string;
}): Response {
  // Construct an actual Response so resp.text() works and resp.ok is
  // computed for us. Response is a Web Fetch global available in Node 20+.
  return new Response(opts.body, { status: opts.status });
}

/** Type for fetch so we can stub it without `any`. */
type FetchFn = typeof globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Constructor + happy path
// ---------------------------------------------------------------------------

describe("WmataClient constructor + header", () => {
  it("stores the API key and sends it as the `api_key` request header on get()", async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch: FetchFn = (_url, init) => {
      capturedInit = init;
      return Promise.resolve(makeResponse({ status: 200, body: "{}" }));
    };
    vi.stubGlobal("fetch", fakeFetch);

    const client = new WmataClient("MY-SECRET-KEY");
    await client.get<Record<string, unknown>>("https://example.com/x");

    expect(capturedInit).toBeDefined();
    expect(capturedInit!.method).toBe("GET");
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["api_key"]).toBe("MY-SECRET-KEY");
  });
});

describe("WmataClient.get successful path", () => {
  it("parses the JSON body and returns it as T", async () => {
    const payload = { Trains: [{ Min: "3" }, { Min: "ARR" }] };
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(
          makeResponse({ status: 200, body: JSON.stringify(payload) }),
        )) as FetchFn,
    );

    const client = new WmataClient("k");
    const result = await client.get<{ Trains: { Min: string }[] }>(
      "https://example.com/x",
    );
    expect(result.Trains.length).toBe(2);
    expect(result.Trains[0]!.Min).toBe("3");
  });

  it("Generic T typing: client.get<{ Trains: unknown[] }>(...) returns the typed shape", async () => {
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(
          makeResponse({
            status: 200,
            body: JSON.stringify({ Trains: [1, 2, 3] }),
          }),
        )) as FetchFn,
    );

    const client = new WmataClient("k");
    const result = await client.get<{ Trains: unknown[] }>(
      "https://example.com/x",
    );
    // Compile-time: the generic was preserved. Runtime: shape lines up.
    expect(Array.isArray(result.Trains)).toBe(true);
    expect(result.Trains.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Params → query string
// ---------------------------------------------------------------------------

describe("WmataClient.get builds query string from params", () => {
  it("appends a `?key=value` query string when params are supplied", async () => {
    let capturedUrl = "";
    const fakeFetch: FetchFn = (url, _init) => {
      capturedUrl = String(url);
      return Promise.resolve(makeResponse({ status: 200, body: "{}" }));
    };
    vi.stubGlobal("fetch", fakeFetch);

    const client = new WmataClient("k");
    await client.get<Record<string, unknown>>("https://example.com/x", {
      StationCode: "A01",
      LineCode: "RD",
    });

    // URLSearchParams ordering is insertion-order, so this is stable.
    expect(capturedUrl).toBe(
      "https://example.com/x?StationCode=A01&LineCode=RD",
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP 401
// ---------------------------------------------------------------------------

describe("WmataClient.get HTTP 401", () => {
  it("throws WmataError with the canonical 401 message", async () => {
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(makeResponse({ status: 401, body: "" }))) as FetchFn,
    );

    const client = new WmataClient("k");
    let caught: unknown = null;
    try {
      await client.get("https://example.com/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WmataError);
    expect((caught as WmataError).message).toBe(
      "Invalid or expired API key (HTTP 401).",
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP 400
// ---------------------------------------------------------------------------

describe("WmataClient.get HTTP 400", () => {
  it("extracts `.Message` from a JSON body and uses it", async () => {
    const body = JSON.stringify({ Message: "Missing required parameter" });
    vi.stubGlobal(
      "fetch",
      (() => Promise.resolve(makeResponse({ status: 400, body }))) as FetchFn,
    );

    const client = new WmataClient("k");
    await expect(client.get("https://example.com/x")).rejects.toThrow(
      "Bad request: Missing required parameter",
    );
  });

  it("falls back to the raw plain-text body when there's no JSON wrapper", async () => {
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(
          makeResponse({ status: 400, body: "not a json body" }),
        )) as FetchFn,
    );

    const client = new WmataClient("k");
    await expect(client.get("https://example.com/x")).rejects.toThrow(
      "Bad request: not a json body",
    );
  });

  it("degrades to the raw text when JSON.parse blows up on malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(
          makeResponse({ status: 400, body: "{ not really: json " }),
        )) as FetchFn,
    );

    const client = new WmataClient("k");
    await expect(client.get("https://example.com/x")).rejects.toThrow(
      "Bad request: { not really: json ",
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP 5xx (and other non-ok)
// ---------------------------------------------------------------------------

describe("WmataClient.get HTTP 500", () => {
  it("includes the status code and the first 200 chars of the body", async () => {
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(
          makeResponse({ status: 500, body: "Upstream gateway failure" }),
        )) as FetchFn,
    );

    const client = new WmataClient("k");
    await expect(client.get("https://example.com/x")).rejects.toThrow(
      "WMATA API returned HTTP 500: Upstream gateway failure",
    );
  });

  it("slices the body to 200 chars when it's longer", async () => {
    const long = "x".repeat(500);
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(makeResponse({ status: 500, body: long }))) as FetchFn,
    );

    const client = new WmataClient("k");
    let caught: unknown = null;
    try {
      await client.get("https://example.com/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WmataError);
    const msg = (caught as WmataError).message;
    // The "x" run must be exactly 200 chars long (the body slice).
    const sliced = msg.slice("WMATA API returned HTTP 500: ".length);
    expect(sliced.length).toBe(200);
    expect(sliced).toBe("x".repeat(200));
  });
});

// ---------------------------------------------------------------------------
// Network error
// ---------------------------------------------------------------------------

describe("WmataClient.get network error", () => {
  it("translates a TypeError-ish fetch throw into the network message", async () => {
    vi.stubGlobal(
      "fetch",
      (() => Promise.reject(new TypeError("connect ECONNREFUSED"))) as FetchFn,
    );

    const client = new WmataClient("k");
    let caught: unknown = null;
    try {
      await client.get("https://example.com/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WmataError);
    expect((caught as WmataError).message).toBe(
      "Could not connect to the WMATA API. Check your internet connection.",
    );
  });
});

// ---------------------------------------------------------------------------
// Abort / timeout
// ---------------------------------------------------------------------------

describe("WmataClient.get timeout via AbortController", () => {
  it("converts an AbortError DOMException into the timeout message", async () => {
    // We don't need real timers here — we just need fetch to reject with
    // an AbortError, which is what `controller.abort()` would cause real
    // fetch to do. Simulating it directly mirrors the runtime behaviour
    // without depending on the setTimeout firing in a fake-timer pump.
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.reject(
          new DOMException("The operation was aborted.", "AbortError"),
        )) as FetchFn,
    );

    const client = new WmataClient("k");
    let caught: unknown = null;
    try {
      await client.get("https://example.com/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WmataError);
    expect((caught as WmataError).message).toBe(
      "Request timed out. The WMATA API may be slow — try again.",
    );
  });

  it("fires the abort when the timeout elapses (fake-timer drive)", async () => {
    vi.useFakeTimers();

    // Build a fetch that resolves only when its signal aborts.
    let abortListenerAttached = false;
    const fakeFetch: FetchFn = (_url, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => {
          reject(
            new DOMException("The operation was aborted.", "AbortError"),
          );
        };
        if (signal) {
          signal.addEventListener("abort", onAbort);
          abortListenerAttached = true;
        }
      });
    };
    vi.stubGlobal("fetch", fakeFetch);

    const client = new WmataClient("k");
    // Attach a rejection handler eagerly so we never have an
    // unhandled-rejection window while the fake clock advances.
    const settled: { ok: boolean; err: unknown } = { ok: false, err: null };
    const tracked = client.get("https://example.com/x").then(
      () => {
        settled.ok = true;
      },
      (err) => {
        settled.err = err;
      },
    );

    // Advance past the 15s TIMEOUT_MS. The setTimeout's callback fires
    // controller.abort(), which fires our `abort` event, which rejects
    // the fetch promise with an AbortError, which the client translates
    // into the timeout WmataError.
    await vi.advanceTimersByTimeAsync(20_000);
    await tracked;

    expect(abortListenerAttached).toBe(true);
    expect(settled.ok).toBe(false);
    expect(settled.err).toBeInstanceOf(WmataError);
    expect((settled.err as WmataError).message).toBe(
      "Request timed out. The WMATA API may be slow — try again.",
    );
  });
});

// ---------------------------------------------------------------------------
// Non-JSON 200
// ---------------------------------------------------------------------------

describe("WmataClient.get non-JSON 200 body", () => {
  it("throws the canonical 'non-JSON response' WmataError", async () => {
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(
          makeResponse({ status: 200, body: "<html>oops</html>" }),
        )) as FetchFn,
    );

    const client = new WmataClient("k");
    await expect(client.get("https://example.com/x")).rejects.toThrow(
      "WMATA API returned non-JSON response.",
    );
  });
});

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe("WmataClient.validate", () => {
  it("returns true when the upstream returns HTTP 200", async () => {
    let capturedUrl = "";
    const fakeFetch: FetchFn = (url, _init) => {
      capturedUrl = String(url);
      return Promise.resolve(makeResponse({ status: 200, body: "" }));
    };
    vi.stubGlobal("fetch", fakeFetch);

    const client = new WmataClient("good-key");
    const ok = await client.validate();
    expect(ok).toBe(true);
    // Sanity: it actually hits the VALIDATE endpoint.
    expect(capturedUrl).toBe(VALIDATE);
  });

  it("returns false on HTTP 401 without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(makeResponse({ status: 401, body: "" }))) as FetchFn,
    );

    const client = new WmataClient("bad-key");
    const ok = await client.validate();
    expect(ok).toBe(false);
  });

  it("returns false on a network-layer throw without re-throwing", async () => {
    vi.stubGlobal(
      "fetch",
      (() => Promise.reject(new TypeError("network down"))) as FetchFn,
    );

    const client = new WmataClient("k");
    const ok = await client.validate();
    expect(ok).toBe(false);
  });
});
