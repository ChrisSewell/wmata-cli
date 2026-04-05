import requests

from wmata.api import endpoints


class WmataError(Exception):
    """Raised when a WMATA API call fails."""


class WmataClient:
    """Thin HTTP client for the WMATA REST API."""

    TIMEOUT = 15

    def __init__(self, api_key: str):
        self._session = requests.Session()
        self._session.headers["api_key"] = api_key

    def get(self, url: str, params: dict | None = None) -> dict:
        """Perform a GET request and return parsed JSON.

        Raises WmataError on HTTP errors, timeouts, or decode failures.
        """
        try:
            resp = self._session.get(url, params=params, timeout=self.TIMEOUT)
        except requests.ConnectionError:
            raise WmataError("Could not connect to the WMATA API. Check your internet connection.")
        except requests.Timeout:
            raise WmataError("Request timed out. The WMATA API may be slow — try again.")

        if resp.status_code == 401:
            raise WmataError("Invalid or expired API key (HTTP 401).")
        if resp.status_code == 400:
            try:
                body = resp.json()
            except ValueError:
                body = {"Message": resp.text}
            msg = body.get("Message", resp.text)
            raise WmataError(f"Bad request: {msg}")
        if not resp.ok:
            raise WmataError(f"WMATA API returned HTTP {resp.status_code}: {resp.text[:200]}")

        try:
            return resp.json()
        except ValueError:
            raise WmataError("WMATA API returned non-JSON response.")

    def validate(self) -> bool:
        """Return True if the API key is accepted by WMATA."""
        try:
            resp = self._session.get(endpoints.VALIDATE, timeout=self.TIMEOUT)
            return resp.status_code == 200
        except requests.RequestException:
            return False
