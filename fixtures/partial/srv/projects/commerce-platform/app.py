"""Synthetic ledger API entry point; no network listener is started by this fixture."""
from pathlib import Path


def load_config():
    return Path("/srv/scenario/etc/brood/app.conf").read_text(encoding="utf-8")


if __name__ == "__main__":
    print("Brood ledger fixture", len(load_config()))
