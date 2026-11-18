---
"@dalgo/dalgo2redis-resp": minor
"@dalgo/dalgo2upstash-redis": minor
---

Add a bounded, read-only Upstash Redis REST executor using the shared browser-safe RESP2 protocol subpath. Preserve native bytes and signed64 integers, scope single-page SCAN, and cover token acquisition, HTTP/body reads and final delivery with caller cancellation and a finite deadline. The shared SCAN validator refuses oversized or foreign whole pages.
