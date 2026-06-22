# WMATA Transit — Even Realities G2

Real-time DC Metro on the [Even Realities G2](https://www.evenrealities.com/g2)
smart glasses, driven through the Even Realities companion phone app. A
glanceable transit HUD: a favorites board with live next-train ETAs, a
per-station departure board, and service alerts (rail incidents + elevator /
escalator outages).

**v0.2 is a ground-up rebuild** on the "House" G2 design language
(`~/g2-design-principles`): every screen is built from native firmware
containers, all text is laid out with **pixel-accurate measurement**
(`@evenrealities/pretext`) — never character counting or space-padding — and
value columns align by *position*. No fake monospace grid, no overflow-scroll
lists.

## Prerequisites

- **Node 20 LTS or 22+** (`node --version`)
- An **Even Realities G2** paired with the
  [Even Realities phone app](https://www.evenrealities.com/app)
- A free **WMATA developer API key** — sign up at
  [developer.wmata.com](https://developer.wmata.com) and subscribe to the free
  "Default Tier". The key is stored only on the device (localStorage, mirrored
  to the Even Hub durable store); it never leaves the phone.

## Setup

```bash
npm install
npm run dev        # Vite dev server on :5273 (LAN-bound for QR access)
npm run qr         # QR code to sideload the dev server onto the glasses
npm run simulate   # desktop simulator pointed at the dev server
```

Two entry points are served:

- **`/index.html`** — the production entry. Mounts the companion settings UI on
  the phone and boots the glasses HUD: it shows a "finish setup" placeholder
  until an API key + a favorite are saved, then auto-swaps to the live Home
  screen (no reload).
- **`/glasses-preview.html`** — a fixture-driven harness that boots the real
  glasses host + screens against deterministic data (no network), for
  simulator review without hardware or a key. `?screen=unconfigured` mounts
  that state first.

## First-launch flow

1. Open the WMATA Transit sideload in the Even Realities phone app.
2. On the phone: enter your WMATA API key and click **Validate** (a green check
   confirms WMATA accepted it), then search and pin up to **5 favorite
   stations**.
3. The glasses swap from "finish setup" to the live Home board automatically.

## Glasses UX

Four gestures, consistent everywhere (temple touchpad / R1 ring):

| Gesture       | Meaning                                   |
|---------------|-------------------------------------------|
| Swipe up/down | Move the cursor / page                    |
| Single press  | Open the focused item (or back on a board)|
| Double press  | Back — at the root (Home), exit the app   |

Screens:

- **Home** — favorites board: each station with its soonest next-train ETA in
  an aligned value column, plus a "Service alerts" row. Press a favorite →
  Predictions; press alerts → Alerts.
- **Predictions** — per-station departure board, trains sorted soonest-first,
  20s auto-refresh, staleness marker + loading/empty/error states.
- **Alerts** — rail incidents + elevator/escalator outages in one selectable
  list; press a row → the full text, paginated.

A `*` / `**` / `?` marker by the clock signals increasingly stale data.

## Architecture

The SDK is touched in exactly one layer (`host/`); everything below is pure and
unit-tested.

```
src/
  data/        WMATA client (+429 backoff) · session caches · domain logic (eta, lines, alerts, staleness)
  ui/          tokens · geometry · pretext measurement · layout (value column, pagination)
  screens/     pure Screen<S> contract: init/view/reduce; one file per screen
  nav/         gesture-hint affordances
  host/        the only SDK consumer — compose (content) + glasses-host (containers, events, lifecycle) + serial + main (boot)
  companion/   phone settings UI (API key + favorites)
  storage/     durable localStorage <-> Even Hub bridge mirror
  preview/     fixture-driven verification harness
```

## Development

```bash
npm test           # Vitest — pure data/ui/screen logic (95+ tests)
npm run build      # tsc --noEmit && vite build
npm run pack       # build + bundle dist/ -> wmata-transit.ehpk
npm run simulate   # desktop simulator
npm run sim:drive  # drive a running simulator's automation API (shot/input/console/ready)
npm run verify:sim # wait for the preview harness to be ready in the simulator
```

### Simulator review loop

The simulator renders the **real** SDK containers, so it's the highest-fidelity
check short of hardware. With the dev server running:

```bash
npm run simulate &                      # or: evenhub-simulator http://localhost:5273/glasses-preview.html --automation-port 9898
node scripts/sim.mjs ready              # wait for the harness
node scripts/sim.mjs input down|click|double_click
node scripts/sim.mjs shot <name>        # save .sim-shots/<name>.png
```

The sim is not pixel-perfect for greyscale vs hardware — use it for
layout/copy/event logic; do final visual QA on-device.

## Status

| Feature                         | State              |
|---------------------------------|--------------------|
| Home favorites board            | Production-ready   |
| Predictions board               | Production-ready   |
| Service alerts + detail         | Production-ready   |
| Elevator / escalator outages    | Folded into Alerts |
| Companion settings (key + favs) | Production-ready   |
| Durable settings (bridge mirror)| Production-ready   |

On-device validation pending: the live-data configured flow (real WMATA key) and
the 5-minute locked-phone state test require hardware / a real key.
