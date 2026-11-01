#!/usr/bin/env bash
# FPL AI on AWS (infra/template.yaml). Run from anywhere:
#   infra/deploy.sh stack        create or update the AWS resources
#   infra/deploy.sh models       upload trained models (data/models) for the scheduled refresh
#   infra/deploy.sh pull-models  download them (the scheduled refresh does this first)
#   infra/deploy.sh snapshots    upload the raw FPL API snapshots (data/raw/snapshots)
#   infra/deploy.sh pull-data    download the published data JSON and raw snapshots (the refresh checks against them)
#   infra/deploy.sh site         build the web app and publish it
set -euo pipefail
cd "$(dirname "$0")/.."
STACK=${STACK:-fpl-ai}

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

case "${1:-}" in
  stack)
    aws cloudformation deploy --stack-name "$STACK" --template-file infra/template.yaml \
      --capabilities CAPABILITY_IAM --parameter-overrides "GitHubRepo=${GITHUB_REPO:-rith777/fpl_ai}"
    echo "Site: $(out SiteUrl)"
    echo "GitHub repository variable AWS_ROLE_ARN = $(out RefreshRoleArn)"
    ;;
  models)
    aws s3 sync data/models "s3://$(out DataBucket)/models" --delete
    ;;
  pull-models)
    aws s3 sync "s3://$(out DataBucket)/models" data/models --delete
    ;;
  snapshots)
    aws s3 sync data/raw/snapshots "s3://$(out DataBucket)/raw"
    ;;
  pull-data)
    for f in players teams history; do aws s3 cp "s3://$(out SiteBucket)/$f.json" web/public/; done
    aws s3 sync "s3://$(out DataBucket)/raw" data/raw/snapshots --quiet
    ;;
  site)
    (cd web && npm run build)
    bucket=$(out SiteBucket)
    # Hashed assets never change; data refreshes every few hours; the page itself is always checked.
    aws s3 sync web/dist "s3://$bucket" --delete --exclude "*.json" --exclude index.html \
      --cache-control "public,max-age=31536000,immutable"
    aws s3 sync web/dist "s3://$bucket" --delete --exclude "*" --include "*.json" \
      --exclude pending_transfers.json --cache-control "public,max-age=300"
    aws s3 cp web/dist/index.html "s3://$bucket/index.html" --cache-control "no-cache"
    aws cloudfront create-invalidation --distribution-id "$(out DistributionId)" --paths "/*" > /dev/null
    echo "Published: $(out SiteUrl)"
    ;;
  *)
    sed -n '2,8p' "$0"
    exit 1
    ;;
esac
