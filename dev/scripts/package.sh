#!/bin/sh
# Build the installable archive: one top-level lnurlpwasm/ directory with only
# the files the LNbits WASM installer needs (no dev tooling).
# The archive is built from a committed revision (default HEAD, or a tag given
# as $2), never from the working tree, so uncommitted edits cannot slip in.
set -eu
cd "$(dirname "$0")/../.."
out="${1:-dist/lnurlpwasm.zip}"
rev="${2:-HEAD}"

if [ "$rev" = "HEAD" ] && [ -n "$(git status --porcelain -- config.json README.md LICENSE wasm ui static storage)" ]; then
  echo "Refusing to package: uncommitted changes in shipped files. Commit first or pass a tag." >&2
  exit 1
fi
commit="$(git rev-parse --verify "$rev^{commit}")"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/lnurlpwasm" "$(dirname "$out")"
git archive --format=tar "$commit" config.json README.md LICENSE wasm ui static storage \
  | tar -x -C "$stage/lnurlpwasm"
rm -f "$out"
out_abs="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
(cd "$stage" && zip -qrX "$out_abs" lnurlpwasm)

echo "commit      $commit ($(git describe --tags --always "$commit"))"
echo "module.wasm $(shasum -a 256 "$stage/lnurlpwasm/wasm/module.wasm" | cut -d' ' -f1)"
echo "archive     $(shasum -a 256 "$out_abs" | cut -d' ' -f1)"
echo "$out_abs"
