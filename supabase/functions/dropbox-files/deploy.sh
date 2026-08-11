#!/usr/bin/env bash
# Deploy the dropbox-files edge function to the Plaza CRM Supabase project.
#
#   ./supabase/functions/dropbox-files/deploy.sh
#
# Reads the three Dropbox values from the environment if they are already set,
# otherwise prompts for them (secret input is not echoed). Reuse the SAME app
# credentials the 7am crm_dropbox_docs.py sync already uses — that app is live
# and, as of 2026-08-10, carries sharing.write. Registering a second app is
# unnecessary and gives you two tokens to rotate.
set -euo pipefail

PROJECT_REF="zhxwkntrndaeqtkmbtsh"
FN="dropbox-files"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

command -v supabase >/dev/null || {
  echo "supabase CLI not found. Install it with:"
  echo "  brew install supabase/tap/supabase"
  exit 1
}

# Where the existing sync keeps its Dropbox credentials, if you want to copy
# them across rather than retype:
#   grep -ri dropbox ~/.hermes/ --include='*.env' --include='*.json' --include='*.py' -l
ask() { # ask VARNAME "Prompt"
  local var="$1" prompt="$2" val="${!1:-}"
  if [ -z "$val" ]; then
    read -rsp "$prompt: " val; echo
  fi
  [ -n "$val" ] || { echo "$var is required"; exit 1; }
  printf -v "$var" '%s' "$val"
}

ask DROPBOX_APP_KEY       "Dropbox app key"
ask DROPBOX_APP_SECRET    "Dropbox app secret"
ask DROPBOX_REFRESH_TOKEN "Dropbox refresh token"

cd "$ROOT"
echo "==> linking project $PROJECT_REF"
supabase link --project-ref "$PROJECT_REF"

echo "==> setting secrets"
supabase secrets set \
  DROPBOX_APP_KEY="$DROPBOX_APP_KEY" \
  DROPBOX_APP_SECRET="$DROPBOX_APP_SECRET" \
  DROPBOX_REFRESH_TOKEN="$DROPBOX_REFRESH_TOKEN"

echo "==> deploying $FN"
supabase functions deploy "$FN"

echo "==> verifying"
# Unauthenticated POST must now be REJECTED (401), not missing (404).
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "https://${PROJECT_REF}.supabase.co/functions/v1/${FN}" \
  -H "Content-Type: application/json" -d '{"action":"list","path":"/"}')
case "$code" in
  401|403) echo "OK — function is live and rejecting unauthenticated calls (HTTP $code)";;
  404)     echo "FAILED — still 404. The deploy did not land; check the output above."; exit 1;;
  *)       echo "Unexpected HTTP $code — function responded, but check the logs:"
           echo "  supabase functions logs $FN";;
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
