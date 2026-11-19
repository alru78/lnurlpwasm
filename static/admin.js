const client = window.createLNbitsExtensionClient({extensionId: 'lnurlpwasm'})

const state = {editingId: null, links: [], wallets: [], qrApps: []}

const $ = selector => document.querySelector(selector)
const form = $('#link-form')
const saveButton = $('#save-button')
const cancelButton = $('#cancel-button')
const list = $('#link-list')

saveButton.addEventListener('click', () => save().catch(showError))
cancelButton.addEventListener('click', resetForm)

init().catch(showError)

async function init() {
  const [{wallets}, {currencies}] = await Promise.all([client.listWallets(), client.listCurrencies()])
  state.wallets = wallets || []
  fillSelect(field('walletId'), state.wallets.map(w => [w.id, w.name || w.id]))
  fillSelect(field('currency'), (currencies || ['sat']).map(c => [c, c]))
  await refresh()
}

async function refresh() {
  const response = await client.listLinks({limit: 100})
  state.links = response.payLinks || []
  renderList()
}

async function save() {
  saveButton.disabled = true
  try {
    const payload = {
      description: field('description').value,
      min: Number(field('min').value),
      max: Number(field('max').value),
      currency: field('currency').value,
      walletId: field('walletId').value,
      commentChars: Number(field('commentChars').value || 0),
      successText: field('successText').value,
      successUrl: field('successUrl').value,
      // The LNURL callback must be an absolute URL on this LNbits instance.
      baseUrl: window.location.origin
    }
    if (state.editingId) {
      await client.updateLink(state.editingId, payload)
      client.notify('Pay link updated').catch(() => {})
    } else {
      await client.createLink(payload)
      client.notify('Pay link created').catch(() => {})
    }
    resetForm()
    await refresh()
  } finally {
    saveButton.disabled = false
  }
}

function edit(link) {
  state.editingId = link.id
  field('description').value = link.description
  field('min').value = String(link.min)
  field('max').value = String(link.max)
  field('currency').value = link.currency
  field('walletId').value = link.walletId
  field('commentChars').value = String(link.commentChars)
  field('successText').value = link.successText
  field('successUrl').value = link.successUrl
  $('#form-title').textContent = 'Edit pay link'
  saveButton.textContent = 'Save changes'
  cancelButton.hidden = false
  window.scrollTo(0, 0)
}

function resetForm() {
  state.editingId = null
  for (const name of ['description', 'successText', 'successUrl']) field(name).value = ''
  field('min').value = '10'
  field('max').value = '10000'
  field('currency').value = 'sat'
  field('commentChars').value = '0'
  $('#form-title').textContent = 'New pay link'
  saveButton.textContent = 'Create pay link'
  cancelButton.hidden = true
}

// The sandboxed iframe has no allow-modals, so window.confirm() is unavailable:
// the first click arms the button, the second one deletes.
async function remove(link, node) {
  if (node.dataset.armed !== 'true') {
    node.dataset.armed = 'true'
    node.textContent = 'Click again to delete'
    window.setTimeout(() => {
      node.dataset.armed = 'false'
      node.textContent = 'Delete'
    }, 4000)
    return
  }
  await client.deleteLink(link.id)
  if (state.editingId === link.id) resetForm()
  await refresh()
}

async function showPayments(link, container) {
  const {payments, total} = await client.listPayments(link.id, {limit: 25})
  container.textContent = ''
  if (!total) {
    container.append(el('p', {class: 'muted'}, 'No payments yet.'))
  } else {
    const sum = payments.reduce((acc, p) => acc + p.amountSat, 0)
    container.append(el('p', {class: 'muted'}, `${total} payment(s); latest ${payments.length}: ${sum.toLocaleString()} sats`))
    for (const p of payments) {
      const line = `${new Date(p.paidAt * 1000).toLocaleString()} · ${p.amountSat.toLocaleString()} sats`
      container.append(el('div', {class: 'payment'}, p.comment ? `${line} · “${p.comment}”` : line))
    }
  }
  container.hidden = false
}

function renderList() {
  for (const app of state.qrApps) app.unmount()
  state.qrApps = []
  list.textContent = ''
  $('#empty').hidden = state.links.length > 0
  for (const link of state.links) {
    const url = lnurlUrl(link)
    const encoded = encodeLnurl(url)
    const qr = el('div', {class: 'qrcode qrcode--small'})
    const payments = el('div', {class: 'payments', hidden: true})
    list.append(
      el('article', {class: 'item item--qr'}, [
        qr,
        el('div', {class: 'item-body'}, [
          el('div', {class: 'item-head'}, [
            el('strong', {}, link.description),
            el('span', {class: 'muted'}, formatRange(link))
          ]),
          el('div', {class: 'muted small'}, `Wallet: ${link.walletName || link.walletId}`),
          link.commentChars ? el('div', {class: 'muted small'}, `Comments up to ${link.commentChars} characters`) : '',
          link.successText || link.successUrl
            ? el('div', {class: 'muted small url'}, `After payment: ${[link.successText, link.successUrl].filter(Boolean).join(' · ')}`)
            : '',
          el('div', {class: 'muted small url'}, encoded),
          el('div', {class: 'actions'}, [
            button('Copy LNURL', () => copy(encoded)),
            button('Payments', () => showPayments(link, payments)),
            button('Edit', () => edit(link)),
            button('Delete', node => remove(link, node), 'text-negative')
          ]),
          payments
        ])
      ])
    )
    renderQr(qr, `lightning:${encoded}`)
  }
}

function lnurlUrl(link) {
  return `${link.baseUrl}/api/v1/ext/lnurlpwasm/lnurl/${encodeURIComponent(link.id)}`
}

function renderQr(container, value) {
  if (!window.Vue || !window.QrcodeVue?.default) {
    container.textContent = ''
    return
  }
  const app = window.Vue.createApp({
    render() {
      return window.Vue.h(window.QrcodeVue.default, {value, size: 160, margin: 2, level: 'M', renderAs: 'svg', class: 'qrcode-svg'})
    }
  })
  app.mount(container)
  state.qrApps.push(app)
}

// LUD-01: bech32 with the "lnurl" prefix over the UTF-8 bytes of the URL.
function encodeLnurl(url) {
  const bytes = Array.from(new TextEncoder().encode(url))
  return bech32Encode('lnurl', convertBits(bytes, 8, 5)).toUpperCase()
}

function convertBits(data, from, to) {
  let acc = 0
  let bits = 0
  const out = []
  const maxv = (1 << to) - 1
  for (const value of data) {
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & maxv)
    }
  }
  if (bits > 0) out.push((acc << (to - bits)) & maxv)
  return out
}

function bech32Encode(hrp, data) {
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const mod = polymod(values) ^ 1
  const checksum = Array.from({length: 6}, (_, i) => (mod >> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map(d => charset[d]).join('')}`
}

function hrpExpand(hrp) {
  const chars = [...hrp].map(c => c.charCodeAt(0))
  return [...chars.map(c => c >> 5), 0, ...chars.map(c => c & 31)]
}

function polymod(values) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const value of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i += 1) if ((top >> i) & 1) chk ^= gen[i]
  }
  return chk
}

function formatRange(link) {
  const fmt = v => (link.currency === 'sat' ? `${Number(v).toLocaleString()}` : Number(v).toFixed(2))
  const unit = link.currency === 'sat' ? 'sats' : link.currency
  return link.min === link.max ? `${fmt(link.min)} ${unit}` : `${fmt(link.min)}–${fmt(link.max)} ${unit}`
}

function button(label, onClick, extraClass = 'text-grey-2') {
  const node = el('button', {class: `q-btn ${extraClass}`, type: 'button'}, label)
  node.addEventListener('click', () => {
    Promise.resolve(onClick(node)).catch(showError)
  })
  return node
}

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) node.setAttribute(name, '')
    else if (value !== false && value !== undefined) node.setAttribute(name, value)
  }
  for (const child of [].concat(children)) {
    if (child === '' || child === null || child === undefined) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function fillSelect(select, options) {
  select.textContent = ''
  for (const [value, label] of options) select.append(el('option', {value}, label))
}

function field(name) {
  return form.querySelector(`[name="${name}"]`)
}

function copy(text) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => client.notify('Copied'))
    .catch(() => client.notifyError('Copying is not available here.'))
}

function showError(error) {
  client.notifyError(error).catch(() => {})
}
