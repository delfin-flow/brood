# Global instructions for agents

- Treat `etc/brood/app.conf` as the sole authoritative runtime configuration; do not use project-local copies.
- This host is a production-simulated wholesale invoicing node; ledger reconciliation is business-critical.
- Persistent filesystems must remain below 80% used; investigate immediately above that threshold.
- Every scheduled job must be documented in the cockpit and every running service must have an owner and runbook.
- Backups are not accepted until an independent restore test is recorded.
- Propose changes only; wait for explicit approval before touching machine state.
