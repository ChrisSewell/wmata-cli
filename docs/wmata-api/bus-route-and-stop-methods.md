# Bus Route and Stop Methods

**Base URL**: `https://api.wmata.com/Bus.svc`
**Description**: Bus stop information, route and schedule data, and bus positions.

All endpoints are `GET` requests and are available in both JSON and XML formats. The JSON variant uses a `/json/j` prefix (e.g., `/json/jRoutes`).

[Back to index](README.md)

---

## Endpoints at a Glance

| Operation | JSON Path | XML Path |
|---|---|---|
| [Bus Position](#bus-position) | `/json/jBusPositions` | `/BusPositions` |
| [Path Details](#path-details) | `/json/jRouteDetails` | `/RouteDetails` |
| [Routes](#routes) | `/json/jRoutes` | `/Routes` |
| [Schedule](#schedule) | `/json/jRouteSchedule` | `/RouteSchedule` |
| [Schedule at Stop](#schedule-at-stop) | `/json/jStopSchedule` | `/StopSchedule` |
| [Stop Search](#stop-search) | `/json/jStops` | `/Stops` |

---

## Bus Position

Returns bus positions for a given route, with an optional search radius. If no parameters are specified, all bus positions are returned.

Bus positions are refreshed approximately every 7 to 10 seconds.

### Request

```
GET /Bus.svc/json/jBusPositions[?RouteID=][&Lat=][&Lon=][&Radius=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `RouteID` | query | No | string | Base bus route (e.g., `70`, `10A`). No variants. |
| `Lat` | query | No | number | Center point latitude. Required if `Lon` and `Radius` are specified. |
| `Lon` | query | No | number | Center point longitude. Required if `Lat` and `Radius` are specified. |
| `Radius` | query | No | number | Radius in **meters**. Required if `Lat` and `Lon` are specified. |

### Response Elements — `BusPositions[]`

| Element | Type | Description |
|---|---|---|
| `DateTime` | string | Last position update. `YYYY-MM-DDTHH:mm:ss` EST. |
| `Deviation` | number | Minutes from schedule. Positive = late, negative = early. |
| `DirectionNum` | string | **Deprecated.** Use `DirectionText`. |
| `DirectionText` | string | General trip direction (`NORTH`, `SOUTH`, `EAST`, `WEST`). |
| `Lat` | number | Last reported latitude. |
| `Lon` | number | Last reported longitude. |
| `RouteID` | string | Base route name (e.g., `10A` covers `10Av1`, `10Av2`, etc.). |
| `TripEndTime` | string | Scheduled end time of the current trip. |
| `TripHeadsign` | string | Destination of the bus. |
| `TripID` | string | Unique trip ID; correlates with schedule methods. |
| `TripStartTime` | string | Scheduled start time of the current trip. |
| `VehicleID` | string | Unique bus identifier (usually visible on the bus). |

### Example Request

```bash
curl -s "https://api.wmata.com/Bus.svc/json/jBusPositions?RouteID=70&Lat=38.9&Lon=-77.0&Radius=2000" \
  -H "api_key: YOUR_KEY"
```

### Example Response (JSON, abbreviated)

```json
{
  "BusPositions": [
    {
      "DateTime": "2024-10-27T13:23:40",
      "Deviation": 7.0,
      "DirectionNum": "10",
      "DirectionText": "NORTH",
      "Lat": 39.191525,
      "Lon": -76.672821,
      "RouteID": "B30",
      "TripEndTime": "2024-10-27T13:17:00",
      "TripHeadsign": "BWI LT RAIL STA",
      "TripID": "6794838",
      "TripStartTime": "2024-10-27T12:40:00",
      "VehicleID": "6217"
    }
  ]
}
```

---

## Path Details

Returns ordered latitude/longitude points along a route variant plus the list of stops served, for a given date.

### Request

```
GET /Bus.svc/json/jRouteDetails?RouteID={RouteID}[&Date=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `RouteID` | query | **Yes** | string | Bus route variant (e.g., `70`, `10A`, `10Av1`). |
| `Date` | query | No | string | `YYYY-MM-DD`. Defaults to today. |

### Response Elements

| Element | Type | Description |
|---|---|---|
| `Direction0` / `Direction1` | object | Path/stop info for each direction. Most routes populate both; a few return `null` for one. 0 and 1 are binary — no fixed mapping to compass direction. |
| `Name` | string | Descriptive route name. |
| `RouteID` | string | Route variant. |

**Direction0/Direction1 sub-elements:**

| Element | Type | Description |
|---|---|---|
| `DirectionNum` | string | **Deprecated.** Use `DirectionText`. |
| `DirectionText` | string | General direction (`NORTH`, `SOUTH`, `EAST`, `WEST`, `LOOP`, etc.). |
| `Shape[]` | array | Ordered `ShapePoint` objects: `Lat`, `Lon`, `SeqNum`. |
| `Stops[]` | array | `Stop` objects: `Lat`, `Lon`, `Name`, `Routes[]`, `StopID`. |
| `TripHeadsign` | string | Destination text displayed on the bus. |

### Example Request

```bash
curl -s "https://api.wmata.com/Bus.svc/json/jRouteDetails?RouteID=70" \
  -H "api_key: YOUR_KEY"
```

---

## Routes

Returns a list of all bus route variants (patterns). For example, `10A` and `10Av1` are the same route but may stop at slightly different locations.

### Request

```
GET /Bus.svc/json/jRoutes
```

No query parameters.

### Response Elements — `Routes[]`

| Element | Type | Description |
|---|---|---|
| `Name` | string | Descriptive name of the route variant. |
| `RouteID` | string | Unique route variant identifier. |
| `LineDescription` | string | Grouping of routes sharing a corridor. |

### Example Request

```bash
curl -s "https://api.wmata.com/Bus.svc/json/jRoutes" \
  -H "api_key: YOUR_KEY"
```

### Example Response (JSON, abbreviated)

```json
{
  "Routes": [
    {
      "LineDescription": "Hunting Point-Pentagon Line",
      "Name": "10A - HUNTING POINT -PENTAGON",
      "RouteID": "10A"
    },
    {
      "LineDescription": "Hunting Point-Pentagon Line",
      "Name": "10A - PENDELTON+COLUMBUS-PENTAGON",
      "RouteID": "10Av1"
    }
  ]
}
```

---

## Schedule

Returns schedules for a given route variant for a given date.

### Request

```
GET /Bus.svc/json/jRouteSchedule?RouteID={RouteID}[&Date=][&IncludingVariations=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `RouteID` | query | **Yes** | string | Bus route variant (e.g., `70`, `10A`, `10Av1`). |
| `Date` | query | No | string | `YYYY-MM-DD`. Defaults to today. |
| `IncludingVariations` | query | No | boolean | If `true`, include all variants of the base route. Default `false`. |

### Response Elements

| Element | Type | Description |
|---|---|---|
| `Direction0` / `Direction1` | array | Arrays of `Trip` objects per direction. |
| `Name` | string | Descriptive route name. |

**Trip sub-elements:**

| Element | Type | Description |
|---|---|---|
| `DirectionNum` | string | **Deprecated.** Use `TripDirectionText`. |
| `EndTime` | string | Scheduled end time. |
| `RouteID` | string | Route variant for this trip. |
| `StartTime` | string | Scheduled start time. |
| `StopTimes[]` | array | `StopTime` objects (see below). |
| `TripDirectionText` | string | General direction (`NORTH`, `SOUTH`, etc.). |
| `TripHeadsign` | string | Destination text. |
| `TripID` | string | Unique trip ID. |

**StopTime sub-elements:**

| Element | Type | Description |
|---|---|---|
| `StopID` | string | 7-digit regional stop ID (0 or `null` if unavailable). |
| `StopName` | string | Stop name. |
| `StopSeq` | integer | Order in the trip. |
| `Time` | string | Scheduled departure time. |

### Example Request

```bash
curl -s "https://api.wmata.com/Bus.svc/json/jRouteSchedule?RouteID=70&IncludingVariations=true" \
  -H "api_key: YOUR_KEY"
```

---

## Schedule at Stop

Returns buses scheduled at a stop for a given date.

### Request

```
GET /Bus.svc/json/jStopSchedule?StopID={StopID}[&Date=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `StopID` | query | **Yes** | string | 7-digit regional stop ID. |
| `Date` | query | No | string | `YYYY-MM-DD`. Defaults to today. |

### Response Elements

| Element | Type | Description |
|---|---|---|
| `ScheduleArrivals[]` | array | Array of `ScheduleArrival` objects. |
| `Stop` | object | Stop details: `Name`, `Lat`, `Lon`, `Routes[]`, `StopID`. |

**ScheduleArrival sub-elements:**

| Element | Type | Description |
|---|---|---|
| `DirectionNum` | string | Binary direction indicator. |
| `EndTime` | string | Scheduled end time for the trip. |
| `RouteID` | string | Base route name. |
| `ScheduleTime` | string | Scheduled arrival time at this stop. |
| `StartTime` | string | Scheduled start time for the trip. |
| `TripDirectionText` | string | General direction. |
| `TripHeadsign` | string | Destination text. |
| `TripID` | string | Unique trip ID. |

### Example Request

```bash
curl -s "https://api.wmata.com/Bus.svc/json/jStopSchedule?StopID=1001195" \
  -H "api_key: YOUR_KEY"
```

---

## Stop Search

Returns a list of nearby bus stops based on latitude, longitude, and radius. Omit all parameters to return all stops.

### Request

```
GET /Bus.svc/json/jStops[?Lat=][&Lon=][&Radius=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `Lat` | query | No | number | Latitude. Required if `Lon` and `Radius` are specified. |
| `Lon` | query | No | number | Longitude. Required if `Lat` and `Radius` are specified. |
| `Radius` | query | No | number | Radius in **meters**. Required if `Lat` and `Lon` are specified. |

### Response Elements — `Stops[]`

| Element | Type | Description |
|---|---|---|
| `Lat` | number | Latitude. |
| `Lon` | number | Longitude. |
| `Name` | string | Stop name. |
| `Routes[]` | array | String array of route variants serving this stop (not date-specific). |
| `StopID` | string | 7-digit regional stop ID (0 or `null` if unavailable). |

### Example Request

```bash
curl -s "https://api.wmata.com/Bus.svc/json/jStops?Lat=38.878&Lon=-76.985&Radius=500" \
  -H "api_key: YOUR_KEY"
```

---

## Common Pitfalls

1. **Using route variants instead of base routes for `BusPositions`** — The `RouteID` parameter on Bus Position only accepts base route names (e.g., `10A`, not `10Av1`). Using a variant returns no results.
2. **Omitting all three geo parameters** — `Lat`, `Lon`, and `Radius` are coupled: if any one is provided, all three must be present. Partial combinations cause empty or error responses.
3. **Assuming `DirectionNum` is meaningful** — `DirectionNum` is deprecated across all bus endpoints. Always use `DirectionText`.
4. **Ignoring schedule date defaults** — If `Date` is omitted on schedule endpoints, today's date (Eastern Time) is used. If no service runs on that date, the response may be empty rather than an error.
5. **Route variant confusion** — The Routes endpoint returns *variants* (e.g., `10Av1`, `10Av2`), while Bus Position, Incidents, and Predictions use *base* route names only.
