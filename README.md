# Pay Links (WASM)

An LNbits WASM extension for LNURL-pay links (LUD-06): a QR code or `LNURL1…`
string that any Lightning wallet can pay, with an amount range you choose.
A sandboxed alternative to the pay link part of the Python
[LNURLp](https://github.com/lnbits/lnurlp) extension.

## What it does

- Create pay links with a description, a fixed amount or a min/max range in
  sats or a fiat currency, and the wallet that receives the payments.
- Allow comments from the payer (LUD-12) and show them with each payment.
- Show a success message or link in the payer's wallet after paying
  (LUD-09 `message` / `url`).
- Each link is shown as a QR code and an `LNURL1…` string (LUD-01).

## How it works

1. A wallet requests `/api/v1/ext/lnurlpwasm/lnurl/<id>` and gets the
   `payRequest` with the amount range and the metadata
   `[["text/plain", "<description>"]]`.
2. The wallet calls the callback with `amount` (msat) and an optional
   `comment`. The extension checks the range and the comment length and creates
   the invoice with `wallet.create_invoice_public`, passing the metadata as
   `unhashed_description`, so the invoice commits to `sha256(metadata)` as
   LUD-06 requires.
3. When the invoice is paid, the `onInvoicePaid` event records the payment and
   its comment. Core only dispatches it for invoices this extension created for
   that pay link and its owner.

Fiat links are quoted in sats at request time; the callback accepts a small
drift (−0.5 % / +1 %) because the payer's wallet may convert with its own rate.
Amounts must be whole sats.

## Differences from the Python LNURLp extension

| Python LNURLp | This extension |
| --- | --- |
| Pay links | Supported |
| Lightning addresses (`name@domain`) | Not here: LNbits core provides Lightning addresses per wallet, and WASM extensions cannot register `/.well-known/lnurlp` |
| Webhooks | Not supported: they would need network access to arbitrary servers |
| Nostr zaps (NIP-57) | Not supported yet |
| Counters for served requests | Not stored (public requests do not write to storage) |

## Permissions

| Permission | Why |
| --- | --- |
| `ext.storage.read`, `ext.storage.write` | Store pay links and payments |
| `ext.storage.read_public` | Answer LNURL requests with description, amount range, comment length and success message (never the wallet) |
| `wallet.create_invoice_public` | Create invoices into the wallet chosen for the link |
| `wallet.list` | Let you pick the receiving wallet |
| `utils.basic` | List currencies and convert fiat amounts |

No `http.request`, no outgoing payments.

## Requirements

LNbits 1.7.2 or newer: the `unhashed_description` field for WASM invoices
([lnbits/lnbits#4324](https://github.com/lnbits/lnbits/pull/4324)) is not part
of 1.7.1. On older versions the invoices would not carry the metadata hash and
wallets would reject them.

## Development

```sh
cd dev
npm test            # unit tests against an in-memory LNbits host
npm run build:wasm  # rebuild wasm/module.wasm with jco
./scripts/package.sh  # build dist/lnurlpwasm.zip for installation
```

## License

MIT, like the original LNURLp extension.

The icon (`static/assets/icon.png`, source `assets/icon.svg`) uses lettering
converted from the Permanent Marker font, licensed under the Apache License 2.0
(`assets/LICENSE-PermanentMarker.txt`).
