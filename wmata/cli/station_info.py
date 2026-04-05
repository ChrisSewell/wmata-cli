"""Station Information CLI menu."""

from wmata.api.client import WmataClient
from wmata.api import endpoints
from wmata.cli.app import pick, pause, prompt, EOF_SENTINEL
from wmata.cli.station_cache import get_stations, search_stations
from wmata.utils.formatting import (
    print_subheader, print_table, print_info, print_error,
    colorize, LINE_NAMES, BOLD, RESET,
)


def _list_lines(client: WmataClient) -> None:
    print_subheader("Metro Lines")
    data = client.get(endpoints.RAIL_LINES)
    lines = data.get("Lines", [])

    rows = []
    for line in lines:
        code = line.get("LineCode", "")
        rows.append([
            colorize(code, code),
            colorize(line.get("DisplayName", ""), code),
            line.get("StartStationCode", ""),
            line.get("EndStationCode", ""),
        ])
    print_table(["Code", "Name", "Start", "End"], rows)


def _search_stations(client: WmataClient) -> None:
    print_subheader("Search Stations")
    query = prompt("Enter station name (partial match)")
    if not query:
        return

    matches = search_stations(client, query)
    if not matches:
        print_info("No stations matched your search.")
        return

    rows = []
    for s in matches:
        lines = ", ".join(filter(None, [
            s.get("LineCode1"), s.get("LineCode2"),
            s.get("LineCode3"), s.get("LineCode4"),
        ]))
        rows.append([
            s.get("Code", ""),
            s.get("Name", ""),
            lines,
        ])
    print_table(["Code", "Station Name", "Lines"], rows)


def _station_detail(client: WmataClient) -> None:
    print_subheader("Station Detail")
    code = prompt("Station code (e.g. A01)")
    if not code:
        return

    data = client.get(endpoints.RAIL_STATION_INFO, params={"StationCode": code.upper()})

    addr = data.get("Address", {})
    lines_served = ", ".join(filter(None, [
        data.get("LineCode1"), data.get("LineCode2"),
        data.get("LineCode3"), data.get("LineCode4"),
    ]))
    together = data.get("StationTogether1", "")

    rows = [
        ["Name", data.get("Name", "")],
        ["Code", data.get("Code", "")],
        ["Lines", lines_served],
        ["Address", f"{addr.get('Street', '')}, {addr.get('City', '')}, {addr.get('State', '')} {addr.get('Zip', '')}"],
        ["Latitude", str(data.get("Lat", ""))],
        ["Longitude", str(data.get("Lon", ""))],
    ]
    if together:
        rows.append(["Also (multi-platform)", together])

    print_table(["Field", "Value"], rows)


def _fares(client: WmataClient) -> None:
    print_subheader("Fares Between Stations")
    from_code = prompt("From station code")
    if not from_code:
        return
    to_code = prompt("To station code")
    if not to_code:
        return

    data = client.get(endpoints.RAIL_STATION_TO_STATION, params={
        "FromStationCode": from_code.upper(),
        "ToStationCode": to_code.upper(),
    })
    infos = data.get("StationToStationInfos", [])
    if not infos:
        print_info("No fare data returned for that station pair.")
        return

    info = infos[0]
    fare = info.get("RailFare", {})

    rows = [
        ["Distance (miles)", f"{info.get('CompositeMiles', '?')}"],
        ["Travel Time (min)", f"{info.get('RailTime', '?')}"],
        ["Peak Fare", f"${fare.get('PeakTime', '?')}"],
        ["Off-Peak Fare", f"${fare.get('OffPeakTime', '?')}"],
        ["Senior/Disabled Fare", f"${fare.get('SeniorDisabled', '?')}"],
    ]
    print_table(["", f"{from_code.upper()} -> {to_code.upper()}"], rows)


def _parking(client: WmataClient) -> None:
    print_subheader("Station Parking")
    code = prompt("Station code (leave blank for all)")
    params = {}
    if code:
        params["StationCode"] = code.upper()

    data = client.get(endpoints.RAIL_STATION_PARKING, params=params if params else None)
    items = data.get("StationsParking", [])
    if not items:
        print_info("No parking data available.")
        return

    rows = []
    for p in items:
        allday = p.get("AllDayParking", {}) or {}
        short = p.get("ShortTermParking", {}) or {}
        rider_cost = allday.get("RiderCost")
        rows.append([
            p.get("Code", ""),
            str(allday.get("TotalCount", 0)),
            f"${rider_cost}" if rider_cost is not None else "--",
            str(short.get("TotalCount", 0)),
            short.get("Notes", "") or "--",
        ])
    print_table(["Station", "All-Day Spots", "Rider Cost", "Short-Term Spots", "Notes"], rows)


def _timings(client: WmataClient) -> None:
    print_subheader("Station Timings")
    code = prompt("Station code")
    if not code:
        return

    data = client.get(endpoints.RAIL_STATION_TIMES, params={"StationCode": code.upper()})
    items = data.get("StationTimes", [])
    if not items:
        print_info("No timing data available.")
        return

    station = items[0]
    print_info(f"Station: {station.get('StationName', '')} ({station.get('Code', '')})")

    days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    rows = []
    for day in days:
        day_data = station.get(day, {})
        if not day_data:
            continue
        opening = day_data.get("OpeningTime", "--")
        firsts = day_data.get("FirstTrains", [])
        lasts = day_data.get("LastTrains", [])

        first_str = ", ".join(
            f"{t.get('DestinationStation', '?')} @ {t.get('Time', '?')}"
            for t in firsts if t.get("Time")
        ) or "--"
        last_str = ", ".join(
            f"{t.get('DestinationStation', '?')} @ {t.get('Time', '?')}"
            for t in lasts if t.get("Time")
        ) or "--"

        rows.append([day, opening, first_str, last_str])

    print_table(["Day", "Opens", "First Trains", "Last Trains"], rows)


def menu(client: WmataClient) -> None:
    while True:
        choice = pick("Station Information", [
            "List Lines",
            "Search Stations",
            "Station Detail",
            "Fares Between Stations",
            "Station Parking",
            "Station Timings",
            "Back",
        ])

        if choice == 1:
            _list_lines(client)
            pause()
        elif choice == 2:
            _search_stations(client)
            pause()
        elif choice == 3:
            _station_detail(client)
            pause()
        elif choice == 4:
            _fares(client)
            pause()
        elif choice == 5:
            _parking(client)
            pause()
        elif choice == 6:
            _timings(client)
            pause()
        elif choice in (7, EOF_SENTINEL):
            break
