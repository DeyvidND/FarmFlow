# ФермериБГ core — Hetzner box (no Dokploy)

The production core (API + Postgres + Redis + farmer panel + super-admin) runs as
plain `docker compose` on a single Hetzner Cloud VM. Public ingress is a Cloudflare
Tunnel (outbound) — no host ports, no inbound TLS. The public storefronts are
separate (Cloudflare Workers / their own repos) and are NOT on this box.

These files are the source of truth for the box config (kept here for
version-control + disaster recovery — the live copies sit in `/opt/fermeribg/` on
the box). Secrets are NOT here: `.env` lives only on the box (600, root).

## Box

- Hetzner CX23 (2 vCPU / 4 GB / 40 GB), Ubuntu, Helsinki.
- Stack at `/opt/fermeribg/`. App images pulled from GHCR (`farmflow-{api,web,admin}`).
- Deploy: push to `main` → `.github/workflows/deploy.yml` builds the images and
  SSHes to the box to `docker compose pull && up`. The compose file itself is NOT
  synced by CI — update it by copying the version here to the box.

## Files

| File | On box | Purpose |
| --- | --- | --- |
| `docker-compose.yml` | `/opt/fermeribg/docker-compose.yml` | the stack (pg, redis, api, web, admin, cloudflared) |
| `env.example` | `/opt/fermeribg/.env` (filled) | env template; real values copied from the old Dokploy env |
| `daemon.json` | `/etc/docker/daemon.json` | Docker log rotation (10m × 3) |
| `backup.sh` | `/opt/fermeribg/backup.sh` | pg_dump → local + private R2 `backups` bucket |
| `tunnel-watchdog.sh` | `/opt/fermeribg/tunnel-watchdog.sh` | restart cloudflared if the tunnel `/ready` drops |

Cron (`/etc/cron.d/`): `fermeribg-backup` (daily 03:00), `fermeribg-tunnel-watchdog`
(every 2 min).

## Rebuild a box from scratch

1. New Hetzner VM (Ubuntu), add SSH key. Harden: `PasswordAuthentication no`, ufw
   allow only 22, `apt upgrade` + unattended-upgrades.
2. Add swap (4G) and install Docker + compose.
3. `scp` `daemon.json` → `/etc/docker/daemon.json`; `systemctl restart docker`.
4. `mkdir -p /opt/fermeribg`; `scp` `docker-compose.yml`, `backup.sh`,
   `tunnel-watchdog.sh` there; `chmod +x *.sh`.
5. Copy `env.example` → `/opt/fermeribg/.env` and fill it (DB/Redis passwords fresh;
   `ENCRYPTION_KEY` + `JWT_SECRET` MUST match the data being restored; rest from the
   old env).
6. `docker login ghcr.io -u DeyvidND` (PAT with read:packages).
7. `docker compose up -d postgres redis`; restore the latest dump from R2
   (`rclone copy r2:backups/hetzner/<latest>.dump .` → `docker cp` →
   `pg_restore -U farmflow -d farmflow`).
8. `docker compose up -d` (all). Create a Cloudflare Tunnel, put its token in
   `CF_TUNNEL_TOKEN`, add Public Hostnames api/app/admin → `http://{api,web,admin}:{3000,3000,3002}`.
9. Install the two cron files; configure rclone (`/root/.config/rclone/rclone.conf`,
   R2 creds, `region = auto`, `no_check_bucket = true`).

## Notes

- cloudflared forced to `http2` transport (env `TUNNEL_TRANSPORT_PROTOCOL`) — the
  default QUIC was silently dropping the tunnel.
- Redis capped at 1 GB (`noeviction`); Postgres is uncapped (grows on disk).
