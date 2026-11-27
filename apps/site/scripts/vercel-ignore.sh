#!/bin/sh
# Vercel's Ignored Build Step for loamnet.com, named by "ignoreCommand" in ../vercel.json. Vercel runs it in
# this project's Root Directory (apps/site) before it installs anything. Exit 0 skips the build, exit 1 builds.
#
# The site is rebuilt only when something under apps/site has changed:
#   - since the last successful deployment of the same branch (VERCEL_GIT_PREVIOUS_SHA). Comparing with the
#     parent commit instead would lose a change whose own build was cancelled, which Vercel does to a queued
#     build when a newer commit arrives;
#   - on a branch's first deployment, against the production branch, so a pull request that doesn't touch
#     the site gets no preview.
# Whenever the answer can't be worked out it builds: a needless build costs a minute, a missed one leaves
# the site stale.
#
# Vercel's clone holds only the last 10 commits, so the commit to compare with may have to be fetched. A
# dependency of the site that changes only in pnpm-lock.yaml or pnpm-workspace.yaml doesn't count as a change
# and ships with the next one. To deploy regardless, use Redeploy in the Vercel dashboard (the commit that is
# already live always builds), or untick "Use project's Ignore Build Step" there.

production_branch=master

build() {
  echo "vercel-ignore: building: $1"
  exit 1
}

skip() {
  echo "vercel-ignore: skipping the build: $1"
  exit 0
}

head=$(git rev-parse --verify --quiet HEAD) || build "git can't read HEAD"
base=$VERCEL_GIT_PREVIOUS_SHA
against="the last deployment of this branch"

if [ -z "$base" ]; then
  if [ "$VERCEL_ENV" = "production" ]; then
    build "there is no earlier production deployment to compare with"
  fi
  git fetch --quiet --depth=1 origin "$production_branch" 2>/dev/null ||
    build "couldn't fetch $production_branch to compare with"
  base=$(git rev-parse --verify --quiet "FETCH_HEAD^{commit}") ||
    build "couldn't read the fetched $production_branch"
  against=$production_branch
fi

if [ "$base" = "$head" ]; then
  build "this commit is the one already deployed, so someone asked for a redeploy"
fi

if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=1 origin "$base" 2>/dev/null
  git cat-file -e "$base^{commit}" 2>/dev/null ||
    build "commit $base isn't in this clone and couldn't be fetched"
fi

git diff --quiet "$base" "$head" -- .
case $? in
  0) skip "nothing under apps/site differs from $against ($base)" ;;
  1) build "apps/site differs from $against ($base)" ;;
  *) build "git diff failed" ;;
esac
