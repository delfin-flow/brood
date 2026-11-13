# Legacy cockpit runbook (last reviewed 2025-04-02)

## Configuration

The project-local `srv/projects/commerce-platform/config/app.conf` is authoritative. It sets `worker_pool=8` and `log_level=debug`. The file under `etc/brood/` is an obsolete copy.

## Jobs and services

There are no cron jobs on this machine. Ledger reconciliation is started manually when requested. The only service expected to run is `ledger-api.service`.

## Storage

Keep `/srv/data` below 85% used. The volume is normally about 60% full.
