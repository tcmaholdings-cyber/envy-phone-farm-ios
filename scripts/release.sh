#!/bin/bash
# Build a deployable release tarball from a clean checkout.
#
#   scripts/release.sh [--version v1.2.3] [--out dist] [--with-node-modules] [--skip-build-check]
#
# Output: <out>/phone-farm-<version|short-sha>.tgz and a matching .sha256; the
# tarball path is the last line on stdout. Inside, one directory
# phone-farm-<name>/ holds the committed files from RELEASE_PATHS plus
# RELEASE.json {id, sha, version, subject, builtAt, nodeModules[, nodeAbi]}.
# id is the 12-character commit sha and names releases/<id>/ on the host (kept
# short: the WDA supervisor's unix socket lives under it and macOS caps socket
# paths at 104 bytes).
#
# Only committed content ships (git archive), so host state can never leak in:
# .env*, devices.json, .wda/, .appium2/, .scheduler-data/, logs/ and node_modules/
# are git-ignored, and the tarball is checked for them anyway.
#
#   --version NAME        name the tarball (default: the exact tag on HEAD, else the short sha)
#   --with-node-modules   run `npm ci` into the release (native modules are then built
#                         for this machine's Node ABI; deploy.sh reinstalls on a mismatch)
#   --skip-build-check    do not verify that the committed browser assets match `npm run build:web`
set -euo pipefail

VERSION="" OUT="" WITH_NODE_MODULES=0 BUILD_CHECK=1
while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION=${2:?--version needs a value}; shift ;;
        --out) OUT=${2:?--out needs a directory}; shift ;;
        --with-node-modules) WITH_NODE_MODULES=1 ;;
        --skip-build-check) BUILD_CHECK=0 ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument $1" >&2; exit 64 ;;
    esac
    shift
done

REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
cd "$REPO"
OUT=${OUT:-$REPO/dist}
say () { echo "release: $*" >&2; }
fail () { say "ERROR: $*"; exit 1; }

# What a host needs to run, migrate and redeploy. Tests, claudedocs and CI config stay out.
RELEASE_PATHS=(
    package.json package-lock.json
    src static drizzle Patches deploy scripts docs
    drizzle.config.ts tsconfig.json tsconfig.web.json docker-compose.yml
    .env.example README.md AGENTS.md PLUGIN_DEVELOPMENT.md SECURITY.md LICENSE LICENSE-GRANT.md NOTICE
)
# Host state: must never appear in a release.
FORBIDDEN_TOP=(.env devices.json device-secrets.json .wda .appium2 .scheduler-data logs backups node_modules static/assets)

git diff --quiet HEAD -- && git diff --cached --quiet -- \
    || fail "tracked files have uncommitted changes; commit or stash them first"

if [ "$BUILD_CHECK" = 1 ]; then
    say "checking committed browser assets against npm run build:web"
    npm run --silent build:web >&2
    if ! git diff --quiet -- static/dashboard/assets || [ -n "$(git ls-files --others --exclude-standard -- static/dashboard/assets)" ]; then
        git checkout -- static/dashboard/assets 2>/dev/null || true
        fail "static/dashboard/assets is stale: run npm run build:web and commit the output"
    fi
fi

SHA=$(git rev-parse HEAD)
ID=${SHA:0:12}
SUBJECT=$(git log -1 --format=%s)
[ -n "$VERSION" ] || VERSION=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
NAME="phone-farm-${VERSION:-$ID}"
[[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || fail "version '$VERSION' makes an unsafe file name"

PATHS=()
for path in "${RELEASE_PATHS[@]}"; do
    if git cat-file -e "HEAD:$path" 2>/dev/null; then PATHS+=("$path"); fi
done

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/phone-farm-release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
git archive --format=tar --prefix="$NAME/" HEAD -- "${PATHS[@]}" | tar -x -C "$STAGE"

for item in "${FORBIDDEN_TOP[@]}"; do
    [ ! -e "$STAGE/$NAME/$item" ] || fail "$item is committed; host state must not ship in a release"
done
leaked=$(cd "$STAGE/$NAME" && find . \( -name '.env' -o -name '.env.*' -o -name 'devices.json' \) ! -name '.env.example' -print)
[ -z "$leaked" ] || fail "host state is committed: $leaked"

NODE_ABI=""
if [ "$WITH_NODE_MODULES" = 1 ]; then
    say "npm ci into the release"
    (cd "$STAGE/$NAME" && npm ci --no-audit --no-fund >&2)
    NODE_ABI=$(node -p 'process.versions.modules + "-" + process.arch')
fi

node -e '
    const [file, id, sha, version, subject, nodeModules, nodeAbi] = process.argv.slice(1);
    const meta = { id, sha, version: version || null, subject, builtAt: new Date().toISOString(), nodeModules: nodeModules === "1" };
    if (nodeAbi) meta.nodeAbi = nodeAbi;
    require("fs").writeFileSync(file, JSON.stringify(meta, null, 2) + "\n");
' "$STAGE/$NAME/RELEASE.json" "$ID" "$SHA" "$VERSION" "$SUBJECT" "$WITH_NODE_MODULES" "$NODE_ABI"

mkdir -p "$OUT"
TARBALL="$OUT/$NAME.tgz"
# COPYFILE_DISABLE keeps macOS tar from adding ._ AppleDouble files.
COPYFILE_DISABLE=1 tar -czf "$TARBALL" -C "$STAGE" "$NAME"
if command -v shasum >/dev/null 2>&1; then
    (cd "$OUT" && shasum -a 256 "$NAME.tgz" > "$NAME.tgz.sha256")
else
    (cd "$OUT" && sha256sum "$NAME.tgz" > "$NAME.tgz.sha256")
fi
say "built $TARBALL ($ID, ${VERSION:-untagged}: $SUBJECT)"
echo "$TARBALL"
