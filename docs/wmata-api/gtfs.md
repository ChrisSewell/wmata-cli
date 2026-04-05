# GTFS

**Base URL**: `https://api.wmata.com/gtfs`
**Description**: GTFS static feeds and GTFS-RT (real-time) feeds for bus and rail.

All feeds require the `api_key` header. Static feeds return ZIP archives containing GTFS text files. Real-time feeds return binary Protocol Buffer (`.pb`) data conforming to the GTFS-RT 1.0 specification.

**GTFS support**: <gtfs-support@wmata.com>

[Back to index](README.md)

---

## Endpoints at a Glance

| Operation | Path | Format |
|---|---|---|
| [Bus GTFS Static](#bus-gtfs-static) | `/bus-gtfs-static.zip` | ZIP (GTFS) |
| [Bus RT Alerts](#bus-rt-alerts) | `/bus-gtfsrt-alerts.pb` | Protobuf |
| [Bus RT Trip Updates](#bus-rt-trip-updates) | `/bus-gtfsrt-tripupdates.pb` | Protobuf |
| [Bus RT Vehicle Positions](#bus-rt-vehicle-positions) | `/bus-gtfsrt-vehiclepositions.pb` | Protobuf |
| [Rail GTFS Static](#rail-gtfs-static) | `/rail-gtfs-static.zip` | ZIP (GTFS) |
| [Rail RT Alerts](#rail-rt-alerts) | `/rail-gtfsrt-alerts.pb` | Protobuf |
| [Rail RT Trip Updates](#rail-rt-trip-updates) | `/rail-gtfsrt-tripupdates.pb` | Protobuf |
| [Rail RT Vehicle Positions](#rail-rt-vehicle-positions) | `/rail-gtfsrt-vehiclepositions.pb` | Protobuf |

---

## Bus GTFS Static

Returns the current Metrobus GTFS static feed as a ZIP archive.

### Request

```
GET /gtfs/bus-gtfs-static.zip
```

No query parameters. Returns a ZIP file containing standard GTFS text files (`agency.txt`, `routes.txt`, `stops.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt`, `shapes.txt`, etc.).

### Example Request

```bash
curl -s "https://api.wmata.com/gtfs/bus-gtfs-static.zip" \
  -H "api_key: YOUR_KEY" \
  -o bus-gtfs-static.zip
```

---

## Bus RT Alerts

Returns real-time Metrobus service alerts in GTFS-RT format.

### Request

```
GET /gtfs/bus-gtfsrt-alerts.pb
```

### Example Request

```bash
curl -s "https://api.wmata.com/gtfs/bus-gtfsrt-alerts.pb" \
  -H "api_key: YOUR_KEY" \
  -o bus-alerts.pb
```

---

## Bus RT Trip Updates

Returns real-time Metrobus trip update information (arrival/departure predictions for upcoming stops) in GTFS-RT format.

### Request

```
GET /gtfs/bus-gtfsrt-tripupdates.pb
```

### Example Request

```bash
curl -s "https://api.wmata.com/gtfs/bus-gtfsrt-tripupdates.pb" \
  -H "api_key: YOUR_KEY" \
  -o bus-tripupdates.pb
```

---

## Bus RT Vehicle Positions

Returns real-time Metrobus vehicle positions and occupancy status in GTFS-RT format.

### Request

```
GET /gtfs/bus-gtfsrt-vehiclepositions.pb
```

### Example Request

```bash
curl -s "https://api.wmata.com/gtfs/bus-gtfsrt-vehiclepositions.pb" \
  -H "api_key: YOUR_KEY" \
  -o bus-vehiclepositions.pb
```

---

## Rail GTFS Static

Returns the current Metrorail GTFS static feed as a ZIP archive. Includes enhanced station data with platforms, levels, and pathways for accessibility and wayfinding.

### Request

```
GET /gtfs/rail-gtfs-static.zip
```

### Example Request

```bash
curl -s "https://api.wmata.com/gtfs/rail-gtfs-static.zip" \
  -H "api_key: YOUR_KEY" \
  -o rail-gtfs-static.zip
```

---

## Rail RT Alerts

Returns real-time Metrorail service alerts in GTFS-RT format.

### Request

```
GET /gtfs/rail-gtfsrt-alerts.pb
```

### Example Request

```bash
curl -s "https://api.wmata.com/gtfs/rail-gtfsrt-alerts.pb" \
  -H "api_key: YOUR_KEY" \
  -o rail-alerts.pb
```

---

## Rail RT Trip Updates

Returns real-time Metrorail trip update information in GTFS-RT format.

### Request

```
GET /gtfs/rail-gtfsrt-tripupdates.pb
```

### Example Request

```bash
curl -s "https://api.wmata.com/gtfs/rail-gtfsrt-tripupdates.pb" \
  -H "api_key: YOUR_KEY" \
  -o rail-tripupdates.pb
```

---

## Rail RT Vehicle Positions

Returns real-time Metrorail vehicle positions in GTFS-RT format.

### Request

```
GET /gtfs/rail-gtfsrt-vehiclepositions.pb
```

### Example Request

```bash
curl -s "https://api.wmata.com/gtfs/rail-gtfsrt-vehiclepositions.pb" \
  -H "api_key: YOUR_KEY" \
  -o rail-vehiclepositions.pb
```

---

## Working with GTFS-RT Feeds

GTFS-RT feeds use Protocol Buffers. To read them you need a protobuf library:

**Python example:**

```python
from google.transit import gtfs_realtime_pb2
import requests

feed = gtfs_realtime_pb2.FeedMessage()
response = requests.get(
    "https://api.wmata.com/gtfs/bus-gtfsrt-vehiclepositions.pb",
    headers={"api_key": "YOUR_KEY"}
)
feed.ParseFromString(response.content)

for entity in feed.entity:
    if entity.HasField("vehicle"):
        v = entity.vehicle
        print(f"Vehicle {v.vehicle.id} at ({v.position.latitude}, {v.position.longitude})")
```

**Required Python package:** `gtfs-realtime-bindings`

```bash
pip install gtfs-realtime-bindings
```

---

## GTFS-RT Feed Message Types

Each `.pb` feed contains a `FeedMessage` with `FeedEntity` objects. The entity type depends on the feed:

| Feed | Entity Field | Content |
|---|---|---|
| Alerts | `alert` | Service alerts with affected routes/stops, cause, effect, description. |
| Trip Updates | `trip_update` | Predicted arrival/departure times at upcoming stops for active trips. |
| Vehicle Positions | `vehicle` | Current position (lat/lon), trip assignment, occupancy status, timestamp. |

---

## Common Pitfalls

1. **Binary format** — These are not JSON/XML endpoints. You must use a protobuf parser. Attempting to read them as text will produce garbage.
2. **Static feeds are large** — The ZIP files can be tens of megabytes. Cache them locally and check the `Last-Modified` header or feed version before re-downloading.
3. **GTFS-RT feeds conform to v1.0** — Some newer GTFS-RT v2.0 fields may not be populated. Stick to v1.0 entity definitions.
4. **API key goes in the header** — Unlike some GTFS-RT providers that use query string tokens, WMATA requires the key in the `api_key` header.
5. **Rate limits apply** — GTFS feeds count against the same rate limits as REST endpoints (10/sec, 50,000/day on the free tier).
6. **Rail static feed includes pathways** — The rail GTFS static feed contains `pathways.txt` and `levels.txt` for indoor navigation and accessibility routing.
7. **Contact GTFS-specific support** — For feed-specific issues, use <gtfs-support@wmata.com> instead of the general API support address.
