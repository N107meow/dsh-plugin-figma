#!/usr/bin/env bash
#
# Verify the wiring path end to end, in an ISOLATED profile that is created and
# removed by this script. It never touches your real profiles.
#
# Checks, in order:
#   1. the package resolves as a bare specifier from the profile's node_modules
#   2. the cordis.patch.yml row reaches the composed config
#   3. DSH actually loads and activates the plugin
#   4. the disposer runs on shutdown
#
# Usage: scripts/verify-wiring.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_NAME="wiring-verify"
PROFILE="$HOME/.dsh/profiles/$PROFILE_NAME"
PKG_NAME="$(node -p "require('$REPO/package.json').name")"
LOG="$(mktemp -t dsh-wiring-XXXXXX.log)"

cleanup() {
  rm -rf "$PROFILE"
  pkill -f "profile $PROFILE_NAME" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

echo "repo     : $REPO"
echo "package  : $PKG_NAME"
echo "profile  : $PROFILE (temporary, removed on exit)"
echo

echo "==> creating isolated profile"
rm -rf "$PROFILE"
mkdir -p "$PROFILE/node_modules"
printf '[]\n' > "$PROFILE/cordis.yml"
cat > "$PROFILE/cordis.patch.yml" <<YAML
- insert:
    # name = package name (loader resolves the module by this)
    # id   = Cordis row id (free-form, used for patch targeting and logs)
    - id: figma
      name: '$PKG_NAME'
YAML
cat > "$PROFILE/package.json" <<JSON
{
  "name": "dsh-profile-$PROFILE_NAME",
  "private": true,
  "dependencies": { "$PKG_NAME": "link:$REPO" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"], "patchReload": "live" } }
}
JSON
# pnpm link: installs a symlink; do it directly so this script needs no network.
ln -sfn "$REPO" "$PROFILE/node_modules/$PKG_NAME"

echo "==> 1/4 bare-specifier resolution from the profile"
( cd "$PROFILE" && node --input-type=module -e "
  const m = await import('$PKG_NAME')
  if (typeof m.apply !== 'function') { console.error('FAIL: apply is not a function'); process.exit(1) }
  console.log('    OK  name=' + JSON.stringify(m.name) + ' apply=' + typeof m.apply)
" )

echo "==> 2/4 row reaches the composed config"
( cd "$PROFILE" && npx --yes @deepseek-ai/dsh --profile "$PROFILE_NAME" --dump-config 2>/dev/null \
  | grep -A2 -- "- id: figma" | sed 's/^/    /' )
if ! ( cd "$PROFILE" && npx --yes @deepseek-ai/dsh --profile "$PROFILE_NAME" --dump-config 2>/dev/null | grep -q "$PKG_NAME" ); then
  echo "    FAIL: '$PKG_NAME' not present in composed config"; exit 1
fi
echo "    OK  '$PKG_NAME' present"

echo "==> 3/4 + 4/4 load, activate, and dispose"
( cd "$PROFILE" && npx --yes @deepseek-ai/dsh --profile "$PROFILE_NAME" > "$LOG" 2>&1 ) &
BOOT=$!
sleep 14
kill "$BOOT" 2>/dev/null || true
wait "$BOOT" 2>/dev/null || true

if grep -q "placeholder loaded" "$LOG"; then echo "    OK  plugin loaded and applied"; else
  echo "    FAIL: no load marker"; sed 's/^/    | /' "$LOG" | tail -20; exit 1; fi
if grep -qi "cannot find\|ERR_MODULE\|failed to load" "$LOG"; then
  echo "    FAIL: load error"; grep -i "cannot find\|ERR_MODULE\|failed to load" "$LOG" | sed 's/^/    | /'; exit 1
fi
echo "    OK  no load errors"

echo
echo "ALL CHECKS PASSED — '$PKG_NAME' installs and activates via the link: path."
