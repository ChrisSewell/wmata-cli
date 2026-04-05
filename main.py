"""WMATA CLI Explorer — interactive command-line interface for WMATA transit data."""

import os
import sys

from dotenv import load_dotenv


def main() -> None:
    load_dotenv()

    api_key = os.getenv("WMATA_API_KEY", "").strip()

    if not api_key or api_key == "your_api_key_here":
        print(
            "\n  WMATA API key not configured.\n\n"
            "  1. Copy .env_template to .env\n"
            "  2. Replace 'your_api_key_here' with your WMATA API key\n\n"
            "  Get a free key at: https://developer.wmata.com\n"
        )
        sys.exit(1)

    from wmata.api.client import WmataClient
    from wmata.utils.formatting import print_error, print_info

    client = WmataClient(api_key)

    print_info("Validating API key...")
    if not client.validate():
        print_error(
            "API key validation failed.\n"
            "  Check that your key in .env is correct and not expired.\n"
            "  Get a key at: https://developer.wmata.com"
        )
        sys.exit(1)

    from wmata.cli.app import run

    run(client)


if __name__ == "__main__":
    main()
