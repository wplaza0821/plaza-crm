#!/usr/bin/env bash
# Deploy the dropbox-files edge function to the Plaza CRM Supabase project.
#
#   export DROPBOX_APP_KEY=...
#   export DROPBOX_APP_SECRET=...
#   export DROPBOX_REFRESH_TOKEN=...
#   ./supabase/functions/dropbox-files/deploy.sh
#
# Everything targets the project by --project-ref, so there is NO `supabase link`
# and therefore no database-password prompt to stall on. Reuse the SAME app
# credentials the 7am crm_dropbox_docs.py sync already uses — that app is live
# and, as of 2026-08-10, carries sharing.write.
set -euo pipefail

PROJECT_REF="zhxwkntrndaeqtkmbtsh"
FN="dropbox-files"
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
# copy them across than retype:
#   grep -ri dropbox ~/.hermes/ -l
ask DROPBOX_APP_KEY       "Dropbox app key"
ask DROPBOX_APP_SECRET    "Dropbox app secret"
ask DROPBOX_REFRESH_TOKEN "Dropbox refresh token"

cd "$ROOT"

echo "==> setting secrets on $PROJECT_REF"
supabase secrets set --project-ref "$PROJECT_REF" \
  DROPBOX_APP_KEY="$DROPBOX_APP_KEY" \
  DROPBOX_APP_SECRET="$DROPBOX_APP_SECRET" \
  DROPBOX_REFRESH_TOKEN="$DROPBOX_REFRESH_TOKEN"

echo "==> deploying $FN (first deploy pulls the unpdf dependency; ~30-60s)"
supabase functions deploy "$FN" --project-ref "$PROJECT_REF"

echo "==> verifying"
# Unauthenticated POST must now be REJECTED (401), not missing (404).
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "https://${PROJECT_REF}.supabase.co/functions/v1/${FN}" \
  -H "Content-Type: application/json" -d '{"action":"list","path":"/"}')
case "$code" in
  401|403) echo "OK — function is live and rejecting unauthenticated calls (HTTP $code)";;
  404)     echo "FAILED — still 404. The deploy did not land; check the output above."; exit 1;;
  *)       echo "Unexpected HTTP $code — function responded, but check the logs:"
           echo "  supabase functions logs $FN --project-ref $PROJECT_REF";;
esac

cat <<'EOF'

Next: in the CRM, open a deal, set its Dropbox folder in the Edit tab
(e.g. /Proposals/Dome, exactly as it appears in Dropbox), then open the
Documents tab and use "Check Dropbox now" / "Scan for fee".

If a call fails, the message names the cause:
  invalid_grant     refresh token wrong, or issued for a different app
  path/not_found    the folder path does not match Dropbox exactly
  missing_scope     enable files.metadata.read + files.content.read, then Submit
EOF
