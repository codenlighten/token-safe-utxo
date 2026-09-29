# token-safe-utxo

Keeps a BSV wallet from spending an ordinal, a BSV-20/21 token or a locked output as plain satoshis. Once such an output
is paid away as a fee or as change, the inscription or token balance is gone for good.

It is extracted from [SatoFinder](https://satofinder.com), which runs this check before every Send and every recovery
sweep.

## The contract: fail closed

`collectProtectedOutpoints` either returns the **complete** set of protected outputs at an address, or throws a
`TokenSafetyError`. It throws when:

| `code` | cause |
|---|---|
| `INDEXER_UNAVAILABLE` | the indexer request failed |
| `UNEXPECTED_RESPONSE` | not an array, or more rows than the page size (paging can't be trusted) |
| `MISSING_OUTPOINT` | an output without a usable `txid`/`vout` or `outpoint` |
| `INCOMPLETE_SCAN` | more than `maxPages` pages (default 50 × 1000 rows) |

On a throw, **don't build the transaction.** There is deliberately no "spend anyway" mode in the library. If you want
an override, make it an explicit, separate decision in your UI.

## What counts as protected

- **Indexer markers:** any output whose own `data` or `origin.data` carries `insc`, `bsv20`, `bsv21` or `lock`, as
  returned by the 1Sat indexer.
- **The token listing:** every row of the indexer's BSV-20 listing (`&bsv20=true`), marker or not.
- **1-sat outputs:** `filterSpendable` also holds back every **1-sat** UTXO by default (`holdOneSat: true`), even one the
  indexer doesn't list. That's where ordinals live, and an indexer can lag behind one that has just arrived.

## Usage

```js
import { collectProtectedOutpoints, gorillaPoolLister, filterSpendable } from 'token-safe-utxo'

const protectedSet = await collectProtectedOutpoints(gorillaPoolLister(address)) // throws: don't build
const { spendable, held } = filterSpendable(walletUtxos, protectedSet)
// held: [{ utxo, reason: 'indexed' | 'one-sat' }]; show the user what was set aside
```

`walletUtxos` are `{ txid, vout, satoshis, ... }` from your own UTXO source, for example WhatsOnChain. Any other indexer
works if you pass your own `listPage({ offset, bsv20, limit })` in place of `gorillaPoolLister`.

## What it can't do

- **It's only as complete as the indexer.** A token standard the indexer doesn't mark isn't recognised, apart from the
  1-sat rule. Check the marker list against your indexer when that indexer changes.
- **It doesn't decide what you *want* to spend.** Transferring an ordinal or a token on purpose needs a wallet that
  understands it. This library only keeps them out of plain-satoshi transactions.

## Tests

`npm test` (Node 18 or later, no dependencies) covers:
- **real indexer rows:** trimmed GorillaPool responses in `fixtures/`, each recording its source URL and fetch date;
- **every fail-closed path**, plus paging, including an exactly full last page;
- **the 1-sat rule**;
- **parity:** a check that the library protects everything SatoFinder's rule protects.
