// token-safe: never spend a UTXO that holds an ordinal, a token or a lock as
// plain satoshis.
//
// The contract is fail-closed. If the indexer can't be reached, returns
// something unexpected, or has more outputs than a scan is allowed to read,
// collectProtectedOutpoints throws and the caller must not build a
// transaction. A wallet that spends "unprotected" coins after a failed check
// can burn an NFT or destroy a token balance by paying it as fee or change.

/** Markers that make an output unsafe to spend as plain satoshis. */
export const PROTECTED_MARKERS = Object.freeze(['insc', 'bsv20', 'bsv21', 'lock'])

export const DEFAULT_PAGE_SIZE = 1000 // GorillaPool caps a page at 1000 rows
export const DEFAULT_MAX_PAGES = 50

/** Thrown whenever the protected set can't be established completely. */
export class TokenSafetyError extends Error {
  /**
   * @param {'INDEXER_UNAVAILABLE'|'UNEXPECTED_RESPONSE'|'MISSING_OUTPOINT'|'INCOMPLETE_SCAN'} code
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor (code, message, cause) {
    super(message)
    this.name = 'TokenSafetyError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

function hasMarker (data) {
  if (data == null || typeof data !== 'object') return false
  return PROTECTED_MARKERS.some(key => data[key] != null && data[key] !== false)
}

/**
 * True when an indexer output carries an inscription, a BSV-20/21 token or a
 * lock, in either its own data or its origin's data.
 * @param {any} txo an output as returned by the 1Sat indexer
 */
export function isProtectedTxo (txo) {
  if (txo == null || typeof txo !== 'object') return false
  return hasMarker(txo.data) || hasMarker(txo.origin?.data)
}

/**
 * "txid:vout" for an indexer output (`txid`/`vout` fields, or
 * `outpoint` as "<txid>_<vout>").
 * @param {any} txo
 * @returns {string}
 */
export function outpointKey (txo) {
  if (typeof txo?.txid === 'string' && /^[0-9a-f]{64}$/.test(txo.txid) && Number.isInteger(txo.vout) && txo.vout >= 0) {
    return `${txo.txid}:${txo.vout}`
  }
  const m = typeof txo?.outpoint === 'string' && txo.outpoint.match(/^([0-9a-f]{64})_(\d+)$/)
  if (m) return `${m[1]}:${Number(m[2])}`
  throw new TokenSafetyError('MISSING_OUTPOINT', 'Indexer returned an output without a usable outpoint; refusing to classify it.')
}

/**
 * Reads every page of both listings (the plain one, where ordinals and locks
 * appear, and the BSV-20 one, where every row is a token output) and returns
 * the set of protected "txid:vout" keys. Throws TokenSafetyError on anything
 * short of a complete scan.
 *
 * @param {(args: { offset: number, bsv20: boolean, limit: number }) => Promise<unknown>} listPage
 * @param {{ pageSize?: number, maxPages?: number }} [options]
 * @returns {Promise<Set<string>>}
 */
export async function collectProtectedOutpoints (listPage, options = {}) {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const protectedSet = new Set()

  for (const bsv20 of [false, true]) {
    let offset = 0
    for (let page = 0; ; page++) {
      if (page >= maxPages) {
        throw new TokenSafetyError('INCOMPLETE_SCAN',
          `More than ${maxPages} pages of ${bsv20 ? 'token' : 'ordinal'} outputs; cannot verify every UTXO is safe to spend.`)
      }
      let rows
      try {
        rows = await listPage({ offset, bsv20, limit: pageSize })
      } catch (e) {
        throw new TokenSafetyError('INDEXER_UNAVAILABLE',
          `Ordinal/token indexer unavailable (${e?.message ?? e}); cannot verify UTXOs are safe to spend.`, e)
      }
      if (!Array.isArray(rows)) {
        throw new TokenSafetyError('UNEXPECTED_RESPONSE', 'Ordinal/token indexer returned an unexpected response shape.')
      }
      if (rows.length > pageSize) {
        throw new TokenSafetyError('UNEXPECTED_RESPONSE',
          `Indexer returned ${rows.length} rows for a page of ${pageSize}; paging can't be trusted.`)
      }
      for (const txo of rows) {
        // Every row of the BSV-20 listing is a token output.
        if (bsv20 || isProtectedTxo(txo)) protectedSet.add(outpointKey(txo))
      }
      if (rows.length < pageSize) break
      offset += rows.length
    }
  }
  return protectedSet
}

/**
 * Splits wallet UTXOs into those safe to spend and those held back, with the
 * reason for each held UTXO.
 *
 * 1-sat outputs are held back by default even when the indexer doesn't list
 * them: that is where ordinals live, and an indexer can lag behind one that
 * has just arrived.
 *
 * @template {{ txid: string, vout: number, satoshis: number }} U
 * @param {U[]} utxos
 * @param {Set<string>} protectedSet from collectProtectedOutpoints
 * @param {{ holdOneSat?: boolean }} [options]
 * @returns {{ spendable: U[], held: Array<{ utxo: U, reason: 'indexed' | 'one-sat' }> }}
 */
export function filterSpendable (utxos, protectedSet, options = {}) {
  if (!(protectedSet instanceof Set)) throw new TypeError('protectedSet must be the Set from collectProtectedOutpoints')
  const holdOneSat = options.holdOneSat ?? true
  const spendable = []
  const held = []
  for (const utxo of utxos) {
    if (protectedSet.has(`${utxo.txid}:${utxo.vout}`)) held.push({ utxo, reason: 'indexed' })
    else if (holdOneSat && utxo.satoshis === 1) held.push({ utxo, reason: 'one-sat' })
    else spendable.push(utxo)
  }
  return { spendable, held }
}

/**
 * A listPage function for GorillaPool's 1Sat indexer.
 *
 * @param {string} address
 * @param {{ fetch?: typeof fetch, baseUrl?: string }} [options]
 */
export function gorillaPoolLister (address, options = {}) {
  const fetchFn = options.fetch ?? globalThis.fetch
  const baseUrl = (options.baseUrl ?? 'https://ordinals.gorillapool.io/api').replace(/\/+$/, '')
  return async ({ offset, bsv20, limit }) => {
    const url = `${baseUrl}/txos/address/${encodeURIComponent(address)}/unspent` +
      `?limit=${limit}&offset=${offset}` + (bsv20 ? '&bsv20=true' : '')
    const res = await fetchFn(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
}
