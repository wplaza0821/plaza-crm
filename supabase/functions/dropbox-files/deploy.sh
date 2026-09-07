#!/usr/bin/env bash
# Deploy the Dropbox edge functions to the Plaza CRM Supabase project.
#
#   export DROPBOX_APP_KEY=...          # same app the 7am sync already uses
#   export DROPBOX_APP_SECRET=...
#   export DROPBOX_REFRESH_TOKEN=...
#   ./supabase/functions/dropbox-files/deploy.sh
#
# Deploys:  dropbox-files       (Documents tab: live check + fee scan)
#           dropbox-docs-sync   (daily proposal sync, replaces the Mac cron)
#
# Everything targets the project by --project-ref, so there is NO `supabase link`
# and no database-password prompt to stall on.
set -euo pipefail

PROJECT_REF="zhxwkntrndaeqtkmbtsh"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

command -v supabase >/dev/null || {
  echo "supabase CLI not found. Install it with:"
  echo "  brew install supabase/tap/supabase"
  exit 1
}

# Must be authenticated. `supabase login` opens a browser; SUPABASE_ACCESS_TOKEN
# (from https://supabase.com/dashboard/account/tokens) works headlessly.
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  if ! supabase projects list >/dev/null 2>&1; then
    echo "Not logged in to Supabase. Do ONE of these, then re-run this script:"
    echo "  supabase login"
    echo "  export SUPABASE_ACCESS_TOKEN=<token from https://supabase.com/dashboard/account/tokens>"
    exit 1
  fi
fi

# Prompt for anything not already exported. Input is VISIBLE on purpose: a
# hidden prompt is indistinguishable from a hung script.
ask() { # ask VARNAME "Prompt"
  local var="$1" prompt="$2" val="${!1:-}"
  if [ -z "$val" ]; then
    printf '%s (typing is visible): ' "$prompt"
    IFS= read -r val </dev/tty
  fi
  [ -n "$val" ] || { echo "$var is required"; exit 1; }
  printf -v "$var" '%s' "$val"
}

# Where the existing sync keeps its Dropbox credentials, if you would rather
# copy them across than retype:   grep -ri dropbox ~/.hermes/ -l
ask DROPBOX_APP_KEY       "Dropbox app key"
ask DROPBOX_APP_SECRET    "Dropbox app secret"
ask DROPBOX_REFRESH_TOKEN "Dropbox refresh token"

# Cron trigger secret: generated here if not supplied. Save the printed value —
# migration 008 needs it in Vault as 'sync_secret'.
SYNC_SECRET="${SYNC_SECRET:-$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)}"
# Dropbox paths that hold the project folders (comma-separated).
DROPBOX_PROJECTS_ROOTS="${DROPBOX_PROJECTS_ROOTS:-/William Plaza/2026 PROJECTS,/William Plaza/2025 PROJECTS}"

cd "$ROOT"

echo "==> setting secrets on $PROJECT_REF"
supabase secrets set --project-ref "$PROJECT_REF" \
  DROPBOX_APP_KEY="$DROPBOX_APP_KEY" \
  DROPBOX_APP_SECRET="$DROPBOX_APP_SECRET" \
  DROPBOX_REFRESH_TOKEN="$DROPBOX_REFRESH_TOKEN" \
  DROPBOX_PROJECTS_ROOTS="$DROPBOX_PROJECTS_ROOTS" \
  SYNC_SECRET="$SYNC_SECRET"

for FN in dropbox-files dropbox-docs-sync; do
  echo "==> deploying $FN"
  supabase functions deploy "$FN" --project-ref "$PROJECT_REF"
done

echo "==> verifying (unauthenticated POST must be 401, not 404)"
for FN in dropbox-files dropbox-docs-sync; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "https://${PROJECT_REF}.supabase.co/functions/v1/${FN}" \
    -H "Content-Type: application/json" -d '{}')
  case "$code" in
    401|403) echo "  $FN: OK (HTTP $code)";;
    404)     echo "  $FN: FAILED — still 404"; exit 1;;
    *)       echo "  $FN: HTTP $code — check: supabase functions logs $FN --project-ref $PROJECT_REF";;
  esac
done

cat <<EOF

Functions are live. Two one-time steps remain, both in the Supabase SQL editor
(https://supabase.com/dashboard/project/${PROJECT_REF}/sql):

1. Store the cron secret in Vault (paste exactly):
     select vault.create_secret('${SYNC_SECRET}', 'sync_secret');

2. Run supabase/migrations/008_sync_runs.sql — creates sync_runs and schedules
   the 7am document sync on Supabase.

Then in the CRM the rail footer shows "Documents · synced …"; click "Sync now"
to run the first one immediately. Once it reports a successful run, the Mac
cron for crm_dropbox_docs.py can be disabled.
EOF
