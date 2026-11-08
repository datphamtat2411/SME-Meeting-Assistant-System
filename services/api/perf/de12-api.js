// k6 DE12 reproducible *read-only* API baseline. Never hardcode tokens or
// print URL signatures. Data-seeded HTTPS staging required; do NOT run in prod.
// Example: BASE_URL=https://staging.example.test BEARER_TOKEN=... \
//          MEETING_ID=... EXPORT_ID=... k6 run perf/de12-api.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
const base=__ENV.BASE_URL || '';
const token=__ENV.BEARER_TOKEN || '';
const meeting=__ENV.MEETING_ID || '';
const exportId=__ENV.EXPORT_ID || '';
if (!base.startsWith('https://') || !token || !meeting || !exportId)
  throw Error('HTTPS BASE_URL, BEARER_TOKEN, MEETING_ID and EXPORT_ID required');
export const options = {
  scenarios: { reads: { executor: 'constant-vus', vus: 8, duration: '2m' } },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:personal}': ['p(95)<1500'],
    'http_req_duration{endpoint:management}': ['p(95)<2000'],
    'http_req_duration{endpoint:status}': ['p(95)<2000']
  }
};
const headers={Authorization:'Bearer '+token, Accept:'application/json'};
export default function () {
  const operations=[
    ['personal','/api/v1/dashboard/me'],
    ['management','/api/v1/dashboard/management?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z'],
    ['status','/api/v1/exports/'+exportId],
    ['minutes','/api/v1/meetings/'+meeting+'/minutes']
  ];
  const [name,path]=operations[Math.floor(Math.random()*operations.length)];
  let response=http.get(base+path,{headers,tags:{endpoint:name}});
  check(response,{'authorized 2xx':r=>r.status>=200 && r.status<300});
  sleep(1);
}
