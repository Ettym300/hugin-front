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
  VITE_HUGIN_CDN: "$(json_quote "${VITE_HUGIN_CDN:-}")",
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
# Strip scheme+host for Docker DNS re-resolve (nginx resolves bare hostnames at start).
api_host_port() {
  printf '%s' "$1" | sed -E 's#^https?://##'
}
API_HOSTPORT="$(api_host_port "$API_URL")"
API_PROXY=""
if [ -n "$API_URL" ]; then
  API_PROXY="  location /api/ {
    set \$api_upstream http://${API_HOSTPORT};
    proxy_pass \$api_upstream/api/;
    proxy_http_version 1.1;
    proxy_set_header Host \$proxy_host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_ssl_server_name on;
  }"
fi

CDN_URL="${VITE_HUGIN_CDN%/}"
# CDN_UPSTREAM lets nginx reach the CDN on a private address while the browser
# keeps using same-origin paths (VITE_HUGIN_CDN empty). Falls back to
# VITE_HUGIN_CDN so existing deployments behave exactly as before.
CDN_UPSTREAM_URL="${CDN_UPSTREAM:-$CDN_URL}"
CDN_UPSTREAM_URL="${CDN_UPSTREAM_URL%/}"
CDN_HOSTPORT="$(api_host_port "$CDN_UPSTREAM_URL")"
CDN_PROXY=""
if [ -n "$CDN_UPSTREAM_URL" ]; then
  CDN_PROXY="  location ~ ^/(avatars|profile_banners|attachments|emojis|proxy)/ {
    set \$cdn_upstream http://${CDN_HOSTPORT};
    proxy_pass \$cdn_upstream;
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
WS_HOSTPORT="$(api_host_port "$WS_URL")"
WS_PROXY=""
if [ -n "$WS_URL" ]; then
  WS_PROXY="  location /socket.io/ {
    set \$ws_upstream http://${WS_HOSTPORT};
    proxy_pass \$ws_upstream/socket.io/;
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
LIVEKIT_HOSTPORT="$(api_host_port "$LIVEKIT_URL")"
LIVEKIT_PROXY=""
if [ -n "$LIVEKIT_URL" ]; then
  LIVEKIT_PROXY="  location /livekit/ {
    set \$livekit_upstream http://${LIVEKIT_HOSTPORT};
    proxy_pass \$livekit_upstream/;
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

  # Docker embedded DNS — re-resolve upstreams so deploys don't crash nginx
  # when api/ws/cdn are briefly unavailable at start.
  resolver 127.0.0.11 valid=10s ipv6=off;

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
