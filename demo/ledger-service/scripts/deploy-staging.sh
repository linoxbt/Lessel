#!/usr/bin/env bash
# Deploys this commit to staging and waits until staging serves it.
# Railway (recommended): RAILWAY_TOKEN (project token, secured), RAILWAY_SERVICE (e.g. ledger-staging), STAGING_URL.
# Any other host: STAGING_DEPLOY_HOOK_URL (secured), STAGING_URL.
# Works with any host that has a deploy hook and exposes the commit on /health
# (Railway sets RAILWAY_GIT_COMMIT_SHA, Render sets RENDER_GIT_COMMIT; otherwise set GIT_COMMIT).
set -euo pipefail
: "${STAGING_URL:?set STAGING_URL}"
commit="${BITBUCKET_COMMIT:-unknown}"
if [ -n "${RAILWAY_TOKEN:-}" ]; then
  : "${RAILWAY_SERVICE:?set RAILWAY_SERVICE}"
  # Upload this checkout's ledger service and wait for the build; GIT_COMMIT lets /health report the commit.
  (cd services/ledger && GIT_COMMIT="$commit" npx -y @railway/cli up --service "$RAILWAY_SERVICE" --ci)
  echo "Railway deploy finished for $commit"
else
  : "${STAGING_DEPLOY_HOOK_URL:?set STAGING_DEPLOY_HOOK_URL or RAILWAY_TOKEN}"
  curl -fsS -X POST "$STAGING_DEPLOY_HOOK_URL" > /dev/null
  echo "Deploy triggered for $commit"
fi
for i in $(seq 1 60); do
  served=$(curl -fsS "$STAGING_URL/health" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).commit??"")}catch{console.log("")}})' || true)
  if [ -n "$served" ] && [ "${commit#"$served"}" != "$commit" ] || [ "$served" = "$commit" ]; then
    echo "Staging is serving $served"; exit 0
  fi
  if [ -z "$served" ] && [ "$i" -ge 12 ]; then
    echo "Staging doesn't report a commit; assuming the deploy finished."; exit 0
  fi
  sleep 10
done
echo "Staging didn't pick up $commit within 10 minutes"; exit 1
