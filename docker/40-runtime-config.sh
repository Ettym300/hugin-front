#!/bin/sh
set -e

json_quote() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

BUILD_ID="$(date +%s)"
printf '%s\n' "$BUILD_ID" > /usr/share/nginx/html/build-id.txt

cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__CONCORD_ENV__ = {
  VITE_SERVER_URL: "$(json_quote "${VITE_SERVER_URL:-}")",
  VITE_WS_URL: "$(json_quote "${VITE_WS_URL:-}")",
  VITE_APP_URL: "$(json_quote "${VITE_APP_URL:-}")",
  VITE_NERIMITY_CDN: "$(json_quote "${VITE_NERIMITY_CDN:-}")",
  VITE_DEV_MODE: "$(json_quote "${VITE_DEV_MODE:-false}")",
  VITE_MOBILE_WIDTH: "$(json_quote "${VITE_MOBILE_WIDTH:-850}")",
  VITE_MESSAGE_LIMIT: "$(json_quote "${VITE_MESSAGE_LIMIT:-50}")",
  VITE_TURNSTILE_SITEKEY: "$(json_quote "${VITE_TURNSTILE_SITEKEY:-}")",
  VITE_EMOJI_URL: "$(json_quote "${VITE_EMOJI_URL:-}")",
  VITE_OFFICIAL_SERVER: "$(json_quote "${VITE_OFFICIAL_SERVER:-concord}")",
  VITE_EMAIL_CONFIRMATION_ENABLED: "$(json_quote "${VITE_EMAIL_CONFIRMATION_ENABLED:-false}")",
  VITE_LIVEKIT_ENABLED: "$(json_quote "${VITE_LIVEKIT_ENABLED:-false}")",
  VITE_BUILD_ID: "$(json_quote "${BUILD_ID}")"
};
EOF

API_URL="${VITE_SERVER_URL%/}"
API_PROXY=""
if [ -n "$API_URL" ]; then
  API_PROXY="  location /api/ {
    proxy_pass ${API_URL}/api/;
    proxy_http_version 1.1;
    proxy_set_header Host \$proxy_host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_ssl_server_name on;
  }"
fi

CDN_URL="${VITE_NERIMITY_CDN%/}"
# CDN_UPSTREAM lets nginx reach the CDN on a private address while the browser
# keeps using same-origin paths (VITE_NERIMITY_CDN empty). Falls back to
# VITE_NERIMITY_CDN so existing deployments behave exactly as before.
CDN_UPSTREAM_URL="${CDN_UPSTREAM:-$CDN_URL}"
CDN_UPSTREAM_URL="${CDN_UPSTREAM_URL%/}"
CDN_PROXY=""
if [ -n "$CDN_UPSTREAM_URL" ]; then
  CDN_PROXY="  location ~ ^/(avatars|profile_banners|attachments|emojis|proxy)/ {
    proxy_pass ${CDN_UPSTREAM_URL};
    proxy_http_version 1.1;
    proxy_set_header Host \$proxy_host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_ssl_server_name on;
    client_max_body_size 20M;
  }"
fi

WS_URL="${VITE_WS_URL%/}"
WS_PROXY=""
if [ -n "$WS_URL" ]; then
  WS_PROXY="  location /socket.io/ {
    proxy_pass ${WS_URL}/socket.io/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \"upgrade\";
    proxy_set_header Host \$proxy_host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_ssl_server_name on;
  }"
fi

LIVEKIT_URL="${LIVEKIT_UPSTREAM%/}"
LIVEKIT_PROXY=""
if [ -n "$LIVEKIT_URL" ]; then
  LIVEKIT_PROXY="  location /livekit/ {
    proxy_pass ${LIVEKIT_URL}/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \"upgrade\";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
  }"
fi

cat > /etc/nginx/conf.d/default.conf <<EOF
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  client_max_body_size 20M;

  gzip on;
  gzip_types text/plain text/css application/javascript application/json image/svg+xml;

  location = /runtime-config.js {
    add_header Cache-Control "no-store";
  }

  location = /build-id.txt {
    add_header Cache-Control "no-store";
    add_header Content-Type "text/plain";
  }

  location = /index.html {
    add_header Cache-Control "no-store";
  }

${API_PROXY}

${CDN_PROXY}

${WS_PROXY}

${LIVEKIT_PROXY}

  location / {
    try_files \$uri \$uri/ /index.html;
    add_header Cache-Control "no-store";
  }
}
EOF
