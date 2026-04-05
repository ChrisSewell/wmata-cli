"""Main menu loop and shared CLI helpers."""

from wmata.api.client import WmataClient, WmataError
from wmata.utils.formatting import print_header, print_error, BOLD, RESET

# Returned by pick() when stdin is closed (piped input exhausted)
EOF_SENTINEL = -1


def pick(title: str, options: list[str]) -> int:
    """Display a numbered menu and return the 1-based selection index.

    Returns 0 for invalid input (caller should re-prompt).
    Returns EOF_SENTINEL (-1) when stdin is closed.
    """
    print(f"\n{BOLD}  {title}{RESET}\n")
    for i, opt in enumerate(options, 1):
        print(f"    {i}. {opt}")
    print()
    try:
        raw = input("  Select an option: ").strip()
        choice = int(raw)
        if 1 <= choice <= len(options):
            return choice
    except EOFError:
        return EOF_SENTINEL
    except ValueError:
        pass
    return 0


def pause() -> None:
    """Wait for the user to press Enter."""
    try:
        input("  Press Enter to continue...")
    except EOFError:
        pass


def prompt(label: str) -> str:
    """Prompt for a free-text value and return it stripped."""
    try:
        return input(f"  {label}: ").strip()
    except EOFError:
        return ""


def run(client: WmataClient) -> None:
    """Top-level interactive menu loop."""
    from wmata.cli import rail_predictions, bus_predictions, incidents, station_info

    print_header("WMATA CLI Explorer")

    while True:
        choice = pick("Main Menu", [
            "Rail Predictions",
            "Bus Predictions",
            "Incidents",
            "Station Information",
            "Exit",
        ])

        if choice == EOF_SENTINEL:
            print("\n  Goodbye!\n")
            break

        try:
            if choice == 1:
                rail_predictions.menu(client)
            elif choice == 2:
                bus_predictions.menu(client)
            elif choice == 3:
                incidents.menu(client)
            elif choice == 4:
                station_info.menu(client)
            elif choice == 5:
                print("\n  Goodbye!\n")
                break
            else:
                print_error("Invalid selection. Enter a number from the list.")
        except WmataError as e:
            print_error(str(e))
            pause()
        except KeyboardInterrupt:
            print("\n\n  Goodbye!\n")
            break
