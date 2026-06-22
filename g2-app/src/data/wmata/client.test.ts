import { describe, it, expect, vi, afterEach } from "vitest";
import { WmataClient, WmataError } from "./client";

// Minimal Response-like stub: the client only touches status, ok,
// headers.get("Retry-After"), and text().
function res(opts: { status?: number; body?: string; retryAfter?: string | null }): Response {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => (k.toLowerCase() === "retry-after" ? (opts.retryAfter ?? null) : null),
    },
    text: async () => opts.body ?? "",
  } as unknown as Response;
}

/** Stub global fetch with a queue; an Error entry is thrown (network failure). */
function queueFetch(items: Array<Response | Error>) {
  const fn = vi.fn(async () => {
    const next = items.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("queue exhausted");
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("WmataClient.get", () => {
  it("returns parsed JSON on 200", async () => {
    const fn = queueFetch([res({ body: JSON.stringify({ Trains: [] }) })]);
    const data = await new WmataClient("k").get<{ Trains: unknown[] }>("https://api.wmata.com/x");
    expect(data).toEqual({ Trains: [] });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws WmataError on 401 without retrying", async () => {
    const fn = queueFetch([res({ status: 401 })]);
    await expect(new WmataClient("bad").get("https://api.wmata.com/x")).rejects.toBeInstanceOf(
      WmataError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws WmataError with the API message on 400", async () => {
    queueFetch([res({ status: 400, body: JSON.stringify({ Message: "bad code" }) })]);
    await expect(new WmataClient("k").get("https://api.wmata.com/x")).rejects.toThrow(/bad code/);
  });

  it("retries 429 (honoring Retry-After) then succeeds", async () => {
    const fn = queueFetch([
      res({ status: 429, retryAfter: "0" }),
      res({ body: JSON.stringify({ ok: true }) }),
    ]);
    const data = await new WmataClient("k").get<{ ok: boolean }>("https://api.wmata.com/x");
    expect(data).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_RETRIES on persistent 429", async () => {
    const fn = queueFetch([
      res({ status: 429, retryAfter: "0" }),
      res({ status: 429, retryAfter: "0" }),
      res({ status: 429, retryAfter: "0" }),
    ]);
    await expect(new WmataClient("k").get("https://api.wmata.com/x")).rejects.toBeInstanceOf(
      WmataError,
    );
    expect(fn).toHaveBeenCalledTimes(3); // 1 + MAX_RETRIES(2)
  });

  it("retries a network error then succeeds", async () => {
    const fn = queueFetch([new Error("ECONNRESET"), res({ body: JSON.stringify({ ok: 1 }) })]);
    const data = await new WmataClient("k").get<{ ok: number }>("https://api.wmata.com/x");
    expect(data).toEqual({ ok: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
