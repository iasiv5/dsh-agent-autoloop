#!/bin/sh
# Says how much CI a run needs, as scope=docs, normal, kernel or full. Text no test reads skips everything, and everything
# else gets the quick tests. The simulation only imports kernel/ and protocol/, so those and its own parts add a short one:
# breaking each kernel condition in turn showed the quick tests already catch what the long runs do. The long runs come with
# nightly and before a release; a pull request only gets them for the two files nothing else would run, or a diff it can't
# get. What reaches main gets the quick tests, text too: a commit whose run a newer push replaced is checked by the next one,
# whatever that is.
set -u

if [ "${GITHUB_EVENT_NAME:-}" = push ]; then
  echo "scope=normal"
  exit 0
fi

# Without --no-renames, moving a file out of kernel/ would show only where it landed.
if [ "${GITHUB_EVENT_NAME:-}" != pull_request ] ||
  ! files=$(git diff --no-renames --name-only HEAD^1 HEAD 2>/dev/null) || [ -z "$files" ]; then
  echo "scope=full"
  exit 0
fi

scope=docs
while IFS= read -r file; do
  case "$file" in
    # tests/example-plugins.test.ts runs the commands in this tutorial.
    docs/plugins.md) kind=normal ;;
    README.md | README.en.md | INSTALL.md | SECURITY.md | CONTRIBUTING.md | AGENTS.md | LICENSE) kind=docs ;;
    docs/* | .github/ISSUE_TEMPLATE/* | .github/pull_request_template.md) kind=docs ;;
    tests/simulation.test.ts | sim/enumerate.ts) kind=full ;;
    kernel/* | protocol/* | sim/random.ts | sim/world.ts | sim/invariants.ts) kind=kernel ;;
    # The DSH-native plugin package is ordinary code: quick tests, no simulation.
    dsh/*) kind=normal ;;
    *) kind=normal ;;
  esac
  case "$kind" in
    full) scope=full ;;
    kernel) [ "$scope" = full ] || scope=kernel ;;
    normal) [ "$scope" = docs ] && scope=normal ;;
  esac
done <<END
$files
END

echo "scope=$scope"
