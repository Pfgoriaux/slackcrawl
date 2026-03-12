#!/bin/sh
set -e

REPO="Pfgoriaux/slackcrawl"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" && exit 1 ;;
esac

case "$OS" in
  linux|darwin) ;;
  *) echo "Unsupported OS: $OS (use Windows .exe from releases)" && exit 1 ;;
esac

BINARY="slackcrawl-${OS}-${ARCH}"
URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

echo "Downloading ${BINARY}..."
curl -fSL -o "$TMPFILE" "$URL"
chmod 755 "$TMPFILE"

mkdir -p "$INSTALL_DIR" 2>/dev/null || sudo mkdir -p "$INSTALL_DIR"

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "$INSTALL_DIR/slackcrawl"
else
  sudo mv "$TMPFILE" "$INSTALL_DIR/slackcrawl"
fi

echo "Installed slackcrawl to ${INSTALL_DIR}/slackcrawl"
