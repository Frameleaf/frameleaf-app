# shellcheck shell=sh
# FL-1442: the files one half of the web lint covers; sourced by the Lint Web Half jobs in test.yml.
# `components` is src/lib/components and `rest` is everything else, so the two halves lint every file once.
case "$HALF" in
  components) set -- src/lib/components ;;
  rest) set -- . --ignore-pattern 'src/lib/components/**' ;;
  *)
    echo "unknown web lint half: $HALF" >&2
    exit 1
    ;;
esac
