"""Rail Predictions CLI menu."""

from wmata.api.client import WmataClient
from wmata.api import endpoints
from wmata.cli.app import pick, pause, prompt, EOF_SENTINEL
from wmata.cli.station_cache import search_stations
from wmata.utils.formatting import (
    print_subheader, print_table, print_error, print_info,
    colorize, format_min,
)


def _fetch_predictions(client: WmataClient, station_codes: str) -> list[dict]:
    url = endpoints.RAIL_PREDICTIONS.format(station_codes=station_codes)
    data = client.get(url)
    return data.get("Trains", [])


def _display_predictions(trains: list[dict]) -> None:
    rows = []
    for t in trains:
        line = t.get("Line", "")
        line_display = colorize(line or "--", line) if line else "--"
        rows.append([
            line_display,
            t.get("Car", "--"),
            t.get("Destination", ""),
            format_min(t.get("Min")),
            t.get("LocationName", ""),
        ])
    print_table(["Line", "Cars", "Destination", "ETA", "Station"], rows)


def menu(client: WmataClient) -> None:
    while True:
        choice = pick("Rail Predictions", [
            "Enter station code(s)",
            "Search station by name",
            "All stations",
            "Back",
        ])

        if choice == 1:
            codes = prompt("Station code(s), comma-separated (e.g. A01,C01)")
            if not codes:
                continue
            print_subheader(f"Predictions for {codes.upper()}")
            trains = _fetch_predictions(client, codes.upper())
            _display_predictions(trains)
            pause()

        elif choice == 2:
            query = prompt("Station name search")
            if not query:
                continue
            matches = search_stations(client, query)
            if not matches:
                print_info("No stations matched your search.")
                continue
            print()
            for s in matches:
                code = s.get("Code", "")
                name = s.get("Name", "")
                lines = ", ".join(filter(None, [
                    s.get("LineCode1"), s.get("LineCode2"),
                    s.get("LineCode3"), s.get("LineCode4"),
                ]))
                print(f"    {code}  {name}  ({lines})")
            print()
            codes = prompt("Enter code(s) from above to get predictions")
            if not codes:
                continue
            print_subheader(f"Predictions for {codes.upper()}")
            trains = _fetch_predictions(client, codes.upper())
            _display_predictions(trains)
            pause()

        elif choice == 3:
            print_subheader("All Station Predictions")
            print_info("Fetching predictions for all stations (this may be large)...")
            trains = _fetch_predictions(client, "All")
            _display_predictions(trains)
            pause()

        elif choice in (4, EOF_SENTINEL):
            break
        else:
            print_error("Invalid selection.")
