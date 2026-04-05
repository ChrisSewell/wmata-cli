# Rail Station Information

**Base URL**: `https://api.wmata.com/Rail.svc`
**Description**: Rail line and station information, including locations, fares, times, and parking.

All endpoints are `GET` requests available in both JSON and XML. JSON variants use a `/json/j` prefix (e.g., `/json/jLines`).

[Back to index](README.md)

---

## Endpoints at a Glance

| Operation | JSON Path | XML Path |
|---|---|---|
| [Lines](#lines) | `/json/jLines` | `/Lines` |
| [Parking Information](#parking-information) | `/json/jStationParking` | `/StationParking` |
| [Path Between Stations](#path-between-stations) | `/json/jPath` | `/Path` |
| [Station Entrances](#station-entrances) | `/json/jStationEntrances` | `/StationEntrances` |
| [Station Information](#station-information) | `/json/jStationInfo` | `/StationInfo` |
| [Station List](#station-list) | `/json/jStations` | `/Stations` |
| [Station Timings](#station-timings) | `/json/jStationTimes` | `/StationTimes` |
| [Station to Station Information](#station-to-station-information) | `/json/jSrcStationToDstStationInfo` | `/SrcStationToDstStationInfo` |

---

## Lines

Returns information about all rail lines.

### Request

```
GET /Rail.svc/json/jLines
```

No query parameters.

### Response Elements — `Lines[]`

| Element | Type | Description |
|---|---|---|
| `DisplayName` | string | Full line color name (e.g., `"Red"`). |
| `EndStationCode` | string | Terminal station code at one end. |
| `InternalDestination1` | string | Intermediate terminal station code (e.g., `A11` Grosvenor on Red). Empty string if none. |
| `InternalDestination2` | string | Second intermediate terminal, if applicable. |
| `LineCode` | string | Two-letter abbreviation (`RD`, `BL`, `YL`, `OR`, `GR`, `SV`). |
| `StartStationCode` | string | Terminal station code at the other end. |

### Example Request

```bash
curl -s "https://api.wmata.com/Rail.svc/json/jLines" \
  -H "api_key: YOUR_KEY"
```

### Example Response

```json
{
  "Lines": [
    {
      "DisplayName": "Red",
      "EndStationCode": "B11",
      "InternalDestination1": "A11",
      "InternalDestination2": "B08",
      "LineCode": "RD",
      "StartStationCode": "A15"
    }
  ]
}
```

---

## Parking Information

Returns parking information at a station. Omit `StationCode` to return info for all stations. Stations with no parking return an empty `StationsParking` element.

### Request

```
GET /Rail.svc/json/jStationParking[?StationCode=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `StationCode` | query | No | string | Station code. Omit for all stations. |

### Response Elements — `StationsParking[]`

| Element | Type | Description |
|---|---|---|
| `Code` | string | Station code. |
| `Notes` | string | Additional parking resources. May be `null`. |
| `AllDayParking` | object | See sub-elements below. |
| `ShortTermParking` | object | See sub-elements below. |

**AllDayParking:**

| Element | Type | Description |
|---|---|---|
| `TotalCount` | integer | Number of all-day spots. |
| `RiderCost` | number | Weekday cost for Metro riders. `null` if no spots. |
| `NonRiderCost` | number | Weekday cost for non-riders. `null` if no spots. |
| `SaturdayRiderCost` | number | Saturday cost for riders. |
| `SaturdayNonRiderCost` | number | Saturday cost for non-riders. |

**ShortTermParking:**

| Element | Type | Description |
|---|---|---|
| `TotalCount` | integer | Number of metered spots. |
| `Notes` | string | Parking meter details. `null` if no spots. |

### Example Request

```bash
curl -s "https://api.wmata.com/Rail.svc/json/jStationParking?StationCode=F06" \
  -H "api_key: YOUR_KEY"
```

---

## Path Between Stations

Returns ordered stations and distances between two stations on the **same line**.

This method is **not** suitable as a standalone pathfinding solution between arbitrary stations.

### Request

```
GET /Rail.svc/json/jPath?FromStationCode={code}&ToStationCode={code}
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `FromStationCode` | query | **Yes** | string | Origin station code. |
| `ToStationCode` | query | **Yes** | string | Destination station code. |

### Response Elements — `Path[]`

| Element | Type | Description |
|---|---|---|
| `DistanceToPrev` | integer | Distance in **feet** to the previous station. 0 for the first station. |
| `LineCode` | string | Line abbreviation for this platform. |
| `SeqNum` | integer | Ordered sequence number. |
| `StationCode` | string | Station code. |
| `StationName` | string | Full station name. |

### Example Request

```bash
curl -s "https://api.wmata.com/Rail.svc/json/jPath?FromStationCode=N06&ToStationCode=G05" \
  -H "api_key: YOUR_KEY"
```

### Example Response (abbreviated)

```json
{
  "Path": [
    { "DistanceToPrev": 0, "LineCode": "SV", "SeqNum": 1, "StationCode": "N06", "StationName": "Wiehle-Reston East" },
    { "DistanceToPrev": 30867, "LineCode": "SV", "SeqNum": 2, "StationCode": "N04", "StationName": "Spring Hill" }
  ]
}
```

---

## Station Entrances

Returns nearby station entrances based on latitude, longitude, and radius (meters). Omit all search parameters to return all entrances.

### Request

```
GET /Rail.svc/json/jStationEntrances[?Lat=][&Lon=][&Radius=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `Lat` | query | No | number | Center latitude. Required with `Lon` and `Radius`. |
| `Lon` | query | No | number | Center longitude. Required with `Lat` and `Radius`. |
| `Radius` | query | No | number | Radius in **meters**. Required with `Lat` and `Lon`. |

### Response Elements — `Entrances[]`

| Element | Type | Description |
|---|---|---|
| `Description` | string | Additional info. Usually same as `Name`. |
| `ID` | string | **Deprecated.** |
| `Lat` | number | Latitude. |
| `Lon` | number | Longitude. |
| `Name` | string | Station name and nearest intersection. |
| `StationCode1` | string | Primary station code. |
| `StationCode2` | string | Second station code for multi-platform stations. May be empty. |

### Example Request

```bash
curl -s "https://api.wmata.com/Rail.svc/json/jStationEntrances?Lat=38.8978&Lon=-77.0404&Radius=500" \
  -H "api_key: YOUR_KEY"
```

---

## Station Information

Returns location and address information for a single station.

### Request

```
GET /Rail.svc/json/jStationInfo?StationCode={code}
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `StationCode` | query | **Yes** | string | Station code. |

### Response Elements

| Element | Type | Description |
|---|---|---|
| `Address` | object | Contains `City`, `State`, `Street`, `Zip`. |
| `Code` | string | Station code (echoed from input). |
| `Lat` | number | Latitude. |
| `LineCode1` | string | Primary line served. |
| `LineCode2` | string | Additional line, if applicable. |
| `LineCode3` | string | Additional line, if applicable. |
| `LineCode4` | string | Reserved; not currently in use. |
| `Lon` | number | Longitude. |
| `Name` | string | Station name. |
| `StationTogether1` | string | Additional station code for multi-platform stations (e.g., Gallery Place). |
| `StationTogether2` | string | Reserved; not currently in use. |

### Example Request

```bash
curl -s "https://api.wmata.com/Rail.svc/json/jStationInfo?StationCode=A01" \
  -H "api_key: YOUR_KEY"
```

### Example Response

```json
{
  "Address": {
    "City": "Washington",
    "State": "DC",
    "Street": "607 13th St. NW",
    "Zip": "20005"
  },
  "Code": "A01",
  "Lat": 38.8983144732,
  "LineCode1": "RD",
  "LineCode2": null,
  "LineCode3": null,
  "LineCode4": null,
  "Lon": -77.0280779971,
  "Name": "Metro Center",
  "StationTogether1": "C01",
  "StationTogether2": ""
}
```

---

## Station List

Returns all station locations and addresses, optionally filtered by line.

### Request

```
GET /Rail.svc/json/jStations[?LineCode=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `LineCode` | query | No | string | Filter by line: `RD`, `YL`, `GR`, `BL`, `OR`, `SV`. Omit for all. |

### Response Elements — `Stations[]`

Same structure as [Station Information](#station-information) response, returned as an array.

### Example Request

```bash
curl -s "https://api.wmata.com/Rail.svc/json/jStations?LineCode=RD" \
  -H "api_key: YOUR_KEY"
```

---

## Station Timings

Returns opening and scheduled first/last train times for a station. Omit `StationCode` for all stations.

For multi-platform stations, a separate call is required per station code.

### Request

```
GET /Rail.svc/json/jStationTimes[?StationCode=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `StationCode` | query | No | string | Station code. Omit for all. |

### Response Elements — `StationTimes[]`

| Element | Type | Description |
|---|---|---|
| `Code` | string | Station code. |
| `StationName` | string | Full station name. |
| `Monday` .. `Sunday` | object | Day-of-week container with `OpeningTime`, `FirstTrains[]`, `LastTrains[]`. |

**Day sub-elements:**

| Element | Type | Description |
|---|---|---|
| `OpeningTime` | string | Station opening time. Format: `HH:mm`. |
| `FirstTrains[]` | array | Objects with `Time` (`HH:mm`) and `DestinationStation`. |
| `LastTrains[]` | array | Objects with `Time` (`HH:mm`) and `DestinationStation`. AM times signify the next day. |

### Example Request

```bash
curl -s "https://api.wmata.com/Rail.svc/json/jStationTimes?StationCode=E10" \
  -H "api_key: YOUR_KEY"
```

---

## Station to Station Information

Returns distance, fare information, and estimated travel time between any two stations (including different lines). Omit both parameters for all station pairs.

### Request

```
GET /Rail.svc/json/jSrcStationToDstStationInfo[?FromStationCode=][&ToStationCode=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `FromStationCode` | query | No | string | Origin station code. |
| `ToStationCode` | query | No | string | Destination station code. |

### Response Elements — `StationToStationInfos[]`

| Element | Type | Description |
|---|---|---|
| `CompositeMiles` | number | Average of actual and straight-line distance (used for fare calculation). |
| `DestinationStation` | string | Destination station code. |
| `RailFare` | object | Fare structure (see below). |
| `RailTime` | integer | Estimated travel time in **minutes** (schedule-based, not real-time). |
| `SourceStation` | string | Origin station code. |

**RailFare sub-elements:**

| Element | Type | Description |
|---|---|---|
| `OffPeakTime` | number | Fare during off-peak hours. |
| `PeakTime` | number | Fare during peak hours (weekdays opening–9:30 AM and 3–7 PM; weekends midnight–closing). |
| `SeniorDisabled` | number | Reduced fare for seniors/people with disabilities. |

### Example Request

```bash
curl -s "https://api.wmata.com/Rail.svc/json/jSrcStationToDstStationInfo?FromStationCode=E10&ToStationCode=J03" \
  -H "api_key: YOUR_KEY"
```

### Example Response

```json
{
  "StationToStationInfos": [
    {
      "CompositeMiles": 25.41,
      "DestinationStation": "J03",
      "RailFare": {
        "OffPeakTime": 3.60,
        "PeakTime": 5.90,
        "SeniorDisabled": 2.95
      },
      "RailTime": 66,
      "SourceStation": "E10"
    }
  ]
}
```

---

## Common Pitfalls

1. **Path Between Stations only works on the same line** — It does not compute cross-line transfers. For cross-line journeys, use Station to Station Information (fares/time) and build routing logic yourself.
2. **Multi-platform stations have multiple codes** — Stations like Gallery Place (`B01`/`F01`) and Metro Center (`A01`/`C01`) require queries for each code to get complete data across lines.
3. **`RailTime` is schedule-based** — The travel time returned by Station to Station is not correlated with the `Min` field from Real-Time Rail Predictions.
4. **`StationTogether1` is critical for multi-platform stations** — Always check this field when building a station lookup; it references the companion platform's code.
5. **LastTrains AM times wrap to next day** — A `02:30` value under Saturday means the last train departs Sunday at 2:30 AM.
6. **Fare structure may change** — WMATA updates fares periodically. Cache fare data reasonably but refresh regularly.
