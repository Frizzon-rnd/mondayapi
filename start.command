#!/bin/bash
# Double-click this file in Finder to start the monday.com ticker.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed on this Mac."
  echo "Install it from https://nodejs.org (LTS version), then double-click this file again."
  read -p "Press Enter to close this window..."
  exit 1
fi

echo "Starting monday.com Live Ticker..."
( sleep 2 && open "http://localhost:4173" ) &
node server.js
