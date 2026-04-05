# Train Positions

**Base URL**: `https://api.wmata.com/TrainPositions`
**Description**: Real-time train positions and support methods.

These endpoints return JSON only (no XML variant). The `contentType` query parameter must be set to `json`.

[Back to index](README.md)

---

## Endpoints at a Glance

| Operation | Path |
|---|---|
| [Live Train Positions](#live-train-positions) | `/TrainPositions?contentType=json` |
| [Standard Routes](#standard-routes) | `/StandardRoutes?contentType=json` |
| [Track Circuits](#track-circuits) | `/TrackCircuits?contentType=json` |

---

## Live Train Positions

Returns uniquely identifiable trains in service and the track circuits they currently occupy. Returns an empty set when no positions are available.

### Request

```
GET /TrainPositions/TrainPositions?contentType=json
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `contentType` | query | **Yes** | string | Response format. Currently only `json` is supported. |

### Response Elements — `TrainPositions[]`

| Element | Type | Description |
|---|---|---|
| `TrainId` | string | Uniquely identifiable internal train identifier. |
| `TrainNumber` | string | Non-unique train number used by operations. |
| `CarCount` | integer | Number of cars on the train. |
| `DirectionNum` | integer | `1` = generally northbound/eastbound; `2` = generally southbound/westbound. |
| `CircuitId` | integer | Track circuit the train currently occupies. Cross-reference with Track Circuits and Standard Routes. |
| `DestinationStationCode` | string | Destination station code. May be `null` for non-revenue trains. |
| `LineCode` | string | Two-letter line abbreviation. May be `null` for non-revenue trains. |
| `SecondsAtLocation` | integer | Approximate seconds the train has been at the current circuit. |
| `ServiceType` | string | One of: `Normal`, `NoPassengers`, `Special`, `Unknown`. |

### ServiceType Values

| Value | Meaning |
|---|---|
| `Normal` | Regular revenue service. |
| `NoPassengers` | Train is not carrying passengers (deadheading, repositioning). |
| `Special` | Special/charter service. |
| `Unknown` | Service type could not be determined. |

### Example Request

```bash
curl -s "https://api.wmata.com/TrainPositions/TrainPositions?contentType=json" \
  -H "api_key: YOUR_KEY"
```

### Example Response (abbreviated)

```json
{
  "TrainPositions": [
    {
      "TrainId": "039",
      "TrainNumber": "302",
      "CarCount": 6,
      "DirectionNum": 1,
      "CircuitId": 1456,
      "DestinationStationCode": "B11",
      "LineCode": "RD",
      "SecondsAtLocation": 12,
      "ServiceType": "Normal"
    }
  ]
}
```

---

## Standard Routes

Returns an ordered list of mostly revenue (and some lead) track circuits, arranged by line and track number. This data changes infrequently and should be cached.

### Request

```
GET /TrainPositions/StandardRoutes?contentType=json
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `contentType` | query | **Yes** | string | Response format. Currently only `json`. |

### Response Elements — `StandardRoutes[]`

| Element | Type | Description |
|---|---|---|
| `LineCode` | string | Revenue line abbreviation (e.g., `RD`). |
| `TrackNum` | integer | Track number (1 or 2 for main revenue tracks). |
| `TrackCircuits[]` | array | Ordered track circuit objects. |

**TrackCircuits sub-elements:**

| Element | Type | Description |
|---|---|---|
| `CircuitId` | integer | Unique circuit identifier. |
| `SeqNum` | integer | Order in which the circuit appears for this line/track. |
| `StationCode` | string | Station code if this circuit is at a station; `null` otherwise. |

### Example Request

```bash
curl -s "https://api.wmata.com/TrainPositions/StandardRoutes?contentType=json" \
  -H "api_key: YOUR_KEY"
```

### Example Response (abbreviated)

```json
{
  "StandardRoutes": [
    {
      "LineCode": "RD",
      "TrackNum": 1,
      "TrackCircuits": [
        { "CircuitId": 1001, "SeqNum": 1, "StationCode": "A15" },
        { "CircuitId": 1002, "SeqNum": 2, "StationCode": null },
        { "CircuitId": 1003, "SeqNum": 3, "StationCode": "A14" }
      ]
    }
  ]
}
```

---

## Track Circuits

Returns all track circuits, including pocket tracks and crossovers. Each circuit may reference its left and right neighbors.

### Request

```
GET /TrainPositions/TrackCircuits?contentType=json
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `contentType` | query | **Yes** | string | Response format. Currently only `json`. |

### Response Elements — `TrackCircuits[]`

| Element | Type | Description |
|---|---|---|
| `CircuitId` | integer | Unique internal circuit identifier. |
| `Track` | integer | Track number. `1`/`2` = main revenue tracks; `0` = crossover; `3` = pocket track. |
| `Neighbors[]` | array | Neighboring circuit information. |

**Neighbors sub-elements:**

| Element | Type | Description |
|---|---|---|
| `NeighborType` | string | `Left` (generally west/south) or `Right` (generally east/north). |
| `CircuitIds` | array | Array of integer circuit IDs. Can have multiple neighbors in the same direction at switches. |

### Track Number Reference

| Track | Meaning |
|---|---|
| `1` | Main revenue track (one direction). |
| `2` | Main revenue track (opposite direction). |
| `0` | Crossover track (diagonal connector). |
| `3` | Pocket track (horizontal, off main line). |

### Example Request

```bash
curl -s "https://api.wmata.com/TrainPositions/TrackCircuits?contentType=json" \
  -H "api_key: YOUR_KEY"
```

### Example Response (abbreviated)

```json
{
  "TrackCircuits": [
    {
      "CircuitId": 1001,
      "Track": 1,
      "Neighbors": [
        { "NeighborType": "Left", "CircuitIds": [1000] },
        { "NeighborType": "Right", "CircuitIds": [1002] }
      ]
    }
  ]
}
```

---

## How to Map Train Positions to Stations

1. Call **Standard Routes** to get the ordered list of circuits per line/track, noting which circuits are at stations.
2. Call **Live Train Positions** to get each train's `CircuitId`.
3. Look up the `CircuitId` in the Standard Routes data. If the circuit has a `StationCode`, the train is at that station. Otherwise, find the nearest station circuits by `SeqNum`.

---

## Common Pitfalls

1. **`contentType=json` is required** — Omitting this parameter may return errors or unexpected formats.
2. **`TrainId` is ephemeral** — A `TrainId` is assigned when a train enters service and may be reused after the train goes out of service. Do not persist it across days.
3. **`TrainId` differs from radio identifiers** — The API `TrainId` is not the same as designations used in operations radio chatter.
4. **Circuit-to-location mapping is indirect** — Track circuits do not have lat/lon coordinates. Use Standard Routes to determine a circuit's position relative to stations, then interpolate between station coordinates from Rail Station Information.
5. **Trains at terminal stations may appear on the next circuit** — The occupancy detection system sometimes places a train at the front edge of a platform onto the adjacent circuit.
6. **Switches create multi-neighbor circuits** — At switches, a circuit can have two neighbors in the *same* direction. Handle both `CircuitIds` entries when traversing the graph.
7. **Track 0 and 3 are non-revenue** — Crossover (0) and pocket (3) tracks are used for train operations, not passenger service. Filter to tracks 1 and 2 for revenue-service visualization.
8. **Cache Standard Routes and Track Circuits** — This data changes very rarely. Cache it and refresh only periodically (e.g., daily or weekly).
