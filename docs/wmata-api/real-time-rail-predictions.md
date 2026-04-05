# Real-Time Rail Predictions

**Base URL**: `https://api.wmata.com/StationPrediction.svc`
**Description**: Real-time rail prediction methods.

Next train arrival information is refreshed approximately every 20 to 30 seconds.

[Back to index](README.md)

---

## Endpoints at a Glance

| Operation | JSON Path | XML Path |
|---|---|---|
| [Next Trains](#next-trains) | `/json/GetPrediction/{StationCodes}` | `/GetPrediction/{StationCodes}` |

---

## Next Trains

Returns next train arrival information for one or more stations. Returns an empty set when no predictions are available.

### Request

```
GET /StationPrediction.svc/json/GetPrediction/{StationCodes}
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `StationCodes` | path | **Yes** | string | Comma-separated station codes, or `All` for every station. |

### Response Elements — `Trains[]`

| Element | Type | Description |
|---|---|---|
| `Car` | string | Number of cars (usually `6` or `8`). May return `-` or `null`. |
| `Destination` | string | Abbreviated destination (similar to station signs). |
| `DestinationCode` | string | Destination station code. Can be `null`. |
| `DestinationName` | string | Full destination name (when `DestinationCode` is populated). For trains with no passengers: `"No Passenger"`. |
| `Group` | string | Track group. Different values at the same station indicate different tracks. Does not directly map to Track 1/Track 2. |
| `Line` | string | Line abbreviation (`RD`, `BL`, `YL`, `OR`, `GR`, `SV`). May be blank or `No` for non-revenue trains. |
| `LocationCode` | string | Station code where the train is arriving. Useful when using `All`. |
| `LocationName` | string | Full station name where the train is arriving. |
| `Min` | string | Minutes until arrival. Values: numeric, `ARR` (arriving), `BRD` (boarding), `---`, or empty. |

### Special `Min` Values

| Value | Meaning |
|---|---|
| Numeric (e.g., `3`) | Minutes until arrival. |
| `ARR` | Train is arriving at the station. |
| `BRD` | Train is boarding passengers. |
| `---` | Prediction is not available. |
| Empty | No prediction data. |

### Example Request

```bash
curl -s "https://api.wmata.com/StationPrediction.svc/json/GetPrediction/A01,C01" \
  -H "api_key: YOUR_KEY"
```

### Example Response

```json
{
  "Trains": [
    {
      "Car": "6",
      "Destination": "SilvrSpg",
      "DestinationCode": "B08",
      "DestinationName": "Silver Spring",
      "Group": "1",
      "Line": "RD",
      "LocationCode": "A01",
      "LocationName": "Metro Center",
      "Min": "3"
    },
    {
      "Car": "6",
      "Destination": "Grsvnor",
      "DestinationCode": "A11",
      "DestinationName": "Grosvenor-Strathmore",
      "Group": "2",
      "Line": "RD",
      "LocationCode": "A01",
      "LocationName": "Metro Center",
      "Min": "4"
    }
  ]
}
```

---

## Common Pitfalls

1. **Multi-platform stations need both codes** — Stations like Gallery Place (`B01`/`F01`), Fort Totten (`B06`/`E06`), L'Enfant Plaza (`D03`/`F03`), and Metro Center (`A01`/`C01`) have two platforms. Pass both codes comma-separated (e.g., `A01,C01`) for complete predictions.
2. **Terminal stations may show duplicates** — Predictions at end-of-line stations (Greenbelt, Shady Grove, etc.) may appear twice.
3. **`Min` is a string, not a number** — Always handle non-numeric values (`ARR`, `BRD`, `---`, empty) before parsing.
4. **`Line` can be blank** — Non-revenue (no-passenger) trains may have blank `Line` or `No`.
5. **`Group` does not equal track number** — Group is a relative indicator. Use it to distinguish platform sides, not to identify physical tracks.
6. **Using `All` returns high volume** — Requesting predictions for all stations produces a large response. Cache and filter client-side if you need frequent updates for specific stations.
7. **This is not schedule data** — `Min` values are real-time predictions. For scheduled times, use Rail Station Information > Station Timings.
