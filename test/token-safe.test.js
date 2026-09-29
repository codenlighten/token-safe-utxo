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

test('pages until a short page, advancing the offset by rows received', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ txid: txid(i + 1), vout: 0, origin: { data: { insc: {} } } }))
  const calls = []
  const set = await collectProtectedOutpoints(lister([[many], [[]]], calls), { pageSize: 10 })
  assert.equal(set.size, 25)
  assert.deepEqual(calls.filter(c => !c.bsv20).map(c => c.offset), [0, 10, 20])
})

test('an exactly full last page triggers one more (empty) request', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ txid: txid(i + 1), vout: 0, data: { insc: {} } }))
  const calls = []
  await collectProtectedOutpoints(lister([[ten], [[]]], calls), { pageSize: 10 })
  assert.deepEqual(calls.filter(c => !c.bsv20).map(c => c.offset), [0, 10])
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
