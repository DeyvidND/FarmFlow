# Caddy + the Cloudflare DNS plugin, so ACME can solve DNS-01 for a PUBLIC
# Let's Encrypt cert on origin-api.fermeribg.com WITHOUT any inbound port 80.
# That lets the host firewall restrict 443 to Cloudflare IP ranges only — the
# direct (non-tunnel) origin the storefront Workers fetch, kept hidden from the
# general internet. The official caddy image ships no DNS providers, hence xcaddy.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
