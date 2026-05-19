# WMATA G2

Real-time DC Metro transit information on the
[Even Realities G2](https://www.evenrealities.com/g2) smart glasses, driven
through the Even Realities companion phone app. Shows next-train predictions,
service alerts, and a voice-lookup affordance for any WMATA rail station.

## Prerequisites

- **Node 20 LTS or 22+** (`node --version`)
- An **Even Realities G2** paired with the
  [Even Realities phone app](https://www.evenrealities.com/app)
- A free **WMATA developer API key** — sign up at
  [developer.wmata.com](https://developer.wmata.com) and create a key with
  the "Default Tier" subscription. The key is stored only in the phone
  app's `localStorage`; it never leaves the device.

## Setup

```bash
npm install
npm run dev        # Vite dev server on :5173 (LAN-bound for QR access)
npm run simulate   # render in the desktop simulator
```

Both `npm run dev` and `npm run simulate` serve two pages:

- `/index.html` — the production entry. Renders the companion
  settings UI on the phone, then hands off to the glasses HUD when
  the SDK bridge is available.
- `/preview.html` — a browser-only **screens gallery** that renders
  every glasses screen state through its real `view()` function.
  No SDK bridge required; works in any desktop browser. Useful for
  reviewing layout drift, capturing screenshots, and demoing the
  app without hardware.

The desktop simulator (`evenhub-simulator`) works out-of-the-box on macOS
and Windows. On Linux it requires `webkit2gtk` (`apt install
libwebkit2gtk-4.1-0` or your distro's equivalent).

## First-launch flow

1. Open the Even Realities phone app and launch the WMATA G2 sideload.
2. The companion settings UI renders on the phone (the glasses stay off):
   - Enter your WMATA API key, click **Validate**. A green check confirms
     WMATA accepted the key.
   - Use the station search to add up to **5 favorites**. Each favorite
     shows its served lines as colored glyphs.
3. Click **"Done — launch on glasses"**. The page reloads and the glasses
   mount the Home screen.

To change favorites later, clear `localStorage` in the phone app's
WebView (or just re-launch with an empty key) — the companion UI re-renders.

## Glasses UX

Touchpad gestures (consistent across every screen):

| Gesture       | Meaning                       |
|---------------|-------------------------------|
| `SCROLL`      | Navigate a list / cycle a selection |
| `TAP`         | Select / commit               |
| `DOUBLE_TAP`  | Back to Home (or exit from Home) |

Auto-refresh cadences:

- **Predictions:** every 20 s
- **Incidents / ALERTS count:** every 60 s (shared cache between Home
  and the Incidents screen)
- **Wall clock + stale markers:** every 1 s, decoupled from fetches so
  the HUD stays alive even when WMATA is slow.

A `*` after the clock means the data is stale (older than threshold);
a `?` means an active fetch error and no fresh data on hand.

## Wiring an STT provider for Voice

The Voice screen ships with a fully-tested reducer + view, but
**`createSttEngine` in `src/screens/voice.ts` intentionally throws**.
The next developer to ship Voice on real hardware must:

1. Pick a streaming STT provider — cloud (Whisper / Deepgram /
   AssemblyAI) or on-device (whisper.cpp via WASM).
2. Implement the `SttEngine` interface (also in `voice.ts`). The
   `MockSttEngine` exported from the test suite is a working reference
   for the callback contract (`onTranscript` / `onSilence` / `onError`).
3. Buffer PCM frames arriving via the SDK's `event.audioEvent.audioPcm`
   (`Uint8Array`, 16-bit mono, 16 kHz) and forward them to your
   provider. The Voice screen's `onMount` already calls
   `bridge.audioControl(true)`; you just need to subscribe to
   `bridge.onEvenHubEvent` and feed `audioPcm` into your stream.
4. Replace the `throw` in `createSttEngine` with a real factory
   returning your `SttEngine` instance.

Until then the router catches the throw and bounces the user back to
Home, so the rest of the app stays usable.

## Development

```bash
npm test           # Vitest (pure-view + reducer + cache unit tests)
npm run build      # tsc --noEmit && vite build
npm run pack       # produce a sideload .ehpk bundle for the device
npm run simulate   # desktop simulator
```

Layout constraints: **24 columns × 7 usable rows**. The helpers in
`src/ui/render.ts` (`truncate`, `padRight`, `scrollWindowWithMarkers`,
…) and the Vitest suite enforce that every rendered line fits.

## Status

| Feature                | State                                         |
|------------------------|-----------------------------------------------|
| Predictions screen     | Production-ready                              |
| Incidents / ALERTS     | Production-ready                              |
| Home screen            | Production-ready                              |
| Companion settings UI  | Production-ready                              |
| Voice lookup           | Reducer & view shipped; STT provider must be wired in |
