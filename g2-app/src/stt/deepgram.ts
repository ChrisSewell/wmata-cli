// Deepgram streaming STT engine.
//
// Implements the `SttEngine` interface from `../screens/voice.ts` against
// Deepgram's `/v1/listen` streaming WebSocket. The Even Realities SDK
// surfaces raw 16-bit signed PCM, 16 kHz, mono frames via
// `bridge.onEvenHubEvent` (`event.audioEvent.audioPcm: Uint8Array`); the
// Voice screen's `onMount` is responsible for piping those frames into
// `engine.write(pcm)`. This module is therefore audio-source-agnostic —
// it speaks the WebSocket protocol and nothing else.
//
// Authentication
//   Browser WebSockets cannot set arbitrary HTTP headers, so Deepgram's
//   documented browser-friendly authentication is the
//   `Sec-WebSocket-Protocol` token pattern:
//
//     new WebSocket(url, ["token", apiKey])
//
//   See https://developers.deepgram.com/docs/authenticating#protocol
//   ("WebSocket Authentication" section). The server inspects the
//   sub-protocol header and treats the second value as the bearer token.
//
// Message handling
//   The wire protocol is JSON-over-text frames going server -> client and
//   binary PCM frames going client -> server. We handle the documented
//   message types:
//     - `Results`        — partial or final transcript chunks. Fire
//                          `onTranscript(text, isFinal)`. If
//                          `speech_final === true` we also fire
//                          `onSilence()` so the screen's resolve flow
//                          kicks in on a natural utterance boundary.
//     - `UtteranceEnd`   — VAD-driven end-of-utterance signal. Alias
//                          for `onSilence()`.
//     - `Error`          — surface the description via `onError`.
//     - `Metadata` /
//       `SpeechStarted`  — informational; logged at debug only.
//     - anything else    — silently ignored (forward-compat).
//
// Lifecycle
//   - `start(callbacks)` opens the WebSocket and returns `{ write, close }`.
//   - `write(pcm)` forwards binary frames when the socket is open; pre-open
//     frames are buffered in a small ring (max 50 frames) so the first few
//     hundred ms of audio aren't lost during the TLS handshake. Post-close
//     writes are silent no-ops.
//   - `close()` sends `{ type: 'CloseStream' }` so Deepgram flushes any
//     last partial into a final transcript, then closes the socket. A
//     "deliberate close" flag stops the `onclose` handler from misfiring
//     `onError`.

import type { SttEngine } from "../screens/voice";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Deepgram model used by default. */
const DEFAULT_MODEL = "nova-3";

/** Default endpointing window in ms. */
const DEFAULT_ENDPOINTING_MS = 300;

/** Cap on the pre-open PCM frame buffer. Prevents OOM on a hung connect. */
const MAX_PREOPEN_BUFFER_FRAMES = 50;

/** Deepgram streaming endpoint. */
const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";

// ---------------------------------------------------------------------------
// Options + types
// ---------------------------------------------------------------------------

export interface DeepgramSttOptions {
  /** Deepgram model, default `nova-3`. */
  model?: string;
  /** Endpointing pause length in ms, default 300. */
  endpointingMs?: number;
}

/**
 * Subset of message shapes the engine reacts to. We type the relevant
 * fields and tolerate anything else (the engine no-ops on unknown types
 * for forward-compat).
 */
interface DeepgramResultsMessage {
  type: "Results";
  channel?: {
    alternatives?: Array<{ transcript?: unknown }>;
  };
  is_final?: unknown;
  speech_final?: unknown;
}

interface DeepgramErrorMessage {
  type: "Error";
  description?: unknown;
  message?: unknown;
}

interface DeepgramUtteranceEndMessage {
  type: "UtteranceEnd";
}

// ---------------------------------------------------------------------------
// Type guards (operate on `unknown`, never `any`)
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function asString(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

function asBool(x: unknown): boolean {
  return x === true;
}

function isResults(x: unknown): x is DeepgramResultsMessage {
  return isRecord(x) && x["type"] === "Results";
}

function isUtteranceEnd(x: unknown): x is DeepgramUtteranceEndMessage {
  return isRecord(x) && x["type"] === "UtteranceEnd";
}

function isErrorMessage(x: unknown): x is DeepgramErrorMessage {
  return isRecord(x) && x["type"] === "Error";
}

/** Extract the best-alternative transcript from a Results message. */
function extractTranscript(msg: DeepgramResultsMessage): string {
  const alts = msg.channel?.alternatives;
  if (!Array.isArray(alts) || alts.length === 0) return "";
  const first = alts[0];
  if (!isRecord(first)) return "";
  return asString(first["transcript"]) ?? "";
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/**
 * Build the streaming endpoint URL with `URLSearchParams`. The audio
 * format flags are hard-coded to match the G2 wire format: 16-bit
 * signed PCM (`linear16`), 16 kHz, mono. `interim_results=true` gets us
 * partial transcripts; `vad_events=true` + `utterance_end_ms=1000` give
 * us a VAD-driven end-of-utterance signal independent of the speech
 * stream's own `speech_final`.
 */
export function buildDeepgramUrl(
  model: string,
  endpointingMs: number,
): string {
  const params = new URLSearchParams({
    model,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    endpointing: String(endpointingMs),
    vad_events: "true",
    utterance_end_ms: "1000",
  });
  return `${DEEPGRAM_LISTEN_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class DeepgramSttEngine implements SttEngine {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpointingMs: number;

  constructor(apiKey: string, options?: DeepgramSttOptions) {
    this.apiKey = apiKey;
    this.model = options?.model ?? DEFAULT_MODEL;
    this.endpointingMs = options?.endpointingMs ?? DEFAULT_ENDPOINTING_MS;
  }

  start(callbacks: {
    onTranscript: (text: string, isFinal: boolean) => void;
    onSilence: () => void;
    onError: (err: Error) => void;
  }): { write(pcm: Uint8Array): void; close(): void } {
    const url = buildDeepgramUrl(this.model, this.endpointingMs);

    // Browser WebSockets can't set HTTP headers; the documented
    // Deepgram pattern is the `Sec-WebSocket-Protocol` token form.
    // See https://developers.deepgram.com/docs/authenticating#protocol
    const ws = new WebSocket(url, ["token", this.apiKey]);

    // Send PCM frames as binary. The default is "blob" which would
    // change how `ws.send(Uint8Array)` materializes on some hosts;
    // pinning to "arraybuffer" keeps behavior consistent.
    ws.binaryType = "arraybuffer";

    /** True once the socket has opened. */
    let isOpen = false;
    /** True after `close()` so `onclose` can skip the error path. */
    let deliberateClose = false;
    /** True if any terminal callback has been delivered (close / error). */
    let terminated = false;

    /** Pre-open PCM buffer; flushed on `onopen`. Capped to bound memory. */
    const preopenBuffer: Uint8Array[] = [];

    const fireError = (err: Error): void => {
      if (terminated) return;
      terminated = true;
      callbacks.onError(err);
    };

    ws.onopen = (): void => {
      isOpen = true;
      // Flush any frames buffered during the TLS handshake. We send
      // in FIFO order so the audio chronology is preserved.
      for (const frame of preopenBuffer) {
        try {
          ws.send(frame);
        } catch (err) {
          console.warn("[deepgram] send during flush failed:", err);
        }
      }
      preopenBuffer.length = 0;
    };

    ws.onmessage = (ev: MessageEvent): void => {
      // Deepgram emits JSON-over-text frames for control / transcript
      // messages. Binary frames are not expected from the server side
      // of the listen endpoint, so we narrow on `string` and skip
      // anything else.
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch (err) {
        console.warn("[deepgram] malformed JSON message:", err);
        return;
      }

      if (isResults(parsed)) {
        const transcript = extractTranscript(parsed);
        const isFinal = asBool(parsed.is_final);
        // Contract: never fire onTranscript("") — keep the screen
        // clean. Deepgram emits empty-transcript Results periodically
        // while VAD detects speech but no decode is ready yet; those
        // would otherwise blink the listening cue.
        if (transcript.length > 0) {
          callbacks.onTranscript(transcript, isFinal);
        }
        if (asBool(parsed.speech_final)) {
          callbacks.onSilence();
        }
        return;
      }

      if (isUtteranceEnd(parsed)) {
        callbacks.onSilence();
        return;
      }

      if (isErrorMessage(parsed)) {
        const description =
          asString(parsed.description) ??
          asString(parsed.message) ??
          "Deepgram error";
        fireError(new Error(description));
        return;
      }

      // Unknown message types (Metadata, SpeechStarted, future types)
      // are intentionally ignored. Log at debug for forward-compat
      // diagnostics without spamming the console.
      if (isRecord(parsed) && typeof parsed["type"] === "string") {
        console.debug(`[deepgram] ignoring message type=${parsed["type"]}`);
      }
    };

    ws.onerror = (): void => {
      // The browser `Event` here carries no useful description.
      fireError(new Error("WebSocket error"));
    };

    ws.onclose = (): void => {
      isOpen = false;
      if (!deliberateClose) {
        fireError(new Error("WebSocket closed unexpectedly"));
      }
    };

    return {
      write: (pcm: Uint8Array): void => {
        // Three states: open / connecting / closed. Open sends
        // immediately; connecting buffers (with a cap); closed is a
        // silent no-op so a late frame after `close()` doesn't throw.
        if (ws.readyState === WebSocket.OPEN || isOpen) {
          try {
            ws.send(pcm);
          } catch (err) {
            console.warn("[deepgram] ws.send failed:", err);
          }
          return;
        }
        if (ws.readyState === WebSocket.CONNECTING) {
          if (preopenBuffer.length >= MAX_PREOPEN_BUFFER_FRAMES) {
            // Drop oldest to bound memory. Realistically this only
            // happens if the connect is hung; the user will get an
            // error very soon either way.
            preopenBuffer.shift();
            console.warn(
              "[deepgram] pre-open PCM buffer full, dropping oldest frame",
            );
          }
          preopenBuffer.push(pcm);
          return;
        }
        // CLOSING / CLOSED: nothing to do.
      },
      close: (): void => {
        deliberateClose = true;
        // Tell Deepgram to flush its decoder so we get any final
        // transcript before the socket goes away. Only meaningful
        // while the socket is open or connecting; send is a no-op
        // otherwise.
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          try {
            ws.send(JSON.stringify({ type: "CloseStream" }));
          } catch (err) {
            console.warn("[deepgram] CloseStream send failed:", err);
          }
        }
        try {
          ws.close();
        } catch (err) {
          console.warn("[deepgram] ws.close threw:", err);
        }
      },
    };
  }
}
