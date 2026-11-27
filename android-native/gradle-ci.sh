#!/usr/bin/env bash
# Gradle for GitHub's Android jobs. A fresh runner sometimes fails plugin
# resolution before the repos answer, and Gradle reports that as "plugin
# was not found", hiding the DNS or connection error (gradle/gradle#23836).
# That failed the check on 26 Nov and twice on 27 Nov, each time with the
# Kotlin plugin that is on Maven Central. On e91f186c the immediate second
# try failed as well, and the same files passed six minutes later. Wait,
# then try again, twice, ignoring the cache so a cached miss can't stick.
# Any other failure stops at once. The last of these still stands: rerun
# the job and it starts on another machine.
#   ./gradle-ci.sh :kit:test :app:assembleGithubDebug :app:assembleFdroidRelease
set -euo pipefail
cd "$(dirname "$0")"
log="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/threadbear-gradle-ci.log"

run_gradle() {
  set +e
  ./gradlew --no-daemon "$@" 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}
  set -e
}

plugin_miss() {
  grep -q "could not resolve plugin artifact" "$log"
}

run_gradle "$@"
if [ "$code" = 0 ]; then
  exit 0
fi

# Long enough for a repo that is briefly refusing, short of holding the job
# for a plugin that really is not there.
for wait in 15 45; do
  if ! plugin_miss; then
    exit "$code"
  fi
  echo "Plugin resolution failed with its cause hidden. Waiting ${wait}s, then trying again."
  sleep "$wait"
  run_gradle --refresh-dependencies --stacktrace "$@"
  if [ "$code" = 0 ]; then
    exit 0
  fi
done
exit "$code"
