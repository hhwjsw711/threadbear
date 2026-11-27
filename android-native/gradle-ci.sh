#!/usr/bin/env bash
# Gradle for GitHub's Android jobs. A fresh runner sometimes fails plugin
# resolution before the repos answer, and Gradle reports that as "plugin
# was not found", hiding the DNS or connection error (gradle/gradle#23836).
# That failed the check on 26 Nov and again on 27 Nov, both times with the
# Kotlin plugin that is on Maven Central, and the next run of the same
# files passed. One more try, ignoring the cache so a cached miss can't
# stick. The second failure stands.
#   ./gradle-ci.sh :kit:test :app:assembleGithubDebug :app:assembleFdroidRelease
set -euo pipefail
cd "$(dirname "$0")"
log="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/threadbear-gradle-ci.log"
set +e
./gradlew --no-daemon "$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
if [ "$code" = 0 ]; then
  exit 0
fi
if grep -q "could not resolve plugin artifact" "$log"; then
  echo "Plugin resolution failed with its cause hidden. Trying once more."
  exec ./gradlew --no-daemon --refresh-dependencies --stacktrace "$@"
fi
exit "$code"
