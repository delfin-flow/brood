"""Synthetic CSV importer marker."""

def normalize(row: dict[str, str]) -> dict[str, str]:
    return {key.strip().lower(): value.strip() for key, value in row.items()}
