# Registrations

Hash-only evidence records made with iptrust.org. A record is evidence that the committed content existed by the time
its anchoring block was mined, and that the signer made the statement in it. It does not create or register any right.

| date | covers | type | record | signer | git tag |
|---|---|---|---|---|---|
| 2026-09-29 | token-safe-utxo 0.2.1 (the repository at the tag) | software | [`67e531862ac2a124…`](https://iptrust.org/v/67e531862ac2a1247d3f7603069311275104692dec7bbe3d385191203aeddbd5) | Gregory J. Ward | `ip-2026-09-29` |

Full record hash: `67e531862ac2a1247d3f7603069311275104692dec7bbe3d385191203aeddbd5`

The private opening values that tie the record to these files are kept by the authors, not in this repository. With
them, anyone can verify the record offline in a separate worktree, so the main working copy is never touched:

```
git worktree add /tmp/at-tag ip-2026-09-29 && cp -r .iptrust /tmp/at-tag/
(cd /tmp/at-tag && iptrust2 verify 67e531862ac2a1247d3f7603069311275104692dec7bbe3d385191203aeddbd5 --fetch-headers)   # expect: valid, matched
git worktree remove --force /tmp/at-tag
```
