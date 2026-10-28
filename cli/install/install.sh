#!/bin/sh
# Installs the hivenod agent CLI: curl -fsSL https://hivenod.com/install.sh | sh
# then runs `hivenod connect` (item EJ2Cxq4k): a one-click confirm in the browser, the Claude Code
# plugin set up, and Claude Code started (HIVENOD_NO_CONNECT=1 only installs).
# Downloads the binary for this machine from the release manifest, checks its SHA-256 checksum
# (manifest and the .sha256 file next to the binary must both match) and puts it in
# $HIVENOD_INSTALL_DIR (default ~/.local/bin). Nothing is installed if a check fails.
# HIVENOD_WEB_URL points it at a self-hosted Hivenod.
set -eu

site="${HIVENOD_WEB_URL:-https://hivenod.com}"
site="${site%/}"
dir="${HIVENOD_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'hivenod install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "this script is for Linux and macOS; on Windows run: irm $site/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no hivenod binary for $(uname -m) yet" ;;
esac
target="$os-$arch"

if command -v curl >/dev/null 2>&1; then
  get() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  get() { wget -q "$1" -O "$2"; }
else
  fail "needs curl or wget"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "needs sha256sum or shasum to check the download"
fi

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t hivenod)"
trap 'rm -rf "$tmp"' EXIT INT TERM

get "$site/cli/bin/latest.json?t=$(date +%s)" "$tmp/latest.json" || fail "could not read $site/cli/bin/latest.json"
# The manifest is one JSON object; pull this target's entry without needing jq.
entry="$(tr -d '\n\r' < "$tmp/latest.json" | sed -e "s/.*\"$target\"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/")"
case "$entry" in *'"sha256"'*) ;; *) fail "the release has no binary for $target" ;; esac
field() { printf '%s' "$entry" | sed -e "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/"; }
path="$(field path)"
want="$(field sha256)"
version="$(tr -d '\n\r' < "$tmp/latest.json" | sed -e 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
case "$want" in *[!0-9a-f]* | '') fail "bad checksum in the manifest" ;; esac
[ "${#want}" -eq 64 ] || fail "bad checksum in the manifest"

say "Downloading hivenod $version for $target…"
get "$site$path" "$tmp/hivenod" || fail "could not download $site$path"
get "$site$path.sha256" "$tmp/hivenod.sha256" || fail "could not download $site$path.sha256"
got="$(sha "$tmp/hivenod")"
side="$(cut -d' ' -f1 < "$tmp/hivenod.sha256")"
if [ "$got" != "$want" ] || [ "$got" != "$side" ]; then
  fail "checksum mismatch for $path (got $got): nothing was installed"
fi

mkdir -p "$dir"
chmod 755 "$tmp/hivenod"
mv -f "$tmp/hivenod" "$dir/hivenod"
say "Installed $("$dir/hivenod" --version) in $dir/hivenod"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "Add $dir to your PATH, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
esac
if [ -n "${HIVENOD_NO_CONNECT:-}" ]; then
  say "Next: hivenod connect"
  exit 0
fi
say ""
# Piped from curl, stdin is the script: give connect (and Claude Code after it) the terminal.
status=0
if [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
  "$dir/hivenod" connect </dev/tty || status=$?
else
  "$dir/hivenod" connect --no-start || status=$?
fi
exit "$status"
