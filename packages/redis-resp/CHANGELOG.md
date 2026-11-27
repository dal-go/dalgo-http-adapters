# @dalgo/dalgo2redis-resp

## 0.2.0

### Minor Changes

- 01a2c87: Add a bounded, read-only Upstash Redis REST executor using the shared browser-safe RESP2 protocol subpath. Preserve native bytes and signed64 integers, scope single-page SCAN, and cover token acquisition, HTTP/body reads and final delivery with caller cancellation and a finite deadline. The shared SCAN validator refuses oversized or foreign whole pages.
