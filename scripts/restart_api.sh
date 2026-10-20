#!/bin/bash
pkill -f "/tmp/courseforge-api.current" || true
sleep 1
if [ -f /tmp/courseforge-api.new ]; then
    cp -f /tmp/courseforge-api.new /tmp/courseforge-api.current
fi
export CF_DATABASE_URL="postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable"
export CF_ARTIFACT_ROOT="/home/ubuntu/CourseForge"
export CF_REGISTRATION_OPEN="true"
export CF_REGISTRATION_MODE="open"
export CF_COOKIE_SECURE="false"
export CF_PUBLIC_ORIGIN="http://127.0.0.1:8000,https://courseforge.duckdns.org:8000,http://127.0.0.1:18090,http://127.0.0.1:18091,http://127.0.0.1:5173,https://127.0.0.1:8000"
export CF_MEDIA_MODE="external"
export CF_DB_MAX_CONNS="8"

export CF_HTTP_ADDR="127.0.0.1:18090"
nohup /tmp/courseforge-api.current >> /tmp/api-18090.log 2>&1 &

export CF_HTTP_ADDR="127.0.0.1:18091"
nohup /tmp/courseforge-api.current >> /tmp/api-18091.log 2>&1 &

sleep 2
echo "RESTARTED"
