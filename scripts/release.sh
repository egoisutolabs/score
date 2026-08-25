#!/usr/bin/env bash
# Manual release: ./scripts/release.sh 0.0.3
# Publishes @egoisuto/score to npm (prompts for your 2FA) and creates the
# git tag + GitHub Release. Run from a clean checkout of main.
set -euo pipefail

version="${1:?usage: ./scripts/release.sh <version>}"
cd "$(dirname "$0")/.."

bun run check
bun run test
bun run build

# The daemon build bundles every @score/* workspace dep into dist, so the
# published package is dist + a bin shim and declares no dependencies.
cd apps/daemon
rm -rf publish
mkdir -p publish/bin
cp -r dist publish/dist
cp ../../LICENSE ../../README.md publish/
printf '#!/usr/bin/env bun\nimport "../dist/index.js";\n' > publish/bin/score.js
chmod +x publish/bin/score.js
cat > publish/package.json <<EOF
{
  "name": "@egoisuto/score",
  "version": "${version}",
  "description": "One daemon runs the whole issue -> PR -> green -> merged pipeline",
  "type": "module",
  "license": "AGPL-3.0-only",
  "bin": { "score": "bin/score.js" },
  "engines": { "bun": ">=1.3.0" },
  "repository": { "type": "git", "url": "git+https://github.com/egoisutolabs/score.git" }
}
EOF

cd publish
npm publish --access public # interactive 2FA prompt
cd ../../..

git tag "v${version}"
git push origin "v${version}"
gh release create "v${version}" --title "v${version}" --generate-notes
