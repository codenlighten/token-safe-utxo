// token-safe: never spend a UTXO that holds an ordinal, a token or a lock as
// plain satoshis.
//
// The contract is fail-closed. If the indexer can't be reached, returns
// something unexpected, pages inconsistently, or has more outputs than a scan
// is allowed to read, collectProtectedOutpoints throws and the caller must not
// build a transaction. A wallet that spends "unprotected" coins after a failed
// check can burn an NFT or destroy a token balance by paying it as fee or
// change.

/** Markers that make an output unsafe to spend as plain satoshis. */
export const PROTECTED_MARKERS = Object.freeze(['insc', 'bsv20', 'bsv21', 'lock'])

export const DEFAULT_PAGE_SIZE = 1000
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
 * lock (in its own data or its origin's data), or has an ordinal origin at
 * all. The indexer reports some real inscriptions with an origin outpoint but
 * no data, and plain satoshis with origin null.
 * @param {any} txo an output as returned by the 1Sat indexer
 */
export function isProtectedTxo (txo) {
  if (txo == null || typeof txo !== 'object') return false
  if (hasMarker(txo.data) || hasMarker(txo.origin?.data)) return true
  return typeof txo.origin?.outpoint === 'string' && txo.origin.outpoint.length > 0
}

/**
 * "txid:vout" for an indexer output (`txid`/`vout` fields, or
 * `outpoint` as "<txid>_<vout>").
 * @param {any} txo
 * @returns {string}
 */
export function outpointKey (txo) {
  if (typeof txo?.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(txo.txid) && Number.isInteger(txo.vout) && txo.vout >= 0) {
    return `${txo.txid.toLowerCase()}:${txo.vout}`
  }
  const m = typeof txo?.outpoint === 'string' && txo.outpoint.match(/^([0-9a-fA-F]{64})_(\d+)$/)
  if (m) return `${m[1].toLowerCase()}:${Number(m[2])}`
  throw new TokenSafetyError('MISSING_OUTPOINT', 'Indexer returned an output without a usable outpoint; refusing to classify it.')
}

/**
 * Reads both listings (the plain one, where ordinals and locks appear, and the
 * BSV-20 one, where every row is a token output) and returns the set of
 * protected "txid:vout" keys.
 *
 * Offset paging has no snapshot, so each page after the first is requested
 * from one row back and must start with the previous page's last row; a scan
 * ends only on a page with nothing new, confirmed by a second read at the same
 * offset that must come back empty. That turns a server-side page cap, a short
 * or overlap-only page mid-scan, a flaky empty first page, and rows shifting
 * because something was spent into a TokenSafetyError (the caller retries)
 * instead of a silently partial set. It can't detect a change after its last
 * read, which is why callers should fetch the wallet's UTXOs *before* calling
 * this, and keep the 1-sat hold in filterSpendable as a backstop.
 *
 * @param {(args: { offset: number, bsv20: boolean, limit: number }) => Promise<unknown>} listPage
 * @param {{ pageSize?: number, maxPages?: number }} [options]
 * @returns {Promise<Set<string>>}
 */
export async function collectProtectedOutpoints (listPage, options = {}) {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  if (!Number.isInteger(pageSize) || pageSize < 2) throw new RangeError('pageSize must be an integer of at least 2')
  const protectedSet = new Set()

  for (const bsv20 of [false, true]) {
    const label = bsv20 ? 'token' : 'ordinal'
    const seen = new Set()
    let offset = 0
    let previousLast = null
    let requests = 0
    const read = async requestOffset => {
      if (requests++ >= maxPages) {
        throw new TokenSafetyError('INCOMPLETE_SCAN',
          `More than ${maxPages} pages of ${label} outputs; cannot verify every UTXO is safe to spend.`)
      }
      let rows
      try {
        rows = await listPage({ offset: requestOffset, bsv20, limit: pageSize })
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
      return rows
    }
    for (;;) {
      const rows = await read(previousLast === null ? offset : offset - 1)

      let fresh = rows
      if (previousLast !== null) {
        if (rows.length === 0 || outpointKey(rows[0]) !== previousLast) {
          throw new TokenSafetyError('INCOMPLETE_SCAN',
            `The ${label} listing changed or paged inconsistently during the scan; retry.`)
        }
        fresh = rows.slice(1)
      }
      if (fresh.length === 0) {
        // Confirm the end: a flaky empty first page, or a capped/flaky page
        // holding only the overlap row, must not end the scan.
        if ((await read(offset)).length !== 0) {
          throw new TokenSafetyError('INCOMPLETE_SCAN',
            `The ${label} listing did not confirm its end at offset ${offset}; retry.`)
        }
        break
      }

      for (const txo of fresh) {
        const key = outpointKey(txo)
        if (seen.has(key)) {
          throw new TokenSafetyError('INCOMPLETE_SCAN', `The ${label} listing returned ${key} twice during one scan; retry.`)
        }
        seen.add(key)
        // Every row of the BSV-20 listing is a token output.
        if (bsv20 || isProtectedTxo(txo)) protectedSet.add(key)
      }
      offset += fresh.length
      previousLast = outpointKey(rows[rows.length - 1])
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
    // A shape mismatch must not fail open: an unknown key never matches the
    // protected set, and a missing satoshis field would skip the 1-sat rule.
    if (typeof utxo?.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(utxo.txid) ||
        !Number.isInteger(utxo.vout) || utxo.vout < 0 || !Number.isFinite(utxo.satoshis)) {
      throw new TypeError('Each UTXO needs { txid: 64 hex chars, vout: non-negative integer, satoshis: number }')
    }
    if (protectedSet.has(`${utxo.txid.toLowerCase()}:${utxo.vout}`)) held.push({ utxo, reason: 'indexed' })
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
