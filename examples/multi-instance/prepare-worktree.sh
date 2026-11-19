#!/bin/sh
# Run from the instance's Execution settings with project-a or project-b.
set -eu

case "${1-}" in
  project-a) base=/srv/superagent-bases/project-a; branch=main ;;
  project-b) base=/srv/superagent-bases/project-b; branch=main ;;
  *) printf '%s\n' 'Choose project-a or project-b.' >&2; exit 2 ;;
esac

git -C "$base" worktree add -b "agent/${DSH_SUPERAGENT_NAME:?}" "${DSH_SUPERAGENT_DIR:?}" "refs/remotes/origin/$branch"
