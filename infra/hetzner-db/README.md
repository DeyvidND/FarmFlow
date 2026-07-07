# DB box (farmflow-db)

Dedicated Postgres box: Hetzner CX23, hel1, public `46.62.141.243`, private
`10.0.0.3` on the `fermeribg-net` private network (app box is `10.0.0.2`).

These files are **reference copies** of what runs on the box at
`/opt/fermeribg/` — CI does NOT sync them (deploys only touch the app box).
If you change them here, `scp` them to the box by hand and `docker compose up -d`.

- `docker-compose.yml` — postgres 16 (published on the private IP only) +
  Uptime Kuma (UI on `127.0.0.1:3001` / `10.0.0.3:3001`, never public).
- `backup.sh` — hourly `pg_dump -Fc` via `/etc/cron.d/fermeribg-backup`
  (`0 * * * *`), keeps 48 local dumps (2 days) + 30 days in the private R2
  `backups` bucket (`hetzner/` prefix). Needs `rclone` ≥ ~1.7x — the Ubuntu
  apt package (1.60) fails against R2 with `501 NotImplemented`; install via
  https://rclone.org/install.sh.

Secrets: `/opt/fermeribg/.env` on the box holds `POSTGRES_PASSWORD` (same value
as the app box `.env`); `/root/.config/rclone/rclone.conf` holds the R2 creds.
Neither is in git.

Kuma UI access: `ssh -i ~/.ssh/fermeribg -L 3001:127.0.0.1:3001 root@46.62.141.243`
then open http://localhost:3001.
