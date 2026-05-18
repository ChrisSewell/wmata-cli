// Unit tests for `DeepgramSttEngine`.
//
// We mock the global `WebSocket` constructor with a tiny stub that
// records its construction args (URL + protocols) and exposes manual
// triggers for `onopen` / `onmessage` / `onerror` / `onclose`. This lets
// us drive every wire-level edge case without hitting Deepgram's servers.
//
// The 13 acceptance cases below are listed in the work-package; each
// has a matching `it(...)` block.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepgramSttEngine, buildDeepgramUrl } from "./deepgram";

// ---------------------------------------------------------------------------
// MockWebSocket — captures constructor args and exposes manual triggers
// ---------------------------------------------------------------------------

interface MockSocketConstructorCall {
  url: string;
  protocols: string | string[] | undefined;
}

class MockWebSocket {
  // Mirror the standard WebSocket readyState enum so production code's
  // `ws.readyState === WebSocket.OPEN` comparisons line up.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  /** Every MockWebSocket built during a single test. */
  static instances: MockWebSocket[] = [];
  /** Constructor-arg log. */
  static calls: MockSocketConstructorCall[] = [];

  readyState: number = MockWebSocket.CONNECTING;
  binaryType: string = "blob";
  sent: Array<string | Uint8Array | ArrayBuffer> = [];

  // Note: we type these against the standard DOM signatures but pass
  // plain `Event` instances in the triggers below — `CloseEvent` isn't
  // available in the Node test environment, and production code only
  // reads the readyState / no event fields, so a plain Event is fine.
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    MockWebSocket.calls.push({ url, protocols });
    MockWebSocket.instances.push(this);
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    // Note: we do NOT auto-fire onclose. Tests drive that explicitly
    // via `triggerClose()` so we can assert "expected vs. unexpected"
    // semantics without timing flakiness.
  }

  // ----- manual drivers (for tests) -----
  triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  triggerMessage(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  triggerError(): void {
    this.onerror?.(new Event("error"));
  }
  triggerClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new Event("close"));
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  MockWebSocket.calls = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build an engine + start it with no-op callbacks; return the active socket. */
function startEngine(opts?: {
  apiKey?: string;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onSilence?: () => void;
  onError?: (err: Error) => void;
}): {
  socket: MockWebSocket;
  pipe: { write(pcm: Uint8Array): void; close(): void };
} {
  const engine = new DeepgramSttEngine(opts?.apiKey ?? "test-key");
  const pipe = engine.start({
    onTranscript: opts?.onTranscript ?? (() => {}),
    onSilence: opts?.onSilence ?? (() => {}),
    onError: opts?.onError ?? (() => {}),
  });
  const socket = MockWebSocket.instances[0];
  if (!socket) throw new Error("no WebSocket constructed");
  return { socket, pipe };
}

// ---------------------------------------------------------------------------
// 1. Construction passes the right URL + protocol
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine construction", () => {
  it("passes the right URL + protocol to the WebSocket constructor", () => {
    const engine = new DeepgramSttEngine("my-secret-key");
    engine.start({
      onTranscript: () => {},
      onSilence: () => {},
      onError: () => {},
    });
    expect(MockWebSocket.calls.length).toBe(1);
    const call = MockWebSocket.calls[0]!;
    // URL flags
    expect(call.url).toContain("wss://api.deepgram.com/v1/listen");
    expect(call.url).toContain("model=nova-3");
    expect(call.url).toContain("encoding=linear16");
    expect(call.url).toContain("sample_rate=16000");
    expect(call.url).toContain("channels=1");
    expect(call.url).toContain("interim_results=true");
    expect(call.url).toContain("endpointing=300");
    expect(call.url).toContain("vad_events=true");
    expect(call.url).toContain("utterance_end_ms=1000");
    // Auth via Sec-WebSocket-Protocol (browser-safe pattern)
    expect(call.protocols).toEqual(["token", "my-secret-key"]);
  });

  it("buildDeepgramUrl honors custom model + endpointing", () => {
    const url = buildDeepgramUrl("nova-2-general", 500);
    expect(url).toContain("model=nova-2-general");
    expect(url).toContain("endpointing=500");
  });
});

// ---------------------------------------------------------------------------
// 2-3. Results message → onTranscript (partial / final)
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine Results handling", () => {
  it("fires onTranscript(text, false) for an is_final=false Results message", () => {
    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    const { socket } = startEngine({
      onTranscript: (text, isFinal) => transcripts.push({ text, isFinal }),
    });
    socket.triggerOpen();
    socket.triggerMessage(
      JSON.stringify({
        type: "Results",
        channel: { alternatives: [{ transcript: "metro" }] },
        is_final: false,
        speech_final: false,
      }),
    );
    expect(transcripts).toEqual([{ text: "metro", isFinal: false }]);
  });

  it("fires onTranscript(text, true) for an is_final=true Results message", () => {
    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    const { socket } = startEngine({
      onTranscript: (text, isFinal) => transcripts.push({ text, isFinal }),
    });
    socket.triggerOpen();
    socket.triggerMessage(
      JSON.stringify({
        type: "Results",
        channel: { alternatives: [{ transcript: "metro center" }] },
        is_final: true,
        speech_final: false,
      }),
    );
    expect(transcripts).toEqual([{ text: "metro center", isFinal: true }]);
  });
});

// ---------------------------------------------------------------------------
// 4. Results with speech_final=true → onSilence
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine speech_final → onSilence", () => {
  it("fires onSilence when a Results message has speech_final=true", () => {
    let silenceCount = 0;
    const { socket } = startEngine({
      onSilence: () => {
        silenceCount += 1;
      },
    });
    socket.triggerOpen();
    socket.triggerMessage(
      JSON.stringify({
        type: "Results",
        channel: { alternatives: [{ transcript: "metro center" }] },
        is_final: true,
        speech_final: true,
      }),
    );
    expect(silenceCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. UtteranceEnd → onSilence
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine UtteranceEnd → onSilence", () => {
  it("fires onSilence on an UtteranceEnd message", () => {
    let silenceCount = 0;
    const { socket } = startEngine({
      onSilence: () => {
        silenceCount += 1;
      },
    });
    socket.triggerOpen();
    socket.triggerMessage(JSON.stringify({ type: "UtteranceEnd" }));
    expect(silenceCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Error message → onError(description)
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine Error message", () => {
  it("forwards the description as onError", () => {
    const errors: Error[] = [];
    const { socket } = startEngine({
      onError: (err) => errors.push(err),
    });
    socket.triggerOpen();
    socket.triggerMessage(
      JSON.stringify({ type: "Error", description: "auth failed" }),
    );
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toBe("auth failed");
  });
});

// ---------------------------------------------------------------------------
// 7. onerror event → onError
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine onerror event", () => {
  it("fires onError on a WebSocket error", () => {
    const errors: Error[] = [];
    const { socket } = startEngine({
      onError: (err) => errors.push(err),
    });
    socket.triggerError();
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain("WebSocket");
  });
});

// ---------------------------------------------------------------------------
// 8. Unexpected onclose → onError
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine unexpected close", () => {
  it("fires onError when the socket closes without a preceding pipe.close()", () => {
    const errors: Error[] = [];
    const { socket } = startEngine({
      onError: (err) => errors.push(err),
    });
    socket.triggerOpen();
    socket.triggerClose();
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toBe("WebSocket closed unexpectedly");
  });
});

// ---------------------------------------------------------------------------
// 9. Expected onclose after close() → no onError
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine expected close", () => {
  it("does NOT fire onError when the close was deliberate", () => {
    const errors: Error[] = [];
    const { socket, pipe } = startEngine({
      onError: (err) => errors.push(err),
    });
    socket.triggerOpen();
    pipe.close();
    socket.triggerClose();
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. write(pcm) before WS open → buffered, flushed on onopen
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine pre-open buffering", () => {
  it("buffers pre-open writes and flushes them in FIFO order on onopen", () => {
    const { socket, pipe } = startEngine();
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4]);
    pipe.write(a);
    pipe.write(b);
    // Nothing sent while CONNECTING.
    expect(socket.sent.length).toBe(0);
    socket.triggerOpen();
    expect(socket.sent.length).toBe(2);
    expect(socket.sent[0]).toBe(a);
    expect(socket.sent[1]).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 11. write(pcm) after open → forwarded immediately
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine post-open writes", () => {
  it("forwards writes to ws.send when the socket is OPEN", () => {
    const { socket, pipe } = startEngine();
    socket.triggerOpen();
    const a = new Uint8Array([1, 2, 3]);
    pipe.write(a);
    expect(socket.sent.length).toBe(1);
    expect(socket.sent[0]).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// 12. close() sends CloseStream then closes
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine close() flow", () => {
  it("sends {type:'CloseStream'} then closes the socket", () => {
    const { socket, pipe } = startEngine();
    socket.triggerOpen();
    pipe.close();
    // The last sent frame should be the CloseStream JSON.
    expect(socket.sent.length).toBe(1);
    expect(socket.sent[0]).toBe(JSON.stringify({ type: "CloseStream" }));
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });
});

// ---------------------------------------------------------------------------
// 13. Empty transcript in Results → NO onTranscript fired
// ---------------------------------------------------------------------------

describe("DeepgramSttEngine empty-transcript contract", () => {
  it("does NOT fire onTranscript('') when Deepgram emits an empty transcript", () => {
    const transcripts: string[] = [];
    const { socket } = startEngine({
      onTranscript: (text) => transcripts.push(text),
    });
    socket.triggerOpen();
    socket.triggerMessage(
      JSON.stringify({
        type: "Results",
        channel: { alternatives: [{ transcript: "" }] },
        is_final: false,
        speech_final: false,
      }),
    );
    // Also: a "Results" with no alternatives at all should be ignored.
    socket.triggerMessage(
      JSON.stringify({
        type: "Results",
        channel: { alternatives: [] },
        is_final: false,
        speech_final: false,
      }),
    );
    expect(transcripts.length).toBe(0);
  });
});
