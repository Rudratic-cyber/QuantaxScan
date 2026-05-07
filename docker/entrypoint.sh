#!/bin/sh
set -e

API_BASE_URL="${API_BASE_URL:-}"
CONFIG_PATH="/usr/share/nginx/html/config.js"

printf 'window.__APP_CONFIG__ = { apiBaseUrl: "%s" };\n' "$API_BASE_URL" > "$CONFIG_PATH"

exec "$@"
