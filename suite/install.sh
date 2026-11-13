#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX=${1:-/usr/local}

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "broodctl requires Node.js 24 or newer (found $(node --version))" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to build broodctl" >&2
  exit 1
fi

cd "$ROOT"
# Exact direct versions are pinned in package.json; dependencies are project-local.
npm install --no-audit --no-fund
npm run build

DEST="$PREFIX/lib/broodctl"
mkdir -p "$DEST" "$PREFIX/bin"
install -m 0644 cli/dist/broodctl.mjs "$DEST/broodctl.mjs"
cat > "$PREFIX/bin/broodctl" <<WRAPPER
#!/bin/sh
exec node "$DEST/broodctl.mjs" "\$@"
WRAPPER
chmod 0755 "$PREFIX/bin/broodctl"
echo "Installed broodctl at $PREFIX/bin/broodctl"
