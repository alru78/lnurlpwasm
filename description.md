Create LNURL-pay links: a QR code or LNURL that any Lightning wallet can pay,
with an amount range you choose instead of a fixed invoice.

- Fixed amount or a min/max range, in sats or a fiat currency
- Optional comments from the payer, shown with each payment
- Optional success message or link shown in the payer's wallet after paying
- Invoices commit to the LNURL metadata hash (LUD-06), as wallets require
- Runs in the sandboxed WASM runtime with only the permissions you approve

Lightning addresses (name@your-domain) are provided by LNbits itself for each
wallet, so this extension focuses on pay links.
