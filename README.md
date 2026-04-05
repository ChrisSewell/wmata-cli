# WMATA CLI Explorer

An interactive command-line tool for exploring Washington Metropolitan Area Transit Authority (WMATA) data — real-time train and bus predictions, service incidents, and station information.

## Prerequisites

- Python 3.8+
- A free WMATA API key

## Obtaining a WMATA API Key

1. Go to <https://developer.wmata.com> and create a free account.
2. After signing in, navigate to **Products** and subscribe to the **Default Tier** (free).
3. Go to your **Profile** page to find your primary and secondary API keys.

The free tier allows 10 calls/second and 50,000 calls/day, which is more than enough for interactive use.

## Setup

1. Clone or download this project.

2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Copy the environment template and add your API key:

   ```bash
   cp .env_template .env
   ```

   Edit `.env` and replace `your_api_key_here` with your actual WMATA API key:

   ```
   WMATA_API_KEY=your_actual_key_here
   ```

## Usage

```bash
python main.py
```

You will be greeted with an interactive menu:

```
========================================
        WMATA CLI Explorer
========================================

  1. Rail Predictions
  2. Bus Predictions
  3. Incidents
  4. Station Information
  5. Exit

Select an option [1-5]:
```

### Rail Predictions

Look up real-time next-train arrivals at any Metrorail station. You can enter a station code directly (e.g., `A01` for Metro Center) or search by station name.

### Bus Predictions

Get real-time next-bus arrival times for any Metrobus stop by entering the 7-digit stop ID.

### Incidents

View current service disruptions:
- **Rail Incidents** — delays and alerts on Metrorail lines
- **Bus Incidents** — delays on Metrobus routes
- **Elevator/Escalator Outages** — out-of-service units at stations

### Station Information

Explore the Metrorail system:
- List all rail lines
- Search stations by name
- View station details (address, lines served, coordinates)
- Look up fares and travel time between two stations
- Check parking availability and costs
- View station opening times and first/last trains

## API Documentation

Detailed endpoint documentation for all WMATA API families is available in [`docs/wmata-api/`](docs/wmata-api/README.md).

## License

This project is for educational and personal use. WMATA data is subject to the [WMATA Developer License Agreement](https://developer.wmata.com/license).
