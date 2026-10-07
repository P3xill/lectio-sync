# Extension performance audit — 2 October 2026

Implemented and verified improvements across synchronization, parsing, storage, account discovery, Google Calendar, Safari messaging, hashing, date display, and the native EventKit bridge. Existing uncommitted work was preserved. The comparison baseline is a copy of the working source at the beginning of this audit, rather than Git HEAD.

## Measurements

Local medians of seven samples after warmup, alternating baseline/current order for the JavaScript measurements. Environment: v22.22.3, darwin/arm64. Times are milliseconds and “reduction” means less elapsed time, not a universal increase in application throughput.

| Fixture | Before (ms) | After (ms) | Reduction |
| --- | ---: | ---: | ---: |
| Background initialization | 1.900 | 0.377 | 80.1% |
| Small activity parse | 0.097 | 0.064 | 33.9% |
| Nested 1000-paragraph activity parse | 38.839 | 15.502 | 60.1% |
| 40-event schedule parse | 2.301 | 2.268 | 1.4% |
| 2000-snapshot storage patch | 43.356 | 22.551 | 48.0% |
| 500-event conversion, cold immutable-ID cache | 44.554 | 22.010 | 50.6% |
| 500-event conversion, warm immutable-ID cache | 40.665 | 10.686 | 73.7% |
| 13-week sync, one unique event, 15ms simulated Lectio latency | 251.014 | 94.352 | 62.4% |
| 13-week unchanged sync, 260 unique events, 15ms simulated Lectio latency | 917.700 | 717.855 | 21.8% |
| Display date formatting | 0.083 | 0.003 | 96.9% |
| Native parsing of 1,000 local date strings | 820.570 | 55.256 | 93.3% |

The sync fixtures simulate 15 ms latency per Lectio request and use mocked Google responses. The 260-event case prepopulates matching calendar events and exercises unchanged reconciliation, all linked activity reads, and local fixture setup. The one-event case isolates schedule-read overhead. Storage measurements include cloned in-memory fixtures, not real extension storage IPC. Startup measures evaluation of a bundled background script inside fresh Node VM contexts; it is not a browser startup profile. Small parser differences fluctuate between runs, so treat their percentage as noise-sensitive.

## Implemented changes

- Schedule reads run with at most four workers, linked activity reads with eight, event conversions with sixteen, and disjoint calendar windows with two. Results retain input order. Workers stop scheduling on failure and finish in-flight work before rejecting.
- Parser initialization is deferred until fetched HTML needs parsing. Schedule complexity checks run during the event traversal, ancestor stacks are reused, and single-class checks avoid splitting. Larger activity pages index subtree text once and cache text normalization with a bounded character budget. Small pages retain the simpler path.
- Safari discovers tabs once per sync and remembers a working tab per school. A failed preferred tab triggers fresh discovery. Responses remain freshly fetched and checked for school and UTF-8 size; ordinary small pages avoid an extra encoded copy.
- Activity requests are omitted when both activity title and description are disabled. Other settings and requested event contents retain their previous behavior.
- Immutable Google IDs are cached only in memory, keyed by the complete school/student/source tuple, capped at 2,000 entries. Fingerprints are recomputed from fresh event contents. SHA-256 input encoding and display formatters are reused.
- Storage patches validate unchanged snapshots once, validate incoming replacements, avoid a redundant write-side sanitization, and sort snapshots only when pruning is necessary. Pruning precomputes timestamps.
- Google requests select only consumed response fields while retaining pagination and reconciliation metadata. Concurrent silent requests share in-flight authentication; tokens are not cached by the adapter. Google write pacing and retry policy remain in place. Partial responses follow the [Google Calendar performance documentation](https://developers.google.com/workspace/calendar/api/guides/performance).
- Rediscovery of the same Lectio account avoids a state rewrite. Tab ranking computes each score once.
- Safari skips the native apply message when all operations are unchanged. The native bridge reuses date formatters, avoids failed ISO parses for the normal local timestamp format, and commits only when events changed.

## Verification

`npm run verify` passed: TypeScript checks, 27 tests, and Chrome/Firefox/Safari production builds. `npm run verify:safari` also passed the native macOS Xcode build with signing disabled. `git diff --check` passed.

Coverage includes concurrency bounds/order, draining schedule and activity failures, account changes before mutation, shared and queued syncs, duplicate prevention, pagination, calendar replacement, authentication invalidation, Google write pacing and conflict recovery, Safari tab failover and response trust, Unicode byte limits, snapshot pruning and replacement validation, parser rejection limits, and ID-cache account isolation/eviction. Benchmark comparisons also assert baseline-equivalent parsed output and event hashes, including nested title/note fixtures. Native date parsing agrees with the baseline for local, absolute, fractional, offset, DST-boundary, and invalid strings.

## Reproduction

The original working-source snapshot is in `.build/performance-baseline/` (ignored by Git). Run:

```sh
node scripts/benchmark-performance.mjs .build/performance-baseline/src
node scripts/benchmark-safari-dates.mjs .build/performance-baseline/SafariWebExtensionHandler.swift
npm run verify
npm run verify:safari
```

JavaScript results are written to `.build/performance-results.json`; native results to `.build/performance-safari-date-results.json`. Both benchmark scripts also run without a baseline argument to measure the current implementation.

## Remaining limits

Reviewed the background listeners and account lifecycle, popup rendering/styles, all core modules, browser manifests/build outputs, and native calendar operations. Reconciliation already uses keyed maps and EventKit already batches mutations in one transaction. OAuth caching already honors expiration and invalidation. The popup has a small DOM and no polling loop; date formatter creation was its clearest avoidable repeated cost.

Fresh linked activity reads dominate larger unchanged syncs. Calendar writes retain their 175 ms start spacing and retry delays; initial imports or large updates can therefore improve less than these unchanged-sync fixtures. Increasing request concurrency further, caching mutable page contents, changing full-horizon coverage, or replacing the tolerant HTML parser would need live profiles and additional correctness evidence. No live Lectio session, real Google write, or EventKit calendar mutation was used for these measurements.

This audit demonstrates specific improvements; it cannot prove that no further 1% gain is possible. Browser/network profiling with real timetable sizes is the next source of evidence for further work.
