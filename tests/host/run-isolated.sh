#!/usr/bin/env bash
set -euo pipefail
plugin_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
project_root=$(dirname -- "$plugin_root")
if [[ ${1:-synthetic} == live ]]; then
  # The host shell retains this kernel lock across bwrap's private PID namespace
  # and descriptor closing. Acquire it before migration or shared profile writes.
  mkdir -p -- "$project_root/.backup-scratch"
  exec {live_lock}>>"$project_root/.backup-scratch/live-runner.lock"
  flock -n "$live_lock" || { echo "Live runner already running for this profile/evidence scope" >&2; exit 75; }
fi
scratch="$project_root/.backup-scratch/host"
mkdir -p -- "$scratch"
shared=(--die-with-parent --clearenv --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp --dir /home --dir /home/sandbox --ro-bind "$HOME/.opencode/bin/opencode" /opencode --ro-bind "$(command -v node)" /node --ro-bind "$plugin_root" /plugin --bind "$scratch" /work --setenv HOME /home/sandbox --setenv PATH /usr/bin:/bin --setenv PYTHONDONTWRITEBYTECODE 1 --chdir /work)
if [[ -n ${TASK_AWARE_RELEASE:-} ]]; then
  shared+=(--ro-bind "$TASK_AWARE_RELEASE" /release --setenv TASK_AWARE_PLUGIN_PATH /release)
fi
if [[ ${1:-synthetic} == live ]]; then
  # This is unique qualification evidence and reserved spend, not disposable cache.
  qualification="$project_root/qualification"
  legacy="$scratch/live/profile/home/.local/state/opencode/task-aware-approvals"
  mkdir -p -m 700 -- "$qualification"
  if [[ ! -e "$qualification/selection.json" && -f "$legacy/selection.json" ]]; then
    install -m 600 -- "$legacy/selection.json" "$qualification/selection.json"
    if [[ -f "$legacy/selection.previous.json" ]]; then
      install -m 600 -- "$legacy/selection.previous.json" "$qualification/selection.previous.json"
    fi
  fi
  shared+=(--bind "$qualification" /evidence --bind "$qualification" /work/live/profile/home/.local/state/opencode/task-aware-approvals)
  model_catalog=${TASK_AWARE_MODEL_CATALOG:-"$project_root/.backup-scratch/native-models.json"}
  [[ -f "$model_catalog" ]] || { echo "Native V2 catalog checkpoint required before live qualification" >&2; exit 1; }
  # Credentials and provider DB/cache never get copied into project scratch.
  # Do not exec: bwrap closes inherited descriptors; this parent must keep the
  # lock for the entire host lifetime, including preflight and acceptance.
  bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts "${shared[@]}" --ro-bind /etc /etc --ro-bind "$(readlink -f /etc/resolv.conf)" "$(readlink -f /etc/resolv.conf)" --ro-bind "$HOME/.local/share/opencode/auth.json" /auth.json --ro-bind "$model_catalog" /models.json /usr/bin/python3 /plugin/tests/host/live_qualification.py "${@:2}"
  exit "$?"
fi
exec bwrap --unshare-all "${shared[@]}" /usr/bin/python3 -m pytest /plugin/tests/host/test_plugin.py -x -q -p no:cacheprovider --basetemp "/work/synthetic-${RANDOM}"
