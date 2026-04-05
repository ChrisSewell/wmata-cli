"""Incidents CLI menu."""

import textwrap

from wmata.api.client import WmataClient
from wmata.api import endpoints
from wmata.cli.app import pick, pause, prompt, EOF_SENTINEL
from wmata.utils.formatting import (
    print_subheader, print_table, print_info, colorize,
)


def _wrap(text: str, width: int = 60) -> str:
    """Wrap long text for table cells."""
    if not text:
        return ""
    return "\n".join(textwrap.wrap(text, width))


def _rail_incidents(client: WmataClient) -> None:
    print_subheader("Rail Incidents")
    data = client.get(endpoints.INCIDENTS_RAIL)
    items = data.get("Incidents", [])

    if not items:
        print_info("No active rail incidents.")
        return

    rows = []
    for inc in items:
        lines_raw = inc.get("LinesAffected", "")
        line_codes = [c.strip() for c in lines_raw.split(";") if c.strip()]
        lines_display = ", ".join(colorize(c, c) for c in line_codes) if line_codes else "--"
        rows.append([
            lines_display,
            inc.get("IncidentType", ""),
            _wrap(inc.get("Description", "")),
        ])
    print_table(["Lines", "Type", "Description"], rows)


def _bus_incidents(client: WmataClient) -> None:
    print_subheader("Bus Incidents")
    route = prompt("Filter by route (leave blank for all)")
    params = {}
    if route:
        params["Route"] = route.upper()

    data = client.get(endpoints.INCIDENTS_BUS, params=params if params else None)
    items = data.get("BusIncidents", [])

    if not items:
        print_info("No active bus incidents.")
        return

    rows = []
    for inc in items:
        routes = ", ".join(inc.get("RoutesAffected", []))
        rows.append([
            routes,
            inc.get("IncidentType", ""),
            _wrap(inc.get("Description", "")),
        ])
    print_table(["Routes", "Type", "Description"], rows)


def _elevator_incidents(client: WmataClient) -> None:
    print_subheader("Elevator/Escalator Outages")
    code = prompt("Filter by station code (leave blank for all)")
    params = {}
    if code:
        params["StationCode"] = code.upper()

    data = client.get(endpoints.INCIDENTS_ELEVATOR, params=params if params else None)
    items = data.get("ElevatorIncidents", [])

    if not items:
        print_info("No active elevator/escalator outages.")
        return

    rows = []
    for inc in items:
        est_return = inc.get("EstimatedReturnToService") or "--"
        rows.append([
            inc.get("StationName", ""),
            inc.get("UnitName", ""),
            inc.get("UnitType", ""),
            _wrap(inc.get("SymptomDescription", ""), 40),
            est_return,
        ])
    print_table(["Station", "Unit", "Type", "Symptom", "Est. Return"], rows)


def menu(client: WmataClient) -> None:
    while True:
        choice = pick("Incidents", [
            "Rail Incidents",
            "Bus Incidents",
            "Elevator/Escalator Outages",
            "Back",
        ])

        if choice == 1:
            _rail_incidents(client)
            pause()
        elif choice == 2:
            _bus_incidents(client)
            pause()
        elif choice == 3:
            _elevator_incidents(client)
            pause()
        elif choice in (4, EOF_SENTINEL):
            break
