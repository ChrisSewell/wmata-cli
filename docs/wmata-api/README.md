# WMATA API Reference

Comprehensive documentation for the Washington Metropolitan Area Transit Authority (WMATA) developer API.

**Portal**: <https://developer.wmata.com>
**Support**: <api-support@wmata.com> | **GTFS support**: <gtfs-support@wmata.com>

---

## Authentication

Every endpoint requires an API key. The key can be supplied in one of two ways:

| Method | Details |
|---|---|
| **Header** (recommended) | `api_key: YOUR_KEY` |
| **Query string** | `?api_key=YOUR_KEY` |

### Obtaining a Key

1. Create a free account at <https://developer.wmata.com>.
2. Subscribe to the **Default Tier** (free).
3. Find your primary/secondary key in your **Profile**.

A public demo key is available for quick testing: `e13626d03d8e4c03ac07f95541b3091b`

### Rate Limits (Default Tier)

| Limit | Value |
|---|---|
| Calls per second | 10 |
| Calls per day | 50,000 |

---

## Response Formats

Most REST families expose every operation in **both JSON and XML**. The JSON variant is accessed via a `/json/` prefix in the path (e.g., `/json/jRoutes` vs `/Routes`). GTFS feeds use **Protocol Buffers** (`.pb`).

All date/time values are in **Eastern Standard Time** formatted as `YYYY-MM-DDTHH:mm:ss` unless stated otherwise.

---

## API Families

| # | Family | Base URL | Description | Doc |
|---|---|---|---|---|
| 1 | Bus Route and Stop Methods | `https://api.wmata.com/Bus.svc` | Bus stops, routes, schedules, positions | [bus-route-and-stop-methods.md](bus-route-and-stop-methods.md) |
| 2 | GTFS | `https://api.wmata.com/gtfs` | Static and real-time GTFS/GTFS-RT feeds | [gtfs.md](gtfs.md) |
| 3 | Incidents | `https://api.wmata.com/Incidents.svc` | Rail, bus, elevator/escalator disruptions | [incidents.md](incidents.md) |
| 4 | Misc Methods | `https://api.wmata.com/Misc` | Simple utility methods (key validation) | [misc-methods.md](misc-methods.md) |
| 5 | Rail Station Information | `https://api.wmata.com/Rail.svc` | Lines, stations, fares, parking, timings | [rail-station-information.md](rail-station-information.md) |
| 6 | Real-Time Bus Predictions | `https://api.wmata.com/NextBusService.svc` | Next bus arrival predictions | [real-time-bus-predictions.md](real-time-bus-predictions.md) |
| 7 | Real-Time Rail Predictions | `https://api.wmata.com/StationPrediction.svc` | Next train arrival predictions | [real-time-rail-predictions.md](real-time-rail-predictions.md) |
| 8 | Train Positions | `https://api.wmata.com/TrainPositions` | Live train positions, track circuits, routes | [train-positions.md](train-positions.md) |

---

## Line Codes

Used across rail-related APIs:

| Code | Line |
|---|---|
| `RD` | Red |
| `BL` | Blue |
| `YL` | Yellow |
| `OR` | Orange |
| `GR` | Green |
| `SV` | Silver |

---

## Common Conventions

- **Station codes** are two-character alphanumeric identifiers (e.g., `A01` for Metro Center). Retrieve them via the Rail Station Information > Station List endpoint.
- **Route IDs** always refer to the *base* route name (e.g., `10A` not `10Av1`). Variants are used only in schedule/path-detail endpoints.
- **Stop IDs** are 7-digit regional identifiers.
- **Deprecated fields** are noted per-endpoint. They remain in responses but should not be relied upon for new integrations.
