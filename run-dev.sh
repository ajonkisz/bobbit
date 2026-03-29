#!/bin/bash
# Run Bobbit dev harness with colors preserved in both terminal and log file.
# Usage: ./run-dev.sh
#
# - Builds server first
# - Logs to log.txt with timestamps (colors stripped for readability)
# - Terminal output keeps full colors
# - Ctrl+C stops everything cleanly

set -e

cd "$(dirname "$0")"

echo "Building server..."
npm run build:server

echo "Starting dev harness..."
# Use 'script' to force a PTY so npm/node emit ANSI colors,
# then tee to terminal (with colors) and strip colors for the log file.
# 'unbuffer' from expect package is another option but 'script' is built-in on macOS.
script -q /dev/null npm run dev:harness 2>&1 | tee >(sed 's/\x1b\[[0-9;]*m//g' > log.txt)
