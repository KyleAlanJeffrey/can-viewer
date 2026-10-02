#!/bin/sh
# Fails when the app's Content-Security-Policy in web/public/_headers is not quoted word for
# word on the landing page, which shows it as the privacy claim.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
csp=$(sed -n 's/^[[:space:]]*Content-Security-Policy:[[:space:]]*//p' "$root/web/public/_headers")

if [ -z "$csp" ]; then
  echo "No Content-Security-Policy in web/public/_headers" >&2
  exit 1
fi

if ! grep -qF -- "$csp" "$root/site/public/index.html"; then
  echo "site/public/index.html does not quote the app's CSP from web/public/_headers:" >&2
  echo "$csp" >&2
  exit 1
fi

echo "The landing page quotes the app's CSP."
