# Machine-wide assistant guidance

- This host is the Brood operations node for internal sample services.
- The canonical application configuration is `etc/brood/app.conf` within the mounted scenario tree.
- Keep service inventory, scheduled jobs, and restore evidence current in `home/keeper/cockpit/`.
- Do not change host state without an explicit approval and a documented rollback.
- Disk headroom target: keep every persistent filesystem below 80% used.
