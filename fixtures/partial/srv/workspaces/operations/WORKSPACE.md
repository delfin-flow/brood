# Operations workspace

**Owner:** Operations team  
**Purpose:** Maintain the Brood ledger API and collector-facing runbooks.  
**Status:** Active; reviewed 2026-11-10.

## Boundaries

- Service unit: `etc/systemd/system/ledger-api.service`
- Configuration: `etc/brood/app.conf`
- Scheduled work: `etc/cron.d/backup-rotation`
- Data: synthetic records only under `srv/data/`

## Working agreements

- Prefer read-only discovery before proposing changes.
- Every change proposal includes impact, approval point, and rollback command.
- Do not edit generated evidence packets.

## Current work

- [x] Verify restore record for the nightly fixture archive.
- [ ] Review quarterly dependency updates.
