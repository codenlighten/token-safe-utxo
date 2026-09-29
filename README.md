# token-safe-utxo

Keeps a BSV wallet from spending an ordinal, a BSV-20/21 token or a locked output as plain satoshis. Once such an output
is paid away as a fee or as change, the inscription or token balance is gone for good.

It is extracted from [SatoFinder](https://satofinder.com), which runs this check before every Send and every recovery
sweep.

## The contract: fail closed

`collectProtectedOutpoints` throws a `TokenSafetyError` on every inconsistency it can detect, and otherwise returns the
protected outputs at an address.
- It reads every page with a one-row overlap: each page after the first must start with the previous page's last row.
- It stops only on a page with nothing new, and confirms that with a second read at the same offset, which must come
  back empty. An empty first page is confirmed the same way.

So a server that caps pages, a short (even overlap-only) page mid-scan, a flaky empty first page, and rows shifting
because something was spent during the scan all cause a throw, not a partial set.

Offset paging has no snapshot, so a change *after* the last read can't be detected. That's why the call order below
matters.

It throws when:

| `code` | cause |
|---|---|
| `INDEXER_UNAVAILABLE` | the indexer request failed |
| `UNEXPECTED_RESPONSE` | not an array, or more rows than the page size (paging can't be trusted) |
| `MISSING_OUTPOINT` | an output without a usable `txid`/`vout` or `outpoint` |
| `INCOMPLETE_SCAN` | the listing changed or paged inconsistently during the scan (retry), a row appeared twice, or more than `maxPages` pages (default 50 × 1000 rows) |

On a throw, **don't build the transaction.** There is deliberately no "spend anyway" mode in the library. If you want
an override, make it an explicit, separate decision in your UI.

## What counts as protected

- **Indexer markers:** any output whose own `data` or `origin.data` carries `insc`, `bsv20`, `bsv21` or `lock`, as
  returned by the 1Sat indexer. As of 2026-09-29, GorillaPool reports BSV-21 tokens under `bsv20`, with an `id` and no
  `tick`, and never returns a `bsv21` key. That key is checked only in case that changes.
- **Ordinal origins without data:** any output with an ordinal `origin` (an origin outpoint), even when neither it nor
  its origin carries data. The indexer reports some real inscriptions that way. Plain satoshis have `origin: null`.
- **The token listing:** every row of the indexer's BSV-20 listing (`&bsv20=true`), marker or not.
- **1-sat outputs:** `filterSpendable` also holds back every **1-sat** UTXO by default (`holdOneSat: true`), even one the
  indexer doesn't list. That's where ordinals live, and an indexer can lag behind one that has just arrived.
  - It's also the backstop for what paging can't detect: an indexer that consistently returns an empty or stale listing.
  - Every ordinal and token output measured on 2026-09-29 was 1 sat.
  - Only turn it off if you have another way to see ordinals.

## Usage

```js
import { collectProtectedOutpoints, gorillaPoolLister, filterSpendable } from 'token-safe-utxo'

// 1. Fetch the wallet's UTXOs FIRST, then scan. Anything spendable was on-chain before the scan started, so a token
//    that arrives in between is either in the scan or held by the 1-sat rule.
const walletUtxos = await fetchWalletUtxos(address) // { txid, vout, satoshis } each, e.g. mapped from WhatsOnChain
// 2. Scan. A throw means: don't build (retry later).
const protectedSet = await collectProtectedOutpoints(gorillaPoolLister(address))
// 3. Filter. held: [{ utxo, reason: 'indexed' | 'one-sat' }]; show the user what was set aside.
const { spendable, held } = filterSpendable(walletUtxos, protectedSet)
```

`filterSpendable` throws a `TypeError` for any UTXO not shaped `{ txid: 64 hex chars, vout: integer, satoshis: number }`.
Raw WhatsOnChain rows (`tx_hash`, `tx_pos`, `value`) must be mapped first; they are refused rather than silently treated
as unprotected. Txids are compared case-insensitively.

Any other indexer works if you pass your own `listPage({ offset, bsv20, limit })` in place of `gorillaPoolLister`.

## What it can't do

- **It's only as complete as the indexer.** A token standard the indexer doesn't mark isn't recognised, apart from the
  1-sat rule. Check the marker list against your indexer when that indexer changes.
- **It doesn't decide what you *want* to spend.** Transferring an ordinal or a token on purpose needs a wallet that
  understands it. This library only keeps them out of plain-satoshi transactions.

## Tests

`npm test` (Node 18 or later, no dependencies) covers:
- **real indexer rows:** trimmed GorillaPool responses in `fixtures/`, each recording its source URL and fetch date;
- **every fail-closed path**;
- **paging:** a server-side page cap, a short page mid-scan, rows shifting during a scan, and duplicate rows;
- **caller shapes:** refused UTXO shapes and upper-case txids;
- **the 1-sat rule**;
- **parity:** a check that the library protects everything SatoFinder's rule protects.
