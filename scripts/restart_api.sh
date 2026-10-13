#!/bin/bash
pkill -f "/tmp/courseforge-api.current" || true
sleep 1
cp -f /tmp/courseforge-api.new /tmp/courseforge-api.current
export CF_DATABASE_URL="postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable"
export CF_HTTP_ADDR="127.0.0.1:18090"
nohup /tmp/courseforge-api.current >> /tmp/api.log 2>&1 &
sleep 2
echo "RESTARTED"
