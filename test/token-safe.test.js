import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  isProtectedTxo, outpointKey, collectProtectedOutpoints, filterSpendable,
  gorillaPoolLister, TokenSafetyError
} from '../src/index.js'

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url))).rows
const inscriptions = fixture('gorillapool-inscriptions')
const bsv20 = fixture('gorillapool-bsv20')
const plainSats = fixture('gorillapool-plain-sats')

const key = txo => outpointKey(txo)
const txid = n => n.toString(16).padStart(64, '0')

// A lister serving fixed pages: pages[bsv20 ? 1 : 0] is an array of pages.
function lister ([plainPages, tokenPages], calls = []) {
  return async ({ offset, bsv20, limit }) => {
    calls.push({ offset, bsv20, limit })
    const pages = bsv20 ? tokenPages : plainPages
    const flat = pages.flat()
    return flat.slice(offset, offset + limit)
  }
}

test('real indexer rows: inscriptions and BSV-20 outputs are protected, plain sats are not', () => {
  for (const t of inscriptions) assert.equal(isProtectedTxo(t), true, `inscription ${t.outpoint}`)
  for (const t of bsv20) assert.equal(isProtectedTxo(t), true, `bsv20 ${t.outpoint}`)
  for (const t of plainSats) assert.equal(isProtectedTxo(t), false, `plain ${t.outpoint}`)
})

test('markers are found in the output\'s own data as well as its origin', () => {
  assert.equal(isProtectedTxo({ data: { lock: { until: 900000 } } }), true)
  assert.equal(isProtectedTxo({ data: { bsv21: { id: 'x_0', amt: '1' } } }), true)
  assert.equal(isProtectedTxo({ origin: { data: { insc: {} } } }), true)
  assert.equal(isProtectedTxo({ data: { map: { app: 'x' } }, origin: null }), false)
  assert.equal(isProtectedTxo(null), false)
})

test('outpointKey accepts txid/vout or "<txid>_<vout>" and rejects anything else', () => {
  assert.equal(outpointKey({ txid: txid(1), vout: 2 }), `${txid(1)}:2`)
  assert.equal(outpointKey({ outpoint: `${txid(3)}_0` }), `${txid(3)}:0`)
  for (const bad of [{}, { txid: 'zz', vout: 0 }, { outpoint: `${txid(1)}.0` }, { txid: txid(1), vout: -1 }]) {
    assert.throws(() => outpointKey(bad), err => err instanceof TokenSafetyError && err.code === 'MISSING_OUTPOINT')
  }
})

test('collects every protected outpoint from both listings', async () => {
  const set = await collectProtectedOutpoints(lister([[[...plainSats, ...inscriptions]], [bsv20]]), { pageSize: 10 })
  assert.deepEqual([...set].sort(), [...inscriptions, ...bsv20].map(key).sort())
})

const inscribed = n => Array.from({ length: n }, (_, i) => ({ txid: txid(i + 1), vout: 0, origin: { outpoint: `${txid(i + 1)}_0`, data: { insc: {} } } }))

test('pages with a one-row overlap and ends on a page with nothing new', async () => {
  const calls = []
  const set = await collectProtectedOutpoints(lister([[inscribed(25)], [[]]], calls), { pageSize: 10 })
  assert.equal(set.size, 25)
  // ...then one confirming read at the end offset, which must be empty.
  assert.deepEqual(calls.filter(c => !c.bsv20).map(c => c.offset), [0, 9, 18, 24, 25])
})

test('a page holding only the overlap row mid-scan is not taken as the end', async () => {
  const all = inscribed(25)
  let n = 0
  const overlapOnly = async ({ offset, limit, bsv20 }) => {
    if (bsv20) return []
    n++
    return all.slice(offset, offset + (n === 2 ? 1 : limit)) // second page: just the overlap row
  }
  await assert.rejects(collectProtectedOutpoints(overlapOnly, { pageSize: 10 }), e => e.code === 'INCOMPLETE_SCAN')
})

test('a flaky empty first page does not pass as an empty listing', async () => {
  const all = inscribed(5)
  let n = 0
  const flakyFirst = async ({ offset, limit, bsv20 }) => {
    if (bsv20) return []
    return n++ === 0 ? [] : all.slice(offset, offset + limit)
  }
  await assert.rejects(collectProtectedOutpoints(flakyFirst, { pageSize: 10 }), e => e.code === 'INCOMPLETE_SCAN')
})

test('a genuinely empty listing is confirmed with a second read and returns an empty set', async () => {
  const calls = []
  const set = await collectProtectedOutpoints(lister([[[]], [[]]], calls))
  assert.equal(set.size, 0)
  assert.equal(calls.length, 4) // two reads per listing
})

test('a server that caps pages below the requested size is still read to the end (no silent truncation)', async () => {
  const all = inscribed(250)
  const capped = async ({ offset, bsv20 }) => bsv20 ? [] : all.slice(offset, offset + 30) // ignores limit=100
  const set = await collectProtectedOutpoints(capped, { pageSize: 100 })
  assert.equal(set.size, 250)
})

test('a short page mid-scan does not end the scan early', async () => {
  const all = inscribed(25)
  let n = 0
  const flaky = async ({ offset, limit, bsv20 }) => {
    if (bsv20) return []
    n++
    return all.slice(offset, offset + (n === 2 ? 3 : limit)) // second page comes back short
  }
  const set = await collectProtectedOutpoints(flaky, { pageSize: 10 })
  assert.equal(set.size, 25)
})

test('fails closed when rows shift during the scan (something on an earlier page was spent)', async () => {
  const all = inscribed(25)
  let n = 0
  const shifting = async ({ offset, limit, bsv20 }) => {
    if (bsv20) return []
    const rows = n++ === 0 ? all : all.slice(1) // row 1 spent after the first page
    return rows.slice(offset, offset + limit)
  }
  await assert.rejects(collectProtectedOutpoints(shifting, { pageSize: 10 }), e => e.code === 'INCOMPLETE_SCAN')
})

test('fails closed when a row appears twice in one scan', async () => {
  const all = inscribed(12)
  all.splice(11, 0, all[3]) // a duplicate later in the listing
  await assert.rejects(collectProtectedOutpoints(lister([[all], [[]]]), { pageSize: 10 }), e => e.code === 'INCOMPLETE_SCAN')
})

test('real inscriptions reported with an origin but no data are protected', () => {
  const unmarked = fixture('gorillapool-unmarked-ordinal')
  assert.ok(unmarked.length > 0)
  for (const t of unmarked) {
    assert.equal(t.origin.data ?? null, null)
    assert.equal(isProtectedTxo(t), true, t.outpoint)
  }
})

test('fails closed: indexer error', async () => {
  const listPage = async () => { throw new Error('ECONNRESET') }
  await assert.rejects(collectProtectedOutpoints(listPage), e => e.code === 'INDEXER_UNAVAILABLE' && /ECONNRESET/.test(e.message))
})

test('fails closed: unexpected shape, oversized page, output without outpoint', async () => {
  await assert.rejects(collectProtectedOutpoints(async () => ({ error: 'x' })), e => e.code === 'UNEXPECTED_RESPONSE')
  await assert.rejects(collectProtectedOutpoints(async () => new Array(11).fill(plainSats[0]), { pageSize: 10 }),
    e => e.code === 'UNEXPECTED_RESPONSE')
  await assert.rejects(collectProtectedOutpoints(async ({ bsv20 }) => bsv20 ? [{ satoshis: 1 }] : []),
    e => e.code === 'MISSING_OUTPOINT')
})

test('fails closed: more pages than allowed', async () => {
  const endless = async ({ limit, offset }) => Array.from({ length: limit }, (_, i) => ({ txid: txid(offset + i + 1), vout: 0 }))
  await assert.rejects(collectProtectedOutpoints(endless, { pageSize: 2, maxPages: 3 }), e => e.code === 'INCOMPLETE_SCAN')
})

test('filterSpendable holds indexed and 1-sat outputs, with reasons', () => {
  const utxos = [
    { txid: txid(1), vout: 0, satoshis: 1000 }, // indexed token
    { txid: txid(2), vout: 1, satoshis: 1 }, // unindexed 1-sat: held
    { txid: txid(3), vout: 0, satoshis: 5000 } // plain
  ]
  const { spendable, held } = filterSpendable(utxos, new Set([`${txid(1)}:0`]))
  assert.deepEqual(spendable, [utxos[2]])
  assert.deepEqual(held.map(h => h.reason), ['indexed', 'one-sat'])
  assert.equal(filterSpendable(utxos, new Set(), { holdOneSat: false }).spendable.length, 3)
  assert.throws(() => filterSpendable(utxos, []), TypeError)
})

test('filterSpendable refuses UTXO shapes that would fail open', () => {
  const set = new Set([`${txid(1)}:0`])
  // Raw WhatsOnChain rows: no txid/vout/satoshis.
  assert.throws(() => filterSpendable([{ tx_hash: txid(1), tx_pos: 0, value: 546 }], set), TypeError)
  assert.throws(() => filterSpendable([{ txid: txid(1), vout: '0', satoshis: 546 }], set), TypeError)
  // An upper-case txid still matches the protected set.
  const hexTxid = 'ab'.repeat(32)
  const { spendable, held } = filterSpendable([{ txid: hexTxid.toUpperCase(), vout: 0, satoshis: 546 }], new Set([`${hexTxid}:0`]))
  assert.equal(spendable.length, 0)
  assert.equal(held[0].reason, 'indexed')
})

test('gorillaPoolLister builds the documented URLs and surfaces HTTP errors', async () => {
  const urls = []
  const fetch = async url => { urls.push(url); return { ok: !url.includes('bsv20'), status: 503, json: async () => [] } }
  const listPage = gorillaPoolLister('1Addr', { fetch })
  await listPage({ offset: 0, bsv20: false, limit: 1000 })
  await assert.rejects(listPage({ offset: 0, bsv20: true, limit: 1000 }), /HTTP 503/)
  assert.deepEqual(urls, [
    'https://ordinals.gorillapool.io/api/txos/address/1Addr/unspent?limit=1000&offset=0',
    'https://ordinals.gorillapool.io/api/txos/address/1Addr/unspent?limit=1000&offset=0&bsv20=true'
  ])
  await assert.rejects(collectProtectedOutpoints(listPage), e => e.code === 'INDEXER_UNAVAILABLE')
})

test('every row of the BSV-20 listing is protected, even without a recognised marker', async () => {
  const bare = { txid: txid(99), vout: 3, satoshis: 1, data: {} }
  const set = await collectProtectedOutpoints(lister([[[]], [[bare]]]))
  assert.ok(set.has(`${txid(99)}:3`))
})

// satofinder's rule (satofinder-modern.html and index.html, Tokens.isProtected),
// copied verbatim so the library can be shown to be at least as strict.
function satofinderIsProtected (txo) {
  if (!txo || typeof txo !== 'object') return false
  const data = txo.origin?.data
  if (!data) return false
  return !!(data.insc || data.bsv20 || data.lock)
}

test('at least as strict as satofinder: anything it protects, the library protects', () => {
  const cases = [...inscriptions, ...bsv20, ...plainSats,
    { origin: { data: { lock: {} } } }, { origin: { data: { bsv20: {} } } }, { origin: null }, {}]
  for (const t of cases) {
    if (satofinderIsProtected(t)) assert.equal(isProtectedTxo(t), true, JSON.stringify(t).slice(0, 80))
  }
})
