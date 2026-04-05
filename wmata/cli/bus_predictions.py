"""Bus Predictions CLI menu."""

from wmata.api.client import WmataClient, WmataError
from wmata.api import endpoints
from wmata.cli.app import pause, prompt
from wmata.utils.formatting import (
    print_subheader, print_table, print_error, print_info,
)


def _fetch_predictions(client: WmataClient, stop_id: str) -> dict:
    return client.get(endpoints.BUS_PREDICTIONS, params={"StopID": stop_id})


def _display_predictions(data: dict) -> None:
    stop_name = data.get("StopName", "Unknown Stop")
    predictions = data.get("Predictions", [])

    print_info(f"Stop: {stop_name}")

    rows = []
    for p in predictions:
        rows.append([
            p.get("RouteID", ""),
            p.get("DirectionText", ""),
            f"{p.get('Minutes', '?')} min",
            p.get("VehicleID", ""),
        ])
    print_table(["Route", "Direction", "ETA", "Vehicle"], rows)


def menu(client: WmataClient) -> None:
    while True:
        print()
        stop_id = prompt("Enter 7-digit Stop ID (or 'back')")
        if not stop_id or stop_id.lower() == "back":
            break

        if not stop_id.isdigit():
            print_error("Stop ID must be numeric (7 digits).")
            continue

        try:
            print_subheader(f"Bus Predictions for Stop {stop_id}")
            data = _fetch_predictions(client, stop_id)
            _display_predictions(data)
        except WmataError as e:
            print_error(str(e))

        pause()
