# Incidents

**Base URL**: `https://api.wmata.com/Incidents.svc`
**Description**: Rail, bus, and elevator/escalator disruptions and outages.

All endpoints are `GET` requests available in both JSON and XML. JSON paths use a `/json/` prefix. Data is refreshed approximately every 20 to 30 seconds.

[Back to index](README.md)

---

## Endpoints at a Glance

| Operation | JSON Path | XML Path |
|---|---|---|
| [Bus Incidents](#bus-incidents) | `/json/BusIncidents` | `/BusIncidents` |
| [Elevator/Escalator Outages](#elevatorescalator-outages) | `/json/ElevatorIncidents` | `/ElevatorIncidents` |
| [Rail Incidents](#rail-incidents) | `/json/Incidents` | `/Incidents` |

---

## Bus Incidents

Returns reported bus incidents/delays for a given route. Omit the `Route` parameter to return all reported items.

### Request

```
GET /Incidents.svc/json/BusIncidents[?Route=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `Route` | query | No | string | Base bus route (e.g., `C2`, not `C2v1`). Omit for all incidents. |

### Response Elements — `BusIncidents[]`

| Element | Type | Description |
|---|---|---|
| `DateUpdated` | string | Last update timestamp. `YYYY-MM-DDTHH:mm:ss` EST. |
| `Description` | string | Free-text description of the delay or incident. |
| `IncidentID` | string | Unique incident identifier. |
| `IncidentType` | string | Usually `Delay` or `Alert`, but subject to change. |
| `RoutesAffected` | array | String array of affected routes (base names). May differ from what bus methods return. |

### Example Request

```bash
curl -s "https://api.wmata.com/Incidents.svc/json/BusIncidents?Route=90" \
  -H "api_key: YOUR_KEY"
```

### Example Response

```json
{
  "BusIncidents": [
    {
      "DateUpdated": "2024-10-28T08:13:03",
      "Description": "90, 92, X1, X2, X9: Due to traffic congestion at 8th & H St NE, buses are experiencing up to 20 minute delays in both directions.",
      "IncidentID": "32297013-57B6-467F-BC6B-93DFA4115652",
      "IncidentType": "Delay",
      "RoutesAffected": ["90", "92", "X1", "X2", "X9"]
    }
  ]
}
```

---

## Elevator/Escalator Outages

Returns reported elevator and escalator outages at a given station. Omit `StationCode` to return all outages.

For stations with multiple platforms (e.g., Metro Center, L'Enfant Plaza), a separate call is required for **each** `StationCode`.

### Request

```
GET /Incidents.svc/json/ElevatorIncidents[?StationCode=]
```

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `StationCode` | query | No | string | Two-character station code. Omit for all outages. |

### Response Elements — `ElevatorIncidents[]`

| Element | Type | Description |
|---|---|---|
| `DateOutOfServ` | string | Timestamp when the unit was reported out of service. |
| `DateUpdated` | string | Timestamp when outage details were last updated. |
| `DisplayOrder` | integer | **Deprecated.** |
| `EstimatedReturnToService` | string | Estimated return to service. May be `null`. |
| `LocationDescription` | string | Free-text location within the station (e.g., "Escalator between mezzanine and platform"). |
| `StationCode` | string | Station code. |
| `StationName` | string | Full station name, may include entrance info. |
| `SymptomCode` | string | **Deprecated.** |
| `SymptomDescription` | string | Reason the unit is out of service. |
| `TimeOutOfService` | string | **Deprecated.** Use `DateOutOfServ`. |
| `UnitName` | string | Unique unit identifier by type. |
| `UnitStatus` | string | **Deprecated.** If listed, unit is impaired. |
| `UnitType` | string | `ELEVATOR` or `ESCALATOR`. |

### Example Request

```bash
curl -s "https://api.wmata.com/Incidents.svc/json/ElevatorIncidents?StationCode=A03" \
  -H "api_key: YOUR_KEY"
```

### Example Response

```json
{
  "ElevatorIncidents": [
    {
      "DateOutOfServ": "2024-10-27T15:17:00",
      "DateUpdated": "2024-10-28T06:28:30",
      "DisplayOrder": 0,
      "EstimatedReturnToService": "2024-10-30T23:59:59",
      "LocationDescription": "Escalator between mezzanine and platform to Shady Grove",
      "StationCode": "A03",
      "StationName": "Dupont Circle, Q Street Entrance",
      "SymptomCode": null,
      "SymptomDescription": "Service Call",
      "TimeOutOfService": "1517",
      "UnitName": "A03N04",
      "UnitStatus": null,
      "UnitType": "ESCALATOR"
    }
  ]
}
```

---

## Rail Incidents

Returns reported rail incidents (significant disruptions and delays). The data is identical to WMATA's Metrorail Service Status feed.

### Request

```
GET /Incidents.svc/json/Incidents
```

No query parameters.

### Response Elements — `Incidents[]`

| Element | Type | Description |
|---|---|---|
| `DateUpdated` | string | Last update timestamp. |
| `DelaySeverity` | string | **Deprecated.** |
| `Description` | string | Free-text description of the incident. |
| `EmergencyText` | string | **Deprecated.** |
| `EndLocationFullName` | string | **Deprecated.** |
| `IncidentID` | string | Unique incident identifier. |
| `IncidentType` | string | Usually `Delay` or `Alert`, subject to change. |
| `LinesAffected` | string | Semicolon-and-space-separated line codes (e.g., `"BL; OR; SV;"`). See parsing note below. |
| `PassengerDelay` | number | **Deprecated.** |
| `StartLocationFullName` | string | **Deprecated.** |

### Parsing `LinesAffected`

The `LinesAffected` field is a string, not an array. To extract individual line codes:

```javascript
"RD; GR; BL;".split(/;[\s]?/).filter(fn => fn !== '')
// → ["RD", "GR", "BL"]
```

### Example Request

```bash
curl -s "https://api.wmata.com/Incidents.svc/json/Incidents" \
  -H "api_key: YOUR_KEY"
```

### Example Response

```json
{
  "Incidents": [
    {
      "DateUpdated": "2024-07-29T14:21:28",
      "DelaySeverity": null,
      "Description": "Red Line: Expect residual delays to Glenmont due to an earlier signal problem outside Forest Glen.",
      "EmergencyText": null,
      "EndLocationFullName": null,
      "IncidentID": "3754F8B2-A0A6-494E-A4B5-82C9E72DFA74",
      "IncidentType": "Delay",
      "LinesAffected": "RD;",
      "PassengerDelay": 0,
      "StartLocationFullName": null
    }
  ]
}
```

---

## Common Pitfalls

1. **`LinesAffected` is a string, not an array** — Rail incidents return lines as a semicolon-separated string. Always parse it before comparing to line codes.
2. **Multi-platform stations need multiple calls** — Elevator/Escalator outages for stations like Metro Center (`A01`/`C01`) require a call for each station code to get complete data.
3. **`Route` must be a base name** — Bus Incidents only accept base route names. Passing a variant returns no results.
4. **Deprecated fields are still present** — Fields like `DelaySeverity`, `SymptomCode`, and `UnitStatus` are returned but should not be used in new code.
5. **Empty responses are normal** — When no incidents are active, the array will be empty, not null or an error.
