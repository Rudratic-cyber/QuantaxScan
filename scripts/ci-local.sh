#!/usr/bin/env bash
#
# Local CI — the full gate, run on your machine.
#
# This repository cannot rely on a hosted runner, so this script IS the pipeline: it runs the
# same stages as .github/workflows/ci.yml, with one deliberate difference — typecheck is
# BLOCKING here. The hosted workflow marks it non-blocking, which is how 27 type errors
# accumulated while every PR showed a green check.
#
#   pnpm run ci                 full run
#   pnpm run ci --skip-ui       skip Playwright (no browsers / headless box)
#   pnpm run ci --keep-going    run every stage even after one fails, then report
#   pnpm run ci --quick         typecheck + unit tests only; no install, build, or UI
#
# Exit code is 0 only if every stage that ran passed.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

SKIP_UI=0
KEEP_GOING=0
QUICK=0

for arg in "$@"; do
  case "$arg" in
    --skip-ui)    SKIP_UI=1 ;;
    --keep-going) KEEP_GOING=1 ;;
    --quick)      QUICK=1; SKIP_UI=1 ;;
    -h|--help)    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            printf 'Unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

STAGE_NAMES=()
STAGE_RESULTS=()
STAGE_SECONDS=()
FAILED=0
LOG_DIR="$(mktemp -d)"

run_stage() {
  local name="$1"; shift
  local logfile="$LOG_DIR/${name// /-}.log"

  if (( FAILED > 0 && KEEP_GOING == 0 )); then
    STAGE_NAMES+=("$name"); STAGE_RESULTS+=("skipped"); STAGE_SECONDS+=("0")
    return 0
  fi

  printf '%s▸ %s%s\n' "$BLUE$BOLD" "$name" "$RESET"
  local start; start=$SECONDS

  if "$@" > "$logfile" 2>&1; then
    local elapsed=$(( SECONDS - start ))
    printf '  %s✓ passed%s %s(%ss)%s\n\n' "$GREEN" "$RESET" "$DIM" "$elapsed" "$RESET"
    STAGE_NAMES+=("$name"); STAGE_RESULTS+=("passed"); STAGE_SECONDS+=("$elapsed")
  else
    local elapsed=$(( SECONDS - start ))
    printf '  %s✗ FAILED%s %s(%ss)%s\n' "$RED$BOLD" "$RESET" "$DIM" "$elapsed" "$RESET"
    printf '%s' "$DIM"
    tail -n 30 "$logfile" | sed 's/^/  │ /'
    printf '%s  full log: %s\n\n' "$RESET" "$logfile"
    STAGE_NAMES+=("$name"); STAGE_RESULTS+=("FAILED"); STAGE_SECONDS+=("$elapsed")
    FAILED=$(( FAILED + 1 ))
  fi
}

printf '\n%sQuantaXscan — local CI%s\n' "$BOLD" "$RESET"
printf '%sbranch %s · %s%s\n\n' "$DIM" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')" "$(date '+%H:%M:%S')" "$RESET"

if (( QUICK == 0 )); then
  run_stage "install"        pnpm install --frozen-lockfile
fi

# Blocking, unlike the hosted workflow. Every package reports (--no-bail in the root script),
# so a failure in api-server can no longer hide one in the frontend.
run_stage "typecheck"        pnpm run typecheck

if (( QUICK == 0 )); then
  run_stage "build"          pnpm -r --if-present run build
fi

run_stage "test:libs"        pnpm run test:libs
run_stage "test:api"         pnpm run test:api
run_stage "test:scripts"     pnpm run test:scripts

# G-14. Standards data decays and nothing else would tell us. Cheap, offline, and it fails
# the build rather than waiting for a customer to notice a stale date in a report.
run_stage "standards"        pnpm run check:standards

if (( SKIP_UI == 0 )); then
  if npx playwright --version > /dev/null 2>&1; then
    run_stage "test:ui"      pnpm run test:ui
  else
    printf '%s▸ test:ui%s\n  %s⚠ skipped — Playwright not installed%s\n' "$BLUE$BOLD" "$RESET" "$YELLOW" "$RESET"
    printf '  %srun: npx playwright install --with-deps chromium%s\n\n' "$DIM" "$RESET"
    STAGE_NAMES+=("test:ui"); STAGE_RESULTS+=("skipped"); STAGE_SECONDS+=("0")
  fi
fi

printf '%s%s%s\n' "$BOLD" "────────────────────────────────────────" "$RESET"
for i in "${!STAGE_NAMES[@]}"; do
  case "${STAGE_RESULTS[$i]}" in
    passed)  mark="${GREEN}✓${RESET}" ;;
    FAILED)  mark="${RED}✗${RESET}"   ;;
    *)       mark="${YELLOW}−${RESET}" ;;
  esac
  printf '  %b %-12s %s%ss%s\n' "$mark" "${STAGE_NAMES[$i]}" "$DIM" "${STAGE_SECONDS[$i]}" "$RESET"
done
printf '%s%s%s\n' "$BOLD" "────────────────────────────────────────" "$RESET"

if (( FAILED > 0 )); then
  printf '\n%s%d stage(s) failed — do not push.%s\n\n' "$RED$BOLD" "$FAILED" "$RESET"
  exit 1
fi

printf '\n%sAll stages passed.%s\n\n' "$GREEN$BOLD" "$RESET"
rm -rf "$LOG_DIR"
exit 0
