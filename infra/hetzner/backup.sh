#!/usr/bin/env bash
# ФермериБГ DB backup → local + R2 (private `backups` bucket, hetzner/ prefix).
# Runs daily via /etc/cron.d/fermeribg-backup. Logs to /var/log/fermeribg-backup.log.
set -euo pipefail

DIR=/opt/fermeribg/backups
mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/ff-${TS}.dump"

# pg_dump custom format (compressed) straight from the running container
docker exec fermeribg-postgres-1 pg_dump -U farmflow -d farmflow -Fc > "$OUT"

# upload to R2 (private)
rclone copy "$OUT" r2:backups/hetzner/ --no-check-dest

# retention: keep last 7 local, 30 days on R2
ls -1t "$DIR"/ff-*.dump 2>/dev/null | tail -n +8 | xargs -r rm -f
rclone delete r2:backups/hetzner/ --min-age 30d 2>/dev/null || true

echo "$(date '+%F %T') OK ff-${TS}.dump $(du -h "$OUT" | cut -f1)"
