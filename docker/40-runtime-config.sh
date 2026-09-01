#!/bin/sh
set -e

json_quote() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

BUILD_ID="$(date +%s)"
printf '%s\n' "$BUILD_ID" > /usr/share/nginx/html/build-id.txt

cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__RUGIN_ENV__ = {
  VITE_SERVER_URL: "$(json_quote "${VITE_SERVER_URL:-}")",
  VITE_WS_URL: "$(json_quote "${VITE_WS_URL:-}")",
  VITE_APP_URL: "$(json_quote "${VITE_APP_URL:-}")",
  VITE_RUGIN_CDN: "$(json_quote "${VITE_RUGIN_CDN:-}")",
  VITE_HUGIN_CDN: "$(json_quote "${VITE_RUGIN_CDN:-${VITE_HUGIN_CDN:-}}")",
  VITE_DEV_MODE: "$(json_quote "${VITE_DEV_MODE:-false}")",
  VITE_MOBILE_WIDTH: "$(json_quote "${VITE_MOBILE_WIDTH:-850}")",
  VITE_MESSAGE_LIMIT: "$(json_quote "${VITE_MESSAGE_LIMIT:-50}")",
  VITE_TURNSTILE_SITEKEY: "$(json_quote "${VITE_TURNSTILE_SITEKEY:-}")",
  VITE_EMOJI_URL: "$(json_quote "${VITE_EMOJI_URL:-}")",
  VITE_OFFICIAL_SERVER: "$(json_quote "${VITE_OFFICIAL_SERVER:-rugin}")",
  VITE_LIVEKIT_ENABLED: "$(json_quote "${VITE_LIVEKIT_ENABLED:-false}")",
  VITE_BUILD_ID: "$(json_quote "${BUILD_ID}")"
};
window.__CONCORD_ENV__ = window.__RUGIN_ENV__;
EOF

API_URL="${VITE_SERVER_URL%/}"
API_PROXY=""
if [ -n "$API_URL" ]; then
  # A literal proxy_pass host resolves once at nginx startup and is cached
  # for the worker's lifetime, so a redeploy of api (new internal IP) 502s
  # this container until it's manually restarted (`docker restart` the web
  # container fixes it). Tried routing through a `set $upstream_*` variable
  # + resolver to force re-resolution instead — that broke request proxying
  # outright (confirmed: it silently turns the socket.io WS upgrade into a
  # plain request, which engine.io then rejects; very likely breaks /api/
  # and the CDN proxy too, both of which 404'd everything the moment this
  # was live). Not worth the risk — back to a literal host, restart web
  # manually after redeploying api/cdn/ws/livekit.
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

CDN_URL="${VITE_RUGIN_CDN:-$VITE_HUGIN_CDN}"
CDN_URL="${CDN_URL%/}"
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
  # NOTE: unlike the other proxy blocks, this one intentionally uses a
  # literal proxy_pass, not a \$upstream_* variable. A variable target here
  # breaks the WebSocket upgrade handshake (nginx returns it as a plain
  # request, which engine.io then rejects with "Bad request") even with all
  # the Upgrade/Connection headers correctly set. ws is redeployed on its
  # own far less often than api, so the manual `docker restart` workaround
  # for stale DNS is an acceptable trade-off here.
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
