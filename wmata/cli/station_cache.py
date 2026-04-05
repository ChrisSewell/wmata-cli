"""Lazy-loaded station list cache shared across CLI modules."""

from wmata.api.client import WmataClient
from wmata.api import endpoints

_stations: list[dict] | None = None


def get_stations(client: WmataClient) -> list[dict]:
    """Fetch and cache the full station list (called once per session)."""
    global _stations
    if _stations is None:
        data = client.get(endpoints.RAIL_STATIONS)
        _stations = data.get("Stations", [])
    return _stations


def search_stations(client: WmataClient, query: str) -> list[dict]:
    """Return stations whose name contains the query (case-insensitive)."""
    q = query.lower()
    return [s for s in get_stations(client) if q in s.get("Name", "").lower()]


def resolve_station_code(client: WmataClient, code: str) -> dict | None:
    """Find a station by exact code match."""
    code_upper = code.upper().strip()
    for s in get_stations(client):
        if s.get("Code") == code_upper:
            return s
    return None
