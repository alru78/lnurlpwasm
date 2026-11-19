import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {beforeEach, test} from 'node:test'
import {fileURLToPath, pathToFileURL} from 'node:url'

// Load index.js against an in-memory host that mimics LNbits' owner-scoped
// storage, public projection and wallet APIs.
const devDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(resolve(devDir, 'src/index.js'), 'utf8')
const modulePath = resolve(devDir, 'dist/index.test.mjs')
await mkdir(dirname(modulePath), {recursive: true})
await writeFile(
  modulePath,
  source.replace(
    /^import \{[^}]+\} from '\.\/lnbits-sdk\.js'\n/,
    'const {storage, system, utils, wallet} = globalThis.__lnurlpHost\n'
  ),
  'utf8'
)

const config = JSON.parse(await readFile(resolve(devDir, '../config.json'), 'utf8'))
const PUBLIC_FIELDS = config.permissions.find(p => p.id === 'ext.storage.read_public').policies[0].public_fields
const HASH_A = 'a'.repeat(64)
const BASE = 'https://lnbits.example.com'

let rows, invoices, owner, counter

const key = (table, id) => `${table}/${id}`

globalThis.__lnurlpHost = {
  storage: {
    get(table, id) {
      const row = rows.get(key(table, id))
      return row && row.owner === owner ? structuredClone(row.data) : null
    },
    getPublic(table, id) {
      const row = rows.get(key(table, id))
      if (!row || table !== 'pay_links') return null
      return Object.fromEntries(PUBLIC_FIELDS.map(field => [field, row.data[field]]))
    },
    set(table, data) {
      const existing = rows.get(key(table, data.id))
      if (existing && existing.owner !== owner) throw new Error('id taken')
      rows.set(key(table, data.id), {owner, data: structuredClone(data)})
      return data
    },
    delete(table, id) {
      const row = rows.get(key(table, id))
      if (row && row.owner === owner) rows.delete(key(table, id))
    },
    getPaginated(table, options = {}) {
      const data = [...rows.entries()]
        .filter(([k, row]) => k.startsWith(`${table}/`) && row.owner === owner)
        .map(([, row]) => row.data)
        .filter(item => Object.entries(options.filters || {}).every(([f, v]) => item[f] === v))
      return {data: data.slice(0, options.limit || 25), total: data.length}
    }
  },
  wallet: {
    listUserWallets() {
      return {alice: [{id: 'w_alice', name: 'Alice wallet'}], bob: [{id: 'w_bob', name: 'Bob'}]}[owner] || []
    },
    createInvoicePublic(request) {
      invoices.push(request)
      return {paymentHash: HASH_A, paymentRequest: 'lnbc1fake', checkingId: HASH_A}
    }
  },
  system: {
    id(prefix) {
      counter += 1
      return `${prefix}_${counter}`
    },
    now: () => 1_800_000_000,
    log() {}
  },
  utils: {
    currencies: {
      list: () => ['sat', 'EUR', 'USD'],
      // 1 EUR = 1,000 sat in this fake
      fiatToSats: (amount, currency) => (currency === 'EUR' ? amount * 1000 : NaN)
    }
  }
}

const ext = await import(pathToFileURL(modulePath).href)

function call(fn, request) {
  const response = JSON.parse(fn(JSON.stringify(request)))
  if (!response.ok) throw new Error(response.error)
  return response.data
}
function callError(fn, request) {
  const response = JSON.parse(fn(JSON.stringify(request)))
  assert.equal(response.ok, false)
  return response.error
}
const lnurl = (fn, request) => JSON.parse(fn(JSON.stringify(request)))

function createLink(overrides = {}) {
  owner = 'alice'
  const link = call(ext.createPayLink, {
    walletId: 'w_alice',
    description: 'Coffee for Alice',
    min: 10,
    max: 1000,
    currency: 'sat',
    commentChars: 50,
    baseUrl: BASE,
    ...overrides
  }).payLink
  owner = null
  return link
}

beforeEach(() => {
  rows = new Map()
  invoices = []
  owner = null
  counter = 0
})

test('pay request follows LUD-06', () => {
  const link = createLink()
  const res = lnurl(ext.lnurlPayRequest, {linkId: link.id})
  assert.deepEqual(res, {
    tag: 'payRequest',
    callback: `${BASE}/api/v1/ext/lnurlpwasm/lnurl/${link.id}/cb`,
    minSendable: 10_000,
    maxSendable: 1_000_000,
    metadata: JSON.stringify([['text/plain', 'Coffee for Alice']]),
    commentAllowed: 50
  })
})

test('the invoice commits to exactly the served metadata', () => {
  const description = 'Kaffee für Alice ☕ — danke!'
  const link = createLink({description})
  const {metadata} = lnurl(ext.lnurlPayRequest, {linkId: link.id})
  const res = lnurl(ext.lnurlPayCallback, {linkId: link.id, amount: '21000'})
  assert.equal(res.pr, 'lnbc1fake')
  assert.deepEqual(res.routes, [])
  const sent = invoices[0]
  assert.equal(Buffer.from(sent.unhashedDescription, 'hex').toString('utf8'), metadata)
  // what the payer's wallet checks against the invoice's description hash
  const expected = createHash('sha256').update(metadata, 'utf8').digest('hex')
  const actual = createHash('sha256').update(Buffer.from(sent.unhashedDescription, 'hex')).digest('hex')
  assert.equal(actual, expected)
  assert.deepEqual(
    {sourceId: sent.sourceId, amount: sent.amount, currency: sent.currency},
    {sourceId: link.id, amount: 21, currency: 'sat'}
  )
})

test('amounts outside the range or with msat remainders are refused', () => {
  const link = createLink()
  for (const [amount, reason] of [
    ['9000', /below the minimum/],
    ['1001000', /above the maximum/],
    ['21500', /whole number of sats/],
    ['-5', /positive/],
    ['abc', /positive/]
  ]) {
    const res = lnurl(ext.lnurlPayCallback, {linkId: link.id, amount})
    assert.equal(res.status, 'ERROR')
    assert.match(res.reason, reason)
  }
  assert.equal(invoices.length, 0)
})

test('comments are limited and stored with the payment', () => {
  const link = createLink({commentChars: 5})
  const tooLong = lnurl(ext.lnurlPayCallback, {linkId: link.id, amount: '20000', comment: 'too long'})
  assert.equal(tooLong.status, 'ERROR')
  lnurl(ext.lnurlPayCallback, {linkId: link.id, amount: '20000', comment: 'thx'})
  assert.deepEqual(invoices[0].extra, {comment: 'thx'})

  owner = 'alice' // core runs the event in the link owner's context
  call(ext.recordPayment, {
    paymentHash: HASH_A, amount: 20000, pending: false, status: 'success', extension: 'lnurlpwasm',
    extra: {source_id: link.id, extra_lnurlpwasm: {comment: 'thx'}}
  })
  const payments = call(ext.listPayLinkPayments, {linkId: link.id})
  assert.deepEqual(payments.payments.map(p => [p.amountSat, p.comment]), [[20, 'thx']])
})

test('links without comments do not advertise commentAllowed', () => {
  const link = createLink({commentChars: 0})
  assert.equal('commentAllowed' in lnurl(ext.lnurlPayRequest, {linkId: link.id}), false)
  assert.equal(lnurl(ext.lnurlPayCallback, {linkId: link.id, amount: '20000', comment: 'x'}).status, 'ERROR')
})

test('fiat links quote sats and tolerate small rate drift', () => {
  const link = createLink({currency: 'eur', min: 1, max: 2})
  const res = lnurl(ext.lnurlPayRequest, {linkId: link.id})
  assert.equal(res.minSendable, 1_000_000)
  assert.equal(res.maxSendable, 2_000_000)
  assert.equal(lnurl(ext.lnurlPayCallback, {linkId: link.id, amount: String(996 * 1000)}).pr, 'lnbc1fake')
  assert.equal(lnurl(ext.lnurlPayCallback, {linkId: link.id, amount: String(2019 * 1000)}).pr, 'lnbc1fake')
  assert.equal(lnurl(ext.lnurlPayCallback, {linkId: link.id, amount: String(990 * 1000)}).status, 'ERROR')
})

test('success actions follow LUD-09 and LUD-10 shapes', () => {
  const msg = createLink({successText: 'Thanks!'})
  assert.deepEqual(lnurl(ext.lnurlPayCallback, {linkId: msg.id, amount: '20000'}).successAction, {tag: 'message', message: 'Thanks!'})
  const url = createLink({successText: 'Your download', successUrl: 'https://example.com/d'})
  assert.deepEqual(lnurl(ext.lnurlPayCallback, {linkId: url.id, amount: '20000'}).successAction, {
    tag: 'url', description: 'Your download', url: 'https://example.com/d'
  })
  owner = 'alice'
  assert.match(callError(ext.createPayLink, {walletId: 'w_alice', description: 'x', min: 1, baseUrl: BASE, successUrl: 'http://insecure.example'}), /https/)
})

test('the public view never exposes the wallet', () => {
  const link = createLink()
  const res = lnurl(ext.lnurlPayRequest, {linkId: link.id})
  assert.ok(!JSON.stringify(res).includes('w_alice'))
  assert.ok(!PUBLIC_FIELDS.includes('wallet_id'))
})

test('unknown links and malformed base urls are rejected', () => {
  assert.deepEqual(lnurl(ext.lnurlPayRequest, {linkId: 'pl_missing'}), {status: 'ERROR', reason: 'Pay link not found.'})
  owner = 'alice'
  for (const baseUrl of ['javascript:alert(1)', 'https://x.example/path', '']) {
    assert.match(callError(ext.createPayLink, {walletId: 'w_alice', description: 'x', min: 1, baseUrl}), /baseUrl/)
  }
})

test('owners are isolated and cannot use foreign wallets', () => {
  const link = createLink()
  owner = 'bob'
  assert.equal(call(ext.listPayLinks, {}).total, 0)
  assert.match(callError(ext.deletePayLink, {linkId: link.id}), /not found/)
  assert.match(callError(ext.createPayLink, {walletId: 'w_alice', description: 'x', min: 1, baseUrl: BASE}), /Wallet not found/)
})

test('payment events are verified and recorded once', () => {
  const link = createLink()
  const event = {
    paymentHash: HASH_A, amount: 21000, pending: false, status: 'success', extension: 'lnurlpwasm',
    extra: {source_id: link.id}
  }
  assert.equal(call(ext.recordPayment, {...event, extension: 'tips'}).recorded, false)
  assert.equal(call(ext.recordPayment, {...event, pending: true}).recorded, false)
  assert.equal(call(ext.recordPayment, {...event, extra: {source_id: 'pl_other'}}).recorded, false)
  owner = 'alice'
  assert.equal(call(ext.recordPayment, event).recorded, true)
  assert.equal(call(ext.recordPayment, event).alreadyRecorded, true)
  assert.equal(call(ext.listPayLinkPayments, {linkId: link.id}).total, 1)
})

test('max must not be below min and internal errors stay generic', () => {
  owner = 'alice'
  assert.match(callError(ext.createPayLink, {walletId: 'w_alice', description: 'x', min: 100, max: 10, baseUrl: BASE}), /max must not be below/)
  owner = null
  assert.deepEqual(lnurl(ext.lnurlPayRequest, '{not json' ), {status: 'ERROR', reason: 'Unable to process the request.'})
})
