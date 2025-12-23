#!/bin/bash

# codex-task.sh
# Helper wrapper for Codex CLI that enforces timeouts and standardized autonomy modes.
# Usage:
#   ./scripts/codex-task.sh "Task description..."
#   ./scripts/codex-task.sh -t 8 "Long task..."
#   ./scripts/codex-task.sh -m gpt-5-codex "Task..."
#   ./scripts/codex-task.sh -q "Task..."
#   ./scripts/codex-task.sh --mode full-auto "Task..."
#   ./scripts/codex-task.sh --mode controlled "Task..."
#   ./scripts/codex-task.sh --mode yolo "Task..."   # only in hardened environments

set -euo pipefail

# Defaults
TIMEOUT_MIN=5
MODEL=""
QUIET=false
MODE="full-auto"  # full-auto | controlled | yolo
TASK=""

usage() {
  cat <<'EOF'
Usage: scripts/codex-task.sh [-m model] [-q] [-t timeout_minutes] [--mode full-auto|controlled|yolo] [task_description]
  -m model      : Specify the model to use (passed to: codex exec --model <model>)
  -q            : Quiet mode (suppress stderr)
  -t minutes    : Timeout in minutes (default: 5, max: 10)
  --mode MODE   : Autonomy mode: full-auto (default), controlled, yolo
  task_description : The task prompt (optional if provided via stdin)
EOF
  exit 1
}

# Parse short options
while getopts ":m:t:q" opt; do
  case "${opt}" in
    m) MODEL="${OPTARG}" ;;
    t) TIMEOUT_MIN="${OPTARG}" ;;
    q) QUIET=true ;;
    \?) echo "Invalid option: -${OPTARG}" >&2; usage ;;
    :)  echo "Option -${OPTARG} requires an argument." >&2; usage ;;
  esac
done
shift $((OPTIND - 1))

# Parse long options
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || { echo "Error: --mode requires an argument." >&2; usage; }
      MODE="$2"
      shift 2
      ;;
    --mode=*)
      MODE="${1#*=}"
      shift 1
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Error: Unknown option '$1'." >&2
      usage
      ;;
    *)
      break
      ;;
  esac
done

# Validate timeout
if ! [[ "${TIMEOUT_MIN}" =~ ^[0-9]+$ ]]; then
  echo "Error: Timeout must be an integer (minutes)." >&2
  exit 1
fi

if [[ "${TIMEOUT_MIN}" -gt 10 ]]; then
  echo "Warning: Timeout of ${TIMEOUT_MIN} minutes exceeds limit. Capping at 10 minutes." >&2
  TIMEOUT_MIN=10
fi

TIMEOUT_SEC=$((TIMEOUT_MIN * 60))

# Get task from args or stdin
if [[ $# -ge 1 ]]; then
  TASK="$*"
else
  if [[ ! -t 0 ]]; then
    TASK="$(cat)"
  fi
fi

if [[ -z "${TASK}" ]]; then
  echo "Error: No task description provided." >&2
  usage
fi

# Build codex exec arguments
CMD="codex"
ARGS=("exec")

if [[ -n "${MODEL}" ]]; then
  ARGS+=("--model" "${MODEL}")
fi

case "${MODE}" in
  full-auto)
    ARGS+=("--full-auto")
    ;;
  controlled)
    ARGS+=("--sandbox" "workspace-write" "--ask-for-approval" "on-request")
    ;;
  yolo)
    # Dangerous: bypasses sandbox/approvals. Use only in hardened environments.
    ARGS+=("--yolo")
    ;;
  *)
    echo "Error: Unknown --mode '${MODE}'. Use: full-auto | controlled | yolo" >&2
    exit 1
    ;;
esac

ARGS+=("${TASK}")

# Execute with timeout and output capture
if [[ "${QUIET}" == true ]]; then
  OUTPUT="$(timeout "${TIMEOUT_SEC}" "${CMD}" "${ARGS[@]}" 2>/dev/null)" || EXIT_CODE=$?
else
  OUTPUT="$(timeout "${TIMEOUT_SEC}" "${CMD}" "${ARGS[@]}")" || EXIT_CODE=$?
fi

EXIT_CODE="${EXIT_CODE:-0}"

if [[ "${EXIT_CODE}" -eq 124 ]]; then
  if [[ "${QUIET}" == false ]]; then
    echo "Error: Operation timed out after ${TIMEOUT_MIN} minutes." >&2
  fi
  exit 124
fi

echo "${OUTPUT}"
exit "${EXIT_CODE}"
