# Operations runbook

## Daily checks

1. Review `df -h` and investigate persistent filesystems above 80%.
2. Confirm `ledger-api.service` is active.
3. Check the documented backup rotation job and its latest restore-test record.
4. Review project status before proposing changes.

## Configuration

`etc/brood/app.conf` is the single canonical application configuration. Project directories do not contain alternate live copies.

## Scheduled work

`etc/cron.d/backup-rotation` performs the documented nightly archive rotation at 01:15. Do not add ad-hoc schedules.

## Recovery

The backup archive listed by `backup-audit.txt` was restored to a scratch location on 2026-10-31 and passed checksum and application smoke checks. Do not treat archive presence alone as proof of recoverability.
