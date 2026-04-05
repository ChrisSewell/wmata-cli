"""Terminal formatting helpers: colors, tables, display utilities."""

from tabulate import tabulate

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"

LINE_COLORS = {
    "RD": "\033[91m",   # bright red
    "BL": "\033[94m",   # bright blue
    "YL": "\033[93m",   # bright yellow
    "OR": "\033[33m",   # orange (dark yellow)
    "GR": "\033[92m",   # bright green
    "SV": "\033[37m",   # silver/white
}

LINE_NAMES = {
    "RD": "Red",
    "BL": "Blue",
    "YL": "Yellow",
    "OR": "Orange",
    "GR": "Green",
    "SV": "Silver",
}


def colorize(text: str, line_code: str) -> str:
    """Wrap text in the ANSI color for a WMATA line code."""
    color = LINE_COLORS.get(line_code, "")
    if not color:
        return text
    return f"{color}{text}{RESET}"


def print_table(headers: list[str], rows: list[list], tablefmt: str = "simple_grid") -> None:
    """Print a formatted table to stdout."""
    if not rows:
        print(f"\n  {DIM}(no data){RESET}\n")
        return
    print()
    print(tabulate(rows, headers=headers, tablefmt=tablefmt))
    print()


def render_table(headers: list[str], rows: list[list], tablefmt: str = "simple_grid") -> str:
    """Return a formatted table as a string (for testing)."""
    if not rows:
        return "(no data)"
    return tabulate(rows, headers=headers, tablefmt=tablefmt)


def print_header(text: str) -> None:
    """Print a bold section header."""
    width = max(40, len(text) + 4)
    bar = "=" * width
    print(f"\n{BOLD}{bar}{RESET}")
    print(f"{BOLD}  {text}{RESET}")
    print(f"{BOLD}{bar}{RESET}")


def print_subheader(text: str) -> None:
    """Print a secondary header."""
    print(f"\n{BOLD}--- {text} ---{RESET}")


def format_min(value) -> str:
    """Format a rail prediction Min value for display.

    Possible inputs: numeric string, "ARR", "BRD", "---", "", None.
    """
    if value is None or value == "":
        return DIM + "--" + RESET
    s = str(value).strip()
    if s == "ARR":
        return f"\033[92m{BOLD}ARR{RESET}"
    if s == "BRD":
        return f"\033[93m{BOLD}BRD{RESET}"
    if s == "---":
        return DIM + "---" + RESET
    try:
        mins = int(s)
        if mins <= 2:
            return f"\033[91m{BOLD}{mins} min{RESET}"
        return f"{mins} min"
    except ValueError:
        return s


def print_error(msg: str) -> None:
    """Print an error message in red."""
    print(f"\n\033[91m  Error: {msg}{RESET}\n")


def print_info(msg: str) -> None:
    """Print an informational message."""
    print(f"\n  {msg}\n")
