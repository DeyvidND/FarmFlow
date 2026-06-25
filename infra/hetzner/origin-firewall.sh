#!/usr/bin/env bash
# Restrict the Caddy origin (published :443 tcp+udp) to Cloudflare IP ranges only.
#
# Docker publishes container ports via its OWN iptables chains and BYPASSES ufw —
# the host firewall has no effect on a Docker-published port. The supported hook
# for admin filtering of container ingress is the DOCKER-USER chain. We match the
# packet source against an ipset of the Cloudflare ranges and DROP everything else
# on :443, so only Cloudflare Worker egress (and the CF edge) can reach the direct
# origin-api.fermeribg.com origin; the public IP stays unreachable to the rest of
# the internet. The api.fermeribg.com tunnel is unaffected (it is outbound-only).
#
# Idempotent: safe to re-run. Run on boot via the origin-firewall.service unit
# (After=docker.service) so the rules survive reboots — Docker rebuilds DOCKER-USER
# empty on each start.
set -euo pipefail

IFACE=eth0

# Cloudflare published ranges (https://www.cloudflare.com/ips). Refresh if CF changes
# them (rare); re-run this script after editing.
CF4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
CF6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

# (re)build the ipsets
ipset create -exist cf4 hash:net family inet
ipset create -exist cf6 hash:net family inet6
ipset flush cf4
ipset flush cf6
for r in $CF4; do ipset add -exist cf4 "$r"; done
for r in $CF6; do ipset add -exist cf6 "$r"; done

# ensure exactly one copy of a DOCKER-USER rule (delete any existing, then insert)
ensure() { # $1=iptables|ip6tables  $2..=rule spec
  local cmd="$1"; shift
  while "$cmd" -C DOCKER-USER "$@" 2>/dev/null; do "$cmd" -D DOCKER-USER "$@"; done
  "$cmd" -I DOCKER-USER "$@"
}

# Drop non-Cloudflare sources hitting :443 (tcp + udp/http3) on the public iface.
ensure iptables  -i "$IFACE" -p tcp --dport 443 -m set ! --match-set cf4 src -j DROP
ensure iptables  -i "$IFACE" -p udp --dport 443 -m set ! --match-set cf4 src -j DROP
ensure ip6tables -i "$IFACE" -p tcp --dport 443 -m set ! --match-set cf6 src -j DROP
ensure ip6tables -i "$IFACE" -p udp --dport 443 -m set ! --match-set cf6 src -j DROP

echo "origin-firewall applied: $(ipset save cf4 | grep -c '^add cf4') v4 + $(ipset save cf6 | grep -c '^add cf6') v6 CF ranges"
iptables -L DOCKER-USER -n --line-numbers | grep -E 'match-set|Chain' || true
