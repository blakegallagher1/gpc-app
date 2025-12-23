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
  --mode=MODE   : Same as --mode MODE
  task_description : The task prompt (optional if provided via stdin)
EOF
  exit 1
}

# Parse short + long options (portable, no GNU getopt).
# Supports: -m MODEL / -mMODEL, -t MIN / -tMIN, -q, --mode MODE / --mode=MODE, and '--' end-of-options.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      shift
      [[ $# -ge 1 ]] || { echo "Error: --mode requires an argument." >&2; usage; }
      MODE="$1"
      shift
      ;;
    --mode=*)
      MODE="${1#*=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    -q)
      QUIET=true
      shift
      ;;
    -m)
      shift
      [[ $# -ge 1 ]] || { echo "Option -m requires an argument." >&2; usage; }
      MODEL="$1"
      shift
      ;;
    -m*)
      MODEL="${1#-m}"
      shift
      ;;
    -t)
      shift
      [[ $# -ge 1 ]] || { echo "Option -t requires an argument." >&2; usage; }
      TIMEOUT_MIN="$1"
      shift
      ;;
    -t*)
      TIMEOUT_MIN="${1#-t}"
      shift
      ;;
    -[!-]*)
      short_opts="${1#-}"
      shift
      i=0
      while [[ $i -lt ${#short_opts} ]]; do
        opt="${short_opts:$i:1}"
        case "${opt}" in
          q)
            QUIET=true
            i=$((i + 1))
            ;;
          m)
            arg="${short_opts:$((i + 1))}"
            if [[ -n "${arg}" ]]; then
              MODEL="${arg}"
            else
              [[ $# -ge 1 ]] || { echo "Option -m requires an argument." >&2; usage; }
              MODEL="$1"
              shift
            fi
            i=${#short_opts}
            ;;
          t)
            arg="${short_opts:$((i + 1))}"
            if [[ -n "${arg}" ]]; then
              TIMEOUT_MIN="${arg}"
            else
              [[ $# -ge 1 ]] || { echo "Option -t requires an argument." >&2; usage; }
              TIMEOUT_MIN="$1"
              shift
            fi
            i=${#short_opts}
            ;;
          *)
            echo "Invalid option: -${opt}" >&2
            usage
            ;;
        esac
      done
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
