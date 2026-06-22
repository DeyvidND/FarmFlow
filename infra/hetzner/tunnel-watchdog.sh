#!/usr/bin/env bash
# Cron watchdog: restart cloudflared if the tunnel stops being ready.
# cloudflared exposes /ready on the metrics port (127.0.0.1:2000) — 200 when at
# least one edge connection is up, non-200/unreachable otherwise.
if ! curl -sf -m 6 http://127.0.0.1:2000/ready -o /dev/null; then
  echo "$(date '+%F %T') tunnel /ready FAILED -> restarting cloudflared"
  cd /opt/fermeribg && docker compose restart cloudflared
fi
