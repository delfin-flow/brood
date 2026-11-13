# What this box is for

The Brood operations node runs the internal ledger API and a small field-tools workspace. It contains synthetic fixture data only.

## Ownership and contacts

- Service owner: Operations team (`ops@example.invalid`)
- Platform contact: Keeper (`keeper@example.invalid`)
- Escalation: the on-call rota in `on-call.md`

## Current operating posture

- Persistent data is mounted at `/srv/data`.
- The only application configuration is `etc/brood/app.conf`.
- Scheduled backup rotation is declared in `etc/cron.d/backup-rotation` and this runbook.
