#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
repo="${1:-courseforge-local}"
owner="lavkushry"
if ! command -v gh >/dev/null 2>&1; then
  echo 'GitHub CLI is missing. Install using: brew install gh' >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo 'Please authenticate first: gh auth login' >&2
  exit 1
fi
if [ ! -d .git ]; then
  echo 'Expected a git repository. Use the GitHub-ready ZIP package.' >&2
  exit 1
fi
# Create a private repository. Refuse to overwrite an existing remote/repository.
if gh repo view "$owner/$repo" >/dev/null 2>&1; then
  echo "Repository $owner/$repo already exists. Refusing to overwrite." >&2
  echo "If it is your empty repository, run: git remote add origin git@github.com:$owner/$repo.git && git push -u origin main" >&2
  exit 1
fi
if git remote get-url origin >/dev/null 2>&1; then
  echo 'Remote origin already exists; refusing to replace it.' >&2
  exit 1
fi
gh repo create "$owner/$repo" --private --source=. --remote=origin --push
echo "Published: https://github.com/$owner/$repo"
