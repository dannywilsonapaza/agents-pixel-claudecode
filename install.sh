#!/usr/bin/env sh
# Claude Code Pixel Office installer for macOS, Linux, WSL and Git Bash.
#   ./install.sh                      build + install globally (~/.claude)
#   ./install.sh --project ~/code/app install for one project only
#   ./install.sh --uninstall          remove what it installed
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "✖ Node.js >= 22.18 is required (to build): https://nodejs.org"
  exit 1
fi

ver=$(node -p 'process.versions.node')
major=${ver%%.*}
rest=${ver#*.}
minor=${rest%%.*}
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; }; then
  echo "✖ Node $ver is too old – >= 22.18 is required (it runs TypeScript directly)"
  exit 1
fi

exec node scripts/install.ts "$@"
