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
- Deploy: push to `main` → `.github/workflows/deploy.yml` builds the images, `scp`s
  this `docker-compose.yml` to the box, then SSHes to `docker compose pull && up`. So
  service/topology changes (e.g. the `econt` service) ship with a normal deploy — no
  manual copy. Only the box's `.env` (secrets) and the Cloudflare tunnel are by hand.

## Files

| File | On box | Purpose |
| --- | --- | --- |
| `docker-compose.yml` | `/opt/fermeribg/docker-compose.yml` | the stack (pg, redis, api, web, admin, econt, delivery-web, caddy, cloudflared) |
| `env.example` | `/opt/fermeribg/.env` (filled) | env template; real values copied from the old Dokploy env |
| `daemon.json` | `/etc/docker/daemon.json` | Docker log rotation (10m × 3) |
| `backup.sh` | `/opt/fermeribg/backup.sh` | pg_dump → local + private R2 `backups` bucket |
| `tunnel-watchdog.sh` | `/opt/fermeribg/tunnel-watchdog.sh` | restart cloudflared if the tunnel `/ready` drops |
| `caddy/` | `/opt/fermeribg/caddy/` | Dockerfile (xcaddy + cloudflare DNS) + Caddyfile for the direct origin |
| `origin-firewall.sh` | `/opt/fermeribg/origin-firewall.sh` | locks the origin `:443` to Cloudflare IPs (DOCKER-USER + ipset) |
| `origin-firewall.service` | `/etc/systemd/system/origin-firewall.service` | re-applies the lockdown on boot / docker restart |

Cron (`/etc/cron.d/`): `fermeribg-backup` (daily 03:00), `fermeribg-tunnel-watchdog`
(every 2 min). Systemd: `origin-firewall.service` (oneshot, `PartOf=docker.service`).

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
   `CF_TUNNEL_TOKEN`, add Public Hostnames api/app/admin → `http://{api,web,admin}:{3000,3000,3002}`
   and dostavki → `http://delivery-web:3003` (see the delivery section below).
9. Install the two cron files; configure rclone (`/root/.config/rclone/rclone.conf`,
   R2 creds, `region = auto`, `no_check_bucket = true`).

## Standalone delivery app — `dostavki.fermeribg.com`

A second app process from the **same `farmflow-api` image**, started with a command
override (`node dist/main.econt.js`) instead of a new image. It serves the producer
delivery surface (order-less Econt/Speedy shipments, COD-risk, cheapest-quote, bulk
import) + a small Alpine UI at `/app`, on port **3100**.

Already wired in `docker-compose.yml` as the `econt` service:
- **`APP_ROLE=web`** — the Econt/Speedy 30-min refresh crons run ONLY in the `api`
  container. Do not remove this, or both containers double-run the courier crons.
- **No published host port** — the tunnel reaches it over the compose network as
  `econt:3100`.
- **`depends_on: api`** — `api` (`main.js`) runs the Drizzle migrations on boot; the
  delivery app does not, so it must start after `api`.
- Reads the shared `.env` (DB/Redis/JWT/ENCRYPTION_KEY) plus `CORS_ORIGIN_ECONT`,
  and the optional `OPENAI_API_KEY` / `NEKOREKTEN_API_KEY` / `SPEEDY_DEFAULT_SERVICE_ID`.

Delivery-account onboarding is **invite-link based**: the super-admin creates the
account with no password, the `api` mints a 7-day set-password link pointing at
`DELIVERY_PUBLIC_URL` (default `https://dostavki.fermeribg.com`, set inline on the
`api` service in compose) and emails it; the operator can also copy it. The invitee
opens it and sets their own password via the public `POST /auth/reset-password` on
the delivery app.

**To bring it live (operator):**
1. **Merge to `main`.** CI builds the api image, `scp`s this compose to the box, and
   runs `docker compose pull … econt && up -d` — the `econt` service starts. No manual
   copy. `CORS_ORIGIN_ECONT` is set inline in compose, so it boots with **no `.env`
   change** (AI/COD-risk just stay degraded until their keys are added — see below).
2. **Connect the tunnel** (the one manual step — token tunnel, dashboard-managed): in
   the Cloudflare Tunnel, add a Public Hostname
   `dostavki.fermeribg.com` → `http://delivery-web:3003` (the Next panel; it proxies
   to `econt:3100` internally via /bff). The `econt` service is now API-only.
   DNS auto-creates.
3. Verify: `https://dostavki.fermeribg.com/app` loads; `GET /shipping/compare` without
   a token returns 401 (route mounted + guarded).
4. _Optional, later:_ add `OPENAI_API_KEY` / `NEKOREKTEN_API_KEY` / `SPEEDY_DEFAULT_SERVICE_ID`
   to the box `.env` and `docker compose up -d econt` to enable AI validation / COD-risk.

⚠️ Before any farm relies on a carrier, live-verify the docs-built fields (Speedy
`serviceId`/price/EUR/validate/track/payments; Econt create/courier/profiles; nekorekten
report shapes) — see `docs/superpowers/specs/2026-06-24-*` and the audit memo.

## Direct non-tunnel API origin — `origin-api.fermeribg.com`

The Astro storefronts are Cloudflare Workers; they fetch the backend during SSR.
When that fetch targets `api.fermeribg.com` (served via the CF tunnel, same CF
account), the Worker→origin subrequest **hairpins the tunnel through the CF edge
and intermittently black-holes** (~75% hang ~16s then return empty; `wrangler tail`
shows 0ms-CPU / full-wall / outcome=canceled). External clients are unaffected —
only Worker egress. The fix gives the API a public origin Workers reach **directly**,
bypassing the tunnel:

- **`caddy` service** (custom image, `caddy/Dockerfile` = xcaddy + `caddy-dns/cloudflare`)
  `reverse_proxy api:3000`, publishes `:443`. Public **Let's Encrypt** cert via ACME
  **DNS-01** (`CF_DNS_API_TOKEN`, Zone:DNS:Edit) — no port 80, auto-renew. A CF Origin
  CA cert would NOT work (Workers validate against public CAs).
- **DNS**: `origin-api` A → the box IP, **DNS-only (grey cloud)** — straight to the
  box, no edge, no hairpin.
- **Firewall**: `:443` is locked to **Cloudflare IP ranges only** (`origin-firewall.sh`:
  ipset + a `DOCKER-USER` rule — Docker-published ports BYPASS ufw, so the host
  firewall is useless here; DOCKER-USER is the supported hook). Re-applied on boot /
  docker restart by `origin-firewall.service`. Origin IP stays hidden from the
  general internet; only CF Worker egress gets through.
- The `api.fermeribg.com` tunnel is **untouched** (panel/admin + a fallback). The
  chaika SWR edge-cache stays as defense-in-depth.

Each storefront Worker sets build var **`PUBLIC_API_BASE=https://origin-api.fermeribg.com`**
(build-time inlined → needs a Worker rebuild, not just a binding). **Future storefront
provisioning (the `new-storefront` skill / `SF_*` build vars) MUST use
`origin-api.fermeribg.com`, NOT `api.fermeribg.com`, for the API base.**

Rebuild-from-scratch additions: `apt install ipset`; `scp` `caddy/` + `origin-firewall.sh`
to `/opt/fermeribg/` and `origin-firewall.service` to `/etc/systemd/system/`; set
`CF_DNS_API_TOKEN` in `.env`; `docker compose up -d --build caddy`; create the grey-cloud
`origin-api` A record; `systemctl enable --now origin-firewall.service`.

## Notes

- cloudflared forced to `http2` transport (env `TUNNEL_TRANSPORT_PROTOCOL`) — the
  default QUIC was silently dropping the tunnel.
- Redis capped at 1 GB (`noeviction`); Postgres is uncapped (grows on disk).
