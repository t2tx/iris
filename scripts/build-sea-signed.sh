#!/bin/sh
# Build + Developer ID sign + notarize the macOS SEA binary.
#
#   IRIS_SIGN_IDENTITY="Developer ID Application: NAME (TEAMID)" \
#   IRIS_NOTARY_APPLE_ID="you@example.com" \
#   IRIS_NOTARY_TEAM_ID="TEAMID" \
#   IRIS_NOTARY_PASSWORD="app-specific-pw" \
#   sh scripts/build-sea-signed.sh
#
# Secrets are taken from the environment (never commit them). Without
# IRIS_SIGN_IDENTITY this falls back to the ad-hoc build (scripts/build-sea.sh).
set -e

BIN="dist-sea/iris"
ENTITLEMENTS="scripts/iris.entitlements.plist"

# 1) Build the unsigned/ad-hoc binary first (reuses the base build).
sh scripts/build-sea.sh

if [ -z "$IRIS_SIGN_IDENTITY" ]; then
  echo "IRIS_SIGN_IDENTITY not set — keeping the ad-hoc signed binary."
  echo "(For distribution, set IRIS_SIGN_IDENTITY and the IRIS_NOTARY_* vars.)"
  exit 0
fi

echo "sign: $IRIS_SIGN_IDENTITY (Hardened Runtime + entitlements)…"
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IRIS_SIGN_IDENTITY" "$BIN"
codesign --verify --strict "$BIN" && echo "signature: valid"

if [ -z "$IRIS_NOTARY_APPLE_ID" ] || [ -z "$IRIS_NOTARY_TEAM_ID" ] || [ -z "$IRIS_NOTARY_PASSWORD" ]; then
  echo "IRIS_NOTARY_* not all set — signed but NOT notarized."
  echo "(Gatekeeper will reject on other Macs until notarized.)"
  exit 0
fi

echo "notarize: submitting to Apple…"
ZIP="dist-sea/iris.zip"
ditto -c -k --keepParent "$BIN" "$ZIP"
xcrun notarytool submit "$ZIP" \
  --apple-id "$IRIS_NOTARY_APPLE_ID" \
  --team-id "$IRIS_NOTARY_TEAM_ID" \
  --password "$IRIS_NOTARY_PASSWORD" \
  --wait
rm -f "$ZIP"

echo "verify notarization (spctl -t install)…"
spctl -a -vvv -t install "$BIN" 2>&1 | head -3 || true
echo "done → $BIN (signed + notarized)"
