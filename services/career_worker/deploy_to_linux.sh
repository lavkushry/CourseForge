#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# CourseForge Career Studio Deployment Script
# Target: Production Linux Server (ubuntu@130.210.19.226)
# ==============================================================================

TARGET_HOST="ubuntu@130.210.19.226"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/ssh-key-2026-08-30.key}"
REMOTE_COURSEFORGE_DIR="/home/ubuntu/CourseForge"
LOCAL_COURSEFORGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
if [ -f "${SSH_KEY}" ]; then
  SSH_OPTS="${SSH_OPTS} -i ${SSH_KEY}"
fi

echo "🚀 Deploying CourseForge Career Studio to ${TARGET_HOST}..."

# 1. Sync Services, Migrations, Backend & Web to remote preserving exact directory hierarchy (-R)
echo "📦 Syncing code to ${TARGET_HOST}:${REMOTE_COURSEFORGE_DIR}..."
cd "${LOCAL_COURSEFORGE_DIR}"
rsync -avz -R -e "ssh ${SSH_OPTS}" \
  --exclude '.git' --exclude 'node_modules' --exclude '__pycache__' --exclude '.venv' --exclude '.pytest_cache' \
  services/career_worker \
  backend \
  web \
  "${TARGET_HOST}:${REMOTE_COURSEFORGE_DIR}/"
rsync -avz --delete -e "ssh ${SSH_OPTS}" \
  backend/cmd/ "${TARGET_HOST}:${REMOTE_COURSEFORGE_DIR}/backend/cmd/"
rsync -avz --delete -e "ssh ${SSH_OPTS}" \
  --exclude '__pycache__' \
  backend/internal/ "${TARGET_HOST}:${REMOTE_COURSEFORGE_DIR}/backend/internal/"
rsync -avz --delete -e "ssh ${SSH_OPTS}" \
  web/src/ "${TARGET_HOST}:${REMOTE_COURSEFORGE_DIR}/web/src/"
rsync -avz --delete -e "ssh ${SSH_OPTS}" \
  web/tests/ "${TARGET_HOST}:${REMOTE_COURSEFORGE_DIR}/web/tests/"

if [ -f "/Users/lavkushkumar/Desktop/Resume/applied_jobs.db" ]; then
  rsync -avz -e "ssh ${SSH_OPTS}" \
    /Users/lavkushkumar/Desktop/Resume/applied_jobs.db \
    /Users/lavkushkumar/Desktop/Resume/outreach_tracker.json \
    "${TARGET_HOST}:/home/ubuntu/Resume/"
fi

# 2. Run remote commands: migration, systemd install, build & restart
echo "⚙️ Executing remote configuration on ${TARGET_HOST}..."
ssh ${SSH_OPTS} "${TARGET_HOST}" 'bash -se' << 'EOF'
set -euo pipefail

cd /home/ubuntu/CourseForge

echo "1. Applying PostgreSQL Migration 015_career_studio.sql..."
if docker ps --format '{{.Names}}' | grep -q '^courseforge-rewrite-postgres-1$'; then
  docker exec -i courseforge-rewrite-postgres-1 psql -U courseforge -d courseforge_rewrite < backend/internal/store/migrations/015_career_studio.sql
elif docker ps --format '{{.Names}}' | grep -q '^courseforge_db$'; then
  docker exec -i courseforge_db psql -U courseforge -d courseforge_rewrite < backend/internal/store/migrations/015_career_studio.sql
else
  echo "Warning: postgres docker container not detected running. Skipping direct psql injection."
fi

echo "2. Installing Python requirements for career_worker..."
/home/ubuntu/Resume/.venv/bin/pip install -q fastapi uvicorn pydantic psycopg2-binary httpx

echo "3. Migrating legacy SQLite & JSON tracker data to PostgreSQL..."
PG_URL="postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable"
if [ -f /home/ubuntu/CourseForge/deploy/go-api.env ]; then
  ENV_PG_URL="$(grep '^CF_DATABASE_URL=' /home/ubuntu/CourseForge/deploy/go-api.env | cut -d= -f2- || true)"
  if [ -n "${ENV_PG_URL}" ]; then
    PG_URL="${ENV_PG_URL}"
  fi
fi

if [ -f /home/ubuntu/Resume/applied_jobs.db ]; then
  PYTHONPATH=/home/ubuntu/CourseForge /home/ubuntu/Resume/.venv/bin/python3 \
    services/career_worker/migrate_data.py \
    --sqlite-db /home/ubuntu/Resume/applied_jobs.db \
    --outreach-json /home/ubuntu/Resume/outreach_tracker.json \
    --pg-url "${PG_URL}" \
    --user-id "lavkush"
  PYTHONPATH=/home/ubuntu/CourseForge /home/ubuntu/Resume/.venv/bin/python3 \
    services/career_worker/migrate_data.py \
    --sqlite-db /home/ubuntu/Resume/applied_jobs.db \
    --outreach-json /home/ubuntu/Resume/outreach_tracker.json \
    --pg-url "${PG_URL}" \
    --user-id "usr_lavkush"
fi

echo "4. Installing systemd user services and timers..."
mkdir -p ~/.config/systemd/user/
cp services/career_worker/systemd/*.service ~/.config/systemd/user/
cp services/career_worker/systemd/*.timer ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now courseforge-career-worker.service
systemctl --user restart courseforge-career-worker.service
systemctl --user enable --now courseforge-career-agy.timer
systemctl --user enable --now courseforge-career-label.timer
systemctl --user enable --now courseforge-career-mutate.timer
systemctl --user enable --now courseforge-career-digest.timer

echo "5. Building CourseForge Web Frontend..."
cd /home/ubuntu/CourseForge/web
npm run build
if [ -d /home/ubuntu/releases/20261026-f1eb844/web/dist ] && [ -w /home/ubuntu/releases/20261026-f1eb844/web/dist ]; then
  rsync -av --delete /home/ubuntu/CourseForge/web/dist/ /home/ubuntu/releases/20261026-f1eb844/web/dist/
fi

echo "6. Restarting CourseForge Go API..."
cd /home/ubuntu/CourseForge/backend
mkdir -p /home/ubuntu/CourseForge/bin
go build -o /home/ubuntu/CourseForge/bin/courseforge-api ./cmd/api
go build -o api ./cmd/api
systemctl --user restart courseforge-api@18090.service || true
systemctl --user restart courseforge-api@18091.service || true
systemctl --user restart courseforge-api.service || true

echo "7. Verifying Career Worker Sidecar Health (:18095)..."
sleep 2
curl -sf http://127.0.0.1:18095/health

echo ""
echo "✅ Deployment finished successfully!"
EOF

echo "🎉 CourseForge Career Studio is live on ${TARGET_HOST}!"
