// k6 load test for the public storefront hot path.
//
// Targets the endpoints a real shopper hammers: the one-shot bootstrap bundle,
// the catalog, and the live-capacity slots feed. These are the cached, anonymous
// GETs that a storefront SSRs on every page view — the realistic concurrency
// load. (Checkout is a low-volume write; see the `checkout` scenario below, which
// is OFF by default because it reserves stock + creates real orders.)
//
// Run:
//   k6 run -e BASE=http://localhost:3001 -e SLUG=<tenant-slug> load/k6-public.js
//   k6 run -e BASE=... -e SLUG=... -e VUS=100 -e DURATION=1m load/k6-public.js
//
// Thresholds fail the run (non-zero exit) if p95 latency or error rate blow past
// budget — so this doubles as a CI smoke gate, not just an ad-hoc benchmark.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:3001';
const SLUG = __ENV.SLUG || 'demo';
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '30s';

const errors = new Rate('app_errors');

export const options = {
  scenarios: {
    // Ramp to VUS, hold, ramp down — a realistic traffic curve, not a wall.
    read_hot_path: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // Origin latency budget (excludes CDN — this hits the API directly).
    http_req_duration: ['p(95)<400', 'p(99)<1000'],
    app_errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

const paths = [
  `/public/${SLUG}/bootstrap`,
  `/public/${SLUG}/products`,
  `/public/${SLUG}/slots`,
];

export default function () {
  // Weight bootstrap heaviest — it's the first request every page makes.
  const path = paths[Math.random() < 0.6 ? 0 : 1 + Math.floor(Math.random() * 2)];
  const res = http.get(`${BASE}${path}`, { tags: { endpoint: path.split('/').pop() } });
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has body': (r) => r.body && r.body.length > 0,
  });
  errors.add(!ok);
  sleep(0.5 + Math.random()); // 0.5-1.5s think time between page views
}
