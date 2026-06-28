#!/usr/bin/env bash
# scripts/release.sh — Push + tag + GitHub release in one shot.
#
# This box doesn't have `gh` CLI installed, so we go straight through the
# GitHub REST API. The OAuth token is pulled from the git credential
# helper (Windows Credential Manager on this box) so the user doesn't
# need to set GITHUB_TOKEN manually.
#
# Usage:
#   ./scripts/release.sh <version-tag> [notes-file]
#
# Examples:
#   ./scripts/release.sh v1.0.3 docs/sprint/v1.0.3-test-report.md
#   ./scripts/release.sh v1.0.4
#
# What it does:
#   1. git push origin main (idempotent)
#   2. git tag -a <version> (skipped if tag already exists)
#   3. git push origin <version>
#   4. curl POST to https://api.github.com/repos/<owner>/<repo>/releases
#      with the release notes body. On HTTP 201 prints the release URL.
#
# Exit codes:
#   0 success
#   1 bad usage / file missing / git push failed
#   2 GitHub API returned non-201 (auth failure, validation, etc.)

set -euo pipefail

VERSION="${1:-}"
NOTES_FILE="${2:-}"

# ---- arg validation ----
if [[ -z "$VERSION" ]]; then
  cat >&2 <<USAGE
Usage: $0 <version-tag> [notes-file]

  version-tag   e.g. v1.0.3 (must start with 'v')
  notes-file    Markdown file with the release notes body.
                Default: docs/sprint/<version-without-v>-test-report.md
USAGE
  exit 1
fi

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "warning: tag '$VERSION' doesn't look like semver (vN.M.M[-pre])" >&2
fi

if [[ -z "$NOTES_FILE" ]]; then
  # Convention: docs/sprint/<version>-test-report.md (keep the leading 'v')
  NOTES_FILE="docs/sprint/${VERSION}-test-report.md"
  echo "==> using default notes file: $NOTES_FILE"
fi

if [[ ! -f "$NOTES_FILE" ]]; then
  echo "notes file not found: $NOTES_FILE" >&2
  exit 1
fi

# ---- 1. push main ----
echo "==> git push origin main"
git push origin main

# ---- 2. create tag (idempotent) ----
if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "==> tag $VERSION already exists, skipping create"
else
  echo "==> creating annotated tag $VERSION"
  git tag -a "$VERSION" -m "$VERSION — release"
fi

# ---- 3. push tag ----
echo "==> git push origin $VERSION"
git push origin "$VERSION"

# ---- 4. fetch GitHub token via credential helper ----
# (avoid bash heredoc nested in command substitution — that doesn't parse
#  in git-bash. Use a temp file for the credential output instead.)
creds_file=$(mktemp)
trap 'rm -f "$creds_file"' EXIT
git credential fill > "$creds_file" <<CREDS
protocol=https
host=github.com
CREDS

gh_token=$(grep '^password=' "$creds_file" | sed 's/^password=//' || true)
if [[ -z "$gh_token" ]]; then
  echo "failed to read GitHub token from git credential helper" >&2
  echo "  hint: check 'git config --get credential.helper' and that you can" >&2
  echo "  successfully push to github.com from this machine." >&2
  exit 1
fi
echo "==> got token (length ${#gh_token})"

# ---- 5. build JSON payload via python (Windows python defaults to GBK; force UTF-8) ----
payload_file=$(mktemp)
trap 'rm -f "$creds_file" "$payload_file"' EXIT

PYTHONIOENCODING=utf-8 python - "$VERSION" "$NOTES_FILE" "$payload_file" <<'PY'
import json, sys, re
version, notes_path, out = sys.argv[1], sys.argv[2], sys.argv[3]

with open(notes_path, 'r', encoding='utf-8') as f:
    body = f.read()

# Derive a friendlier release title from the test-report's first H1 if
# it exists, otherwise fall back to "<version> — release".
m = re.search(r'^#\s+(.+)$', body, flags=re.MULTILINE)
title = m.group(1).strip() if m else f"{version} — release"
# Strip any leading "Sprint " / trailing punctuation
title = re.sub(r'\s+—.*$', '', title) if '—' in title else title

payload = {
    'tag_name': version,
    'target_commitish': 'main',
    'name': f"{version} — {title}",
    'body': body,
    'draft': False,
    'prerelease': False,
    'generate_release_notes': False,
}
with open(out, 'w', encoding='utf-8') as f:
    json.dump(payload, f, ensure_ascii=False)
PY

# ---- 6. POST release ----
repo=$(git config --get remote.origin.url | sed 's|.*github.com[:/]||; s|\.git$||')
echo "==> creating release on https://github.com/$repo/releases"

response_file=$(mktemp)
trap 'rm -f "$creds_file" "$payload_file" "$response_file"' EXIT

http_code=$(curl -s -X POST \
  -H "Authorization: token $gh_token" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$repo/releases" \
  --data-binary @"$payload_file" \
  -o "$response_file" \
  -w "%{http_code}")

if [[ "$http_code" == "201" ]]; then
  echo "✓ release created"
  PYTHONIOENCODING=utf-8 python - "$response_file" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding='utf-8'))
print(f"  tag:     {r.get('tag_name')}")
print(f"  name:    {r.get('name')}")
print(f"  url:     {r.get('html_url')}")
print(f"  body:    {len(r.get('body', ''))} chars")
print(f"  draft:   {r.get('draft')}, prerelease: {r.get('prerelease')}")
PY
  exit 0
else
  echo "✗ release failed: HTTP $http_code" >&2
  cat "$response_file" >&2
  exit 2
fi