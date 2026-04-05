# Real-Time Bus Predictions

**Base URL**: `https://api.wmata.com/NextBusService.svc`
**Description**: Real-time bus prediction methods.

[Back to index](README.md)

---

## Endpoints at a Glance

| Operation | JSON Path | XML Path |
|---|---|---|
| [Next Buses](#next-buses) | `/json/jPredictions` | `/Predictions` |

---

## Next Buses

Returns next bus arrival times at a stop.

### Request

```
GET /NextBusService.svc/json/jPredictions?StopID={StopID}
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `StopID` | query | **Yes** | string | 7-digit regional stop ID. |

### Response Elements

| Element | Type | Description |
|---|---|---|
| `Predictions[]` | array | Array of `NextBusPrediction` objects. |
| `StopName` | string | Full name of the given stop. |

**NextBusPrediction sub-elements:**

| Element | Type | Description |
|---|---|---|
| `DirectionNum` | string | Binary direction (`0` or `1`). No fixed mapping — different values for the same route mean opposite directions. Use `DirectionText` for display. |
| `DirectionText` | string | Customer-friendly direction and destination (e.g., "North to Bwi - Thurgood Marshall Airport"). |
| `Minutes` | integer | Minutes until arrival. Numeric value. |
| `RouteID` | string | Base route name (variants like `10Av1` display as `10A`). |
| `TripID` | string | Trip identifier. Correlates with bus schedule data and bus positions. |
| `VehicleID` | string | Bus identifier. Correlates with bus positions. |

### Error Responses

| Status | Description |
|---|---|
| `200` | Success. |
| `400` | Invalid Stop ID: `"Stop Id not specified, invalid, or does not exist."` |

### Example Request

```bash
curl -s "https://api.wmata.com/NextBusService.svc/json/jPredictions?StopID=1001195" \
  -H "api_key: YOUR_KEY"
```

### Example Response

```json
{
  "Predictions": [
    {
      "DirectionNum": "0",
      "DirectionText": "North to Bwi - Thurgood Marshall Airport",
      "Minutes": 8,
      "RouteID": "B30",
      "TripID": "6794838",
      "VehicleID": "6217"
    },
    {
      "DirectionNum": "1",
      "DirectionText": "South to Greenbelt Station",
      "Minutes": 37,
      "RouteID": "B30",
      "TripID": "6794868",
      "VehicleID": "6217"
    }
  ],
  "StopName": "Bwi Airport + Stop 2"
}
```

---

## Common Pitfalls

1. **StopID is required** — Unlike some other endpoints, omitting `StopID` returns a `400` error, not all predictions.
2. **StopID must be a 7-digit regional ID** — This is not the same as a station code used in rail APIs. Use the Bus Route and Stop Methods > Stop Search endpoint to find valid stop IDs.
3. **`DirectionNum` is not meaningful on its own** — It's a binary toggle. Always display `DirectionText` to users.
4. **`Minutes` is always numeric** — Unlike Real-Time Rail Predictions where `Min` can be `ARR`, `BRD`, or `---`, bus predictions always return an integer minute count.
5. **`VehicleID` and `TripID` enable cross-API correlation** — Use `VehicleID` to match with Bus Positions, and `TripID` with bus schedule endpoints for richer trip context.
6. **Empty predictions are normal** — When no buses are approaching, `Predictions` will be an empty array. This often happens late at night or for infrequent routes.
