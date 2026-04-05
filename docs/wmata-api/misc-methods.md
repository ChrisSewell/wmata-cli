# Misc Methods

**Base URL**: `https://api.wmata.com/Misc`
**Description**: Simple utility methods not tied to any backend WMATA data providers.

[Back to index](README.md)

---

## Endpoints at a Glance

| Operation | Path |
|---|---|
| [Validate](#validate) | `/Validate` |

---

## Validate

Verifies that an API key is valid and active. Returns a successful response for valid keys and an error for invalid ones.

This is useful for checking key health at application startup or in monitoring scripts without incurring the overhead of a data-fetching call.

### Request

```
GET /Misc/Validate
```

No query parameters. The API key is passed via the `api_key` header (or query string) as with all other WMATA endpoints.

### Response

| Status | Meaning |
|---|---|
| `200` | Key is valid. |
| `401` | Key is invalid, expired, or missing. |

A `200` response typically returns an empty or minimal body. The value is in the status code itself.

### Example Request

```bash
curl -s -o /dev/null -w "%{http_code}" \
  "https://api.wmata.com/Misc/Validate" \
  -H "api_key: YOUR_KEY"
```

If the key is valid, this prints `200`. If invalid, it prints `401`.

### Example — Programmatic Validation (Python)

```python
import requests

response = requests.get(
    "https://api.wmata.com/Misc/Validate",
    headers={"api_key": "YOUR_KEY"}
)

if response.status_code == 200:
    print("API key is valid")
else:
    print(f"API key is invalid (HTTP {response.status_code})")
```

---

## Common Pitfalls

1. **Don't poll Validate in a tight loop** — It counts against rate limits like any other endpoint. Use it for startup checks or periodic health pings, not per-request validation.
2. **No data payload** — The response body is minimal/empty. Check the HTTP status code, not the body.
3. **Same auth mechanism** — The key can be passed as a header (`api_key`) or query parameter (`?api_key=`), consistent with all other WMATA endpoints.
