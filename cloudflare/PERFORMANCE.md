# Performance audit — 2026-11-09

Scope: the existing GitHub Pages store, customer portal, price administration and Cloudflare Messenger Worker. Baseline: Git revision `be2f0ce`. Public customer UI lives only on GitHub Pages; Cloudflare hosts backend APIs and admin tools.

| Hot path | Before | After |
| --- | --- | --- |
| Customer refresh with selected account | 2 API requests, 6 D1 binding calls | 1 snapshot request, 1 SQL query |
| Customer list or account endpoint used separately | 3 D1 binding calls | 1 SQL query; old endpoints remain compatible |
| Admin state | 5 serial D1 binding calls | 2 calls: authentication and a transaction batch containing 4 reads |
| Admin grant | 4 D1 binding calls including authentication | 2 calls: authentication and an atomic INSERT…SELECT with validation |
| Public catalog requests | Fetch and parse for every purchase | Parsed data cached for 30 seconds per isolate; simultaneous misses share one in-flight fetch |
| Duplicate verified admin webhook | Reverify through Meta Graph | Read deduplication marker first; no second Graph verification |
| Best matching candidate | Sort O(n log n), then filter | One pass O(n), preserving all ties and order |
| Admin customer/grant display | Repeated grant scans and account searches | Index accounts and grants in Maps: O(accounts + customers + grants) |
| Docs sync with unchanged credentials | Decrypt, encrypt and replace ciphertext | Decrypt and compare; preserve ciphertext, update heartbeat and ordered state |

Price validation and formatting now share `shared/prices-core.mjs` between the browser and Worker. `/access` maps to `/admin`, `/khoa` to `/block`, and `/sendpayment` to the existing `/help` payment handler. Only canonical commands appear in the common menu. HTML catalog parsing was unused after JSON pricing and has been removed.

The frontend rebuilds service cards only when their visible data changes, uses one delegated click handler, reuses date formatters, aborts superseded requests, rejects late responses after hiding/logout, and runs one polling timer after each completed request. Credential changes re-mask passwords. Polling remains every 15 seconds while visible. Cross-origin preflight permission may be reused for 600 seconds; authenticated responses themselves always remain private/no-store and recheck grants and active state in SQL.

Webhook enqueues run concurrently for up to 8 independent customers, preserving event order within each customer. All started writes settle before any retry response. Existing Durable Object coordination, customer-message guards and Page-message verification remain in place.

New indexes cover customer-session revocation, service lookup and expired rate-limit cleanup. CryptoKey imports are reused in a bounded cache for the current deployment key; plaintext credentials and permissions are not cached. Catalog caching stores public prices only, has no stale-on-error fallback, and is per isolate, not a global freshness guarantee. A successful refresh can be reused for up to 30 seconds. Cold isolates and expired caches still fetch the source. Google Apps Script retains its one-minute schedule and existing OAuth scopes.

## Verification

```powershell
node cloudflare/build.mjs
node --test cloudflare/tests/bot.test.mjs cloudflare/tests/customer.test.mjs cloudflare/tests/portal.test.mjs
node cloudflare/tests/performance-check.mjs
```

Differential comparison: 197 query strings across the actual 47 available catalog items, comparing both `findProduct` and `refineOptions` against the baseline. Results matched. Local Node CPU median was 0.884 ms → 0.184 ms per lookup, about 4.81× faster (five warmed samples; machine dependent). This is CPU time, not a production network-latency promise.

Regression coverage includes grant isolation, no-grant sessions, account deactivation, expiry, manual blocks, session expiry, CORS/admin separation, reordered and invalid Docs sync, unchanged ciphertext, deduplicated commands, catalog concurrency/failure recovery, linear-selection ties, bounded webhook fan-out and late browser responses. The D1 adapter counts actual binding calls; SQLite execution uses a local Python bridge, so its wall time is not a D1 latency benchmark.

`tests/live-performance.mjs` is an explicit production check using temporary synthetic records, hidden bootstrap configuration on stdin and an `after` signal following deployment. It compares sequential customer-refresh requests before/after, checks GitHub bearer auth and revocation, and verifies removed Worker UI routes. It sends no Messenger messages. Remove the reported synthetic IDs from D1 after completion. Six samples per version describe this client's network conditions and are not production p95 statistics. No Chrome DevTools trace tool was available for this audit; browser race behavior is verified with a DOM test harness.

Production smoke result: median refresh 1,268 ms before → 235 ms after (six measured samples per version, one warm-up; before range 1,227–1,415 ms, after 224–398 ms). This measures the old two-request sequence against the new snapshot from the same machine using a synthetic account, includes network variation, and excludes browser CORS preflight. GitHub bearer auth, the 600-second preflight permission, immediate block, and 404 responses for the removed Worker customer UI all passed. The existing Google Docs integration continued updating its heartbeat without a sync error after deployment.
