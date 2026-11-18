---
"@dalgo/dalgo2postgrest": patch
---

Add additive `getWithSignal(key, signal, codec?)` and `getManyWithSignal(keys, signal, codec?)` reads. Every read now keeps one original configured timeout through local preparation, headers, fetch, body reading, cursor work and the final codec. Signaled caller abort or deadline rejects with `QueryCancelledError`; an unsignalled timeout keeps the redacted `PostgrestRequestError`.

`getMany` and `getManyWithSignal` capture fixed key membership and primitive key values before the first relation callback, share one deadline, abort siblings on the first real failure, prevent later dispatch, and never return a partial batch.
