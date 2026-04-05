BASE = "https://api.wmata.com"

VALIDATE = f"{BASE}/Misc/Validate"

# Rail Predictions
RAIL_PREDICTIONS = f"{BASE}/StationPrediction.svc/json/GetPrediction/{{station_codes}}"

# Bus Predictions
BUS_PREDICTIONS = f"{BASE}/NextBusService.svc/json/jPredictions"

# Incidents
INCIDENTS_RAIL = f"{BASE}/Incidents.svc/json/Incidents"
INCIDENTS_BUS = f"{BASE}/Incidents.svc/json/BusIncidents"
INCIDENTS_ELEVATOR = f"{BASE}/Incidents.svc/json/ElevatorIncidents"

# Rail Station Information
RAIL_LINES = f"{BASE}/Rail.svc/json/jLines"
RAIL_STATIONS = f"{BASE}/Rail.svc/json/jStations"
RAIL_STATION_INFO = f"{BASE}/Rail.svc/json/jStationInfo"
RAIL_STATION_PARKING = f"{BASE}/Rail.svc/json/jStationParking"
RAIL_STATION_TIMES = f"{BASE}/Rail.svc/json/jStationTimes"
RAIL_STATION_TO_STATION = f"{BASE}/Rail.svc/json/jSrcStationToDstStationInfo"
RAIL_PATH = f"{BASE}/Rail.svc/json/jPath"
