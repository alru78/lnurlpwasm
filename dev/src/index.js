import {storage, system, utils, wallet} from './lnbits-sdk.js'

const EXTENSION_ID = 'lnurlpwasm'
const LINKS_TABLE = 'pay_links'
const PAYMENTS_TABLE = 'payments'
const LINK_SEARCH_FIELDS = ['description', 'wallet_name']
const MAX_DESCRIPTION = 500
const MAX_SUCCESS_TEXT = 144
// The host caps invoice extra at 4096 bytes of ensure_ascii JSON, where every
// non-ASCII UTF-16 unit becomes a 6-byte \uXXXX escape. {"comment":""} takes 14
// bytes, so (4096 - 14) / 6 = 680 units always fit, whatever the script.
const MAX_COMMENT_CHARS = 680
const MAX_SENDABLE_SAT = 10_000_000
const PAYMENT_HASH_PATTERN = /^[0-9a-f]{64}$/
// Fiat links: the payer's wallet converts with its own rate, so accept a small
// drift between our quote and the amount it asks for (as the Python LNURLp does).
const FIAT_MIN_TOLERANCE = 0.995
const FIAT_MAX_TOLERANCE = 1.01

// Authenticated exports: the owner manages pay links.

export function createPayLink(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const timestamp = system.now()
    const link = {
      id: system.id('pl'),
      ...payLinkFields(request),
      created_at: timestamp,
      updated_at: timestamp
    }
    storage.set(LINKS_TABLE, link)
    return {payLink: privateLink(link)}
  })
}

export function updatePayLink(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const existing = getLink(requiredText(request.linkId, 'linkId', 128))
    const link = {
      ...existing,
      ...payLinkFields(request),
      id: existing.id,
      created_at: existing.created_at,
      updated_at: system.now()
    }
    storage.set(LINKS_TABLE, link)
    return {payLink: privateLink(link)}
  })
}

export function listPayLinks(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const pageSize = normalizePageSize(request.limit)
    const page = normalizePage(request.page)
    const response = storage.getPaginated(LINKS_TABLE, {
      search: cleanText(request.search, 120),
      searchFields: LINK_SEARCH_FIELDS,
      sortBy: 'created_at',
      descending: true,
      limit: pageSize,
      offset: (page - 1) * pageSize
    })
    return {payLinks: response.data.map(privateLink), total: response.total, page, limit: pageSize}
  })
}

export function deletePayLink(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const link = getLink(requiredText(request.linkId, 'linkId', 128))
    // Payment rows are only listed through their link; remove what fits in the
    // storage budget of this invocation.
    const payments = storage.getPaginated(PAYMENTS_TABLE, {filters: {link_id: link.id}, limit: 90})
    for (const payment of payments.data) storage.delete(PAYMENTS_TABLE, payment.id)
    storage.delete(LINKS_TABLE, link.id)
    return {deleted: true, linkId: link.id}
  })
}

export function listPayLinkPayments(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const link = getLink(requiredText(request.linkId, 'linkId', 128))
    const pageSize = normalizePageSize(request.limit)
    const page = normalizePage(request.page)
    const response = storage.getPaginated(PAYMENTS_TABLE, {
      filters: {link_id: link.id},
      sortBy: 'paid_at',
      descending: true,
      limit: pageSize,
      offset: (page - 1) * pageSize
    })
    return {
      payments: response.data.map(row => ({
        paymentHash: row.payment_hash,
        amountSat: Math.trunc(Number(row.amount_msat || 0) / 1000),
        comment: row.comment || '',
        paidAt: row.paid_at
      })),
      total: response.total,
      page,
      limit: pageSize
    }
  })
}

export function listWallets(_requestJson) {
  return runJson(() => ({wallets: wallet.listUserWallets()}))
}

export function listCurrencies(_requestJson) {
  return runJson(() => ({currencies: safeCurrencies()}))
}

// Public LNURL-pay endpoints (LUD-06). They answer wallets directly, so the
// response is the bare LNURL JSON and errors use the LNURL error format.

export function lnurlPayRequest(requestJson) {
  return runLnurl(() => {
    const request = parseJsonObject(requestJson)
    const link = getPublicLink(requiredText(request.linkId, 'linkId', 128))
    const {minSat, maxSat} = sendableSats(link)
    const response = {
      tag: 'payRequest',
      callback: `${link.base_url}/api/v1/ext/${EXTENSION_ID}/lnurl/${encodeURIComponent(link.id)}/cb`,
      minSendable: minSat * 1000,
      maxSendable: maxSat * 1000,
      metadata: metadataFor(link)
    }
    if (Number(link.comment_chars) > 0) response.commentAllowed = Number(link.comment_chars)
    return response
  })
}

export function lnurlPayCallback(requestJson) {
  return runLnurl(() => {
    const request = parseJsonObject(requestJson)
    const link = getPublicLink(requiredText(request.linkId, 'linkId', 128))

    const amountMsat = Number(request.amount)
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
      throw new LnurlError('amount must be a positive number of millisatoshis.')
    }
    if (amountMsat % 1000 !== 0) {
      throw new LnurlError('amount must be a whole number of sats.')
    }
    const {minSat, maxSat} = sendableSats(link)
    const isFiat = link.currency !== 'sat'
    const lower = isFiat ? Math.floor(minSat * FIAT_MIN_TOLERANCE) : minSat
    const upper = isFiat ? Math.ceil(maxSat * FIAT_MAX_TOLERANCE) : maxSat
    const amountSat = amountMsat / 1000
    if (amountSat < lower) throw new LnurlError(`Amount ${amountSat} sat is below the minimum of ${minSat} sat.`)
    if (amountSat > upper) throw new LnurlError(`Amount ${amountSat} sat is above the maximum of ${maxSat} sat.`)

    const comment = request.comment === undefined || request.comment === null ? '' : String(request.comment)
    const commentChars = Number(link.comment_chars || 0)
    if (comment.length > commentChars) {
      throw new LnurlError(`Comment has ${comment.length} characters, but only ${commentChars} are allowed.`)
    }

    const invoice = wallet.createInvoicePublic({
      sourceId: link.id,
      amount: amountSat,
      currency: 'sat',
      memo: cleanText(link.description, MAX_DESCRIPTION),
      extra: comment ? {comment} : {},
      // LUD-06: the invoice commits to the hash of exactly the metadata string
      // served in the first step, which the payer's wallet verifies.
      unhashedDescription: utf8Hex(metadataFor(link))
    })

    const response = {pr: invoice.paymentRequest, routes: []}
    const action = successAction(link)
    if (action) response.successAction = action
    return response
  })
}

// Event export: core only dispatches invoices created by this extension's
// create_invoice_public call for the pay link row and its owner.
export function recordPayment(eventJson) {
  return runJson(() => {
    const event = parseJsonObject(eventJson)
    if (event.extension !== EXTENSION_ID) return {recorded: false, reason: 'not a pay link invoice'}
    if (event.pending === true || (event.status && event.status !== 'success')) {
      return {recorded: false, reason: 'payment not settled'}
    }
    const paymentHash = cleanText(event.paymentHash, 64).toLowerCase()
    if (!PAYMENT_HASH_PATTERN.test(paymentHash)) return {recorded: false, reason: 'invalid payment hash'}

    const extra = objectValue(event.extra) || {}
    const linkId = cleanText(extra.source_id, 128)
    const link = linkId ? storage.get(LINKS_TABLE, linkId) : null
    if (!link) return {recorded: false, reason: 'pay link not found'}

    const id = `pay_${paymentHash}`
    if (storage.get(PAYMENTS_TABLE, id)) return {recorded: true, alreadyRecorded: true}
    const invoiceExtra = objectValue(extra[`extra_${EXTENSION_ID}`]) || {}
    storage.set(PAYMENTS_TABLE, {
      id,
      link_id: link.id,
      payment_hash: paymentHash,
      amount_msat: Math.abs(Math.trunc(Number(event.amount || 0))),
      comment: cleanText(invoiceExtra.comment, MAX_COMMENT_CHARS),
      paid_at: system.now()
    })
    return {recorded: true}
  })
}

class LnurlError extends Error {}

function payLinkFields(request) {
  const walletId = requiredText(request.walletId, 'walletId', 128)
  const userWallet = wallet.listUserWallets().find(item => item.id === walletId)
  if (!userWallet) throw new Error('Wallet not found.')

  const currency = normalizeCurrency(request.currency)
  const min = normalizeAmount(request.min, currency, 'min')
  const max = normalizeAmount(request.max ?? request.min, currency, 'max')
  if (max < min) throw new Error('max must not be below min.')
  if (currency === 'sat' && max > MAX_SENDABLE_SAT) throw new Error(`max must not exceed ${MAX_SENDABLE_SAT} sat.`)

  const commentChars = Math.trunc(Number(request.commentChars || 0))
  if (!Number.isInteger(commentChars) || commentChars < 0 || commentChars > MAX_COMMENT_CHARS) {
    throw new Error(`commentChars must be between 0 and ${MAX_COMMENT_CHARS}.`)
  }
  const successUrl = cleanText(request.successUrl, 2000)
  if (successUrl && !/^https:\/\/[^\s/?#]+[^\s]*$/i.test(successUrl)) {
    throw new Error('successUrl must start with https://.')
  }
  return {
    wallet_id: userWallet.id,
    wallet_name: cleanText(userWallet.name, 120),
    description: requiredText(request.description, 'description', MAX_DESCRIPTION),
    min,
    max,
    currency,
    comment_chars: commentChars,
    success_text: cleanText(request.successText, MAX_SUCCESS_TEXT),
    success_url: successUrl,
    base_url: normalizeBaseUrl(request.baseUrl)
  }
}

function sendableSats(link) {
  if (link.currency === 'sat') {
    return {minSat: Math.ceil(Number(link.min)), maxSat: Math.floor(Number(link.max))}
  }
  const minSat = Math.max(1, Math.round(utils.currencies.fiatToSats(Number(link.min), link.currency)))
  const maxSat = Math.max(minSat, Math.round(utils.currencies.fiatToSats(Number(link.max), link.currency)))
  return {minSat, maxSat}
}

function metadataFor(link) {
  return JSON.stringify([['text/plain', cleanText(link.description, MAX_DESCRIPTION)]])
}

function successAction(link) {
  if (link.success_url) {
    return {
      tag: 'url',
      description: link.success_text || 'Open link',
      url: link.success_url
    }
  }
  if (link.success_text) return {tag: 'message', message: link.success_text}
  return null
}

function getLink(linkId) {
  const link = storage.get(LINKS_TABLE, linkId)
  if (!link) throw new Error('Pay link not found.')
  return link
}

function getPublicLink(linkId) {
  const link = storage.getPublic(LINKS_TABLE, linkId)
  if (!link) throw new LnurlError('Pay link not found.')
  return link
}

function privateLink(link) {
  return {
    id: link.id,
    walletId: link.wallet_id,
    walletName: link.wallet_name,
    description: link.description,
    min: Number(link.min),
    max: Number(link.max),
    currency: link.currency,
    commentChars: Number(link.comment_chars || 0),
    successText: link.success_text || '',
    successUrl: link.success_url || '',
    baseUrl: link.base_url,
    createdAt: link.created_at,
    updatedAt: link.updated_at
  }
}

function normalizeBaseUrl(value) {
  const url = requiredText(value, 'baseUrl', 300).replace(/\/+$/, '')
  if (!/^https?:\/\/[A-Za-z0-9.\-:[\]]+$/.test(url)) {
    throw new Error('baseUrl must be the LNbits origin, e.g. https://lnbits.example.com.')
  }
  return url
}

function normalizeAmount(value, currency, field) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${field} must be greater than zero.`)
  if (currency === 'sat') {
    if (!Number.isInteger(amount)) throw new Error(`${field} must be a whole number of sats.`)
    return amount
  }
  return Math.round(amount * 100) / 100
}

function normalizeCurrency(value) {
  const currency = cleanText(value, 8) || 'sat'
  if (currency === 'sat') return currency
  const upper = currency.toUpperCase()
  if (!safeCurrencies().includes(upper)) throw new Error(`Unsupported currency: ${currency}.`)
  return upper
}

function safeCurrencies() {
  try {
    return utils.currencies.list()
  } catch (error) {
    system.log(`${EXTENSION_ID}: currency list unavailable: ${error}`, 'warning')
    return ['sat']
  }
}

// Hex of the UTF-8 bytes of a string, without relying on TextEncoder.
function utf8Hex(text) {
  let hex = ''
  for (const char of text) {
    let code = char.codePointAt(0)
    const bytes = []
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

function normalizePageSize(value) {
  return Math.min(Math.max(Math.trunc(Number(value) || 25), 1), 100)
}

function normalizePage(value) {
  return Math.max(Math.trunc(Number(value) || 1), 1)
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    system.log(`${EXTENSION_ID}: ${message}`, 'warning')
    return JSON.stringify({ok: false, error: message})
  }
}

function runLnurl(fn) {
  try {
    return JSON.stringify(fn())
  } catch (error) {
    const known = error instanceof LnurlError
    const message = error instanceof Error ? error.message : String(error)
    if (!known) system.log(`${EXTENSION_ID}: ${message}`, 'warning')
    return JSON.stringify({status: 'ERROR', reason: known ? message : 'Unable to process the request.'})
  }
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.')
  return parsed
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return ''
  return String(value).trim().slice(0, maxLength)
}

function requiredText(value, field, maxLength) {
  const text = cleanText(value, maxLength)
  if (!text) throw new Error(`${field} is required.`)
  return text
}
