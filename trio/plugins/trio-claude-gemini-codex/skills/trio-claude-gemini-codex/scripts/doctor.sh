#!/usr/bin/env bash
# Usage: doctor.sh  — run from the project repo. Checks tools, sign-ins and secret exposure.
source "$(dirname "$0")/_lib.sh"
degraded=(); ready=1
say() { printf '%-8s %s\n' "$1" "$2"; }
fix() { printf '         fix: %s\n' "$1"; }

for dep in git python3; do
  if command -v "$dep" >/dev/null; then say OK "$dep installed"; else say MISSING "$dep required"; ready=0; fi
done
[ "$ready" -eq 1 ] || { echo "MODE: unavailable — missing core dependencies"; exit 1; }
for key in gemini_timeout codex_timeout; do
  case "$key" in gemini_timeout) default=900;; *) default=2400;; esac
  value="$(cfg "$key" "$default")" || { ready=0; continue; }
  valid_timeout "$value" || { say WARN "invalid $key: $value"; ready=0; }
done
for key in codex_reasoning_effort codex_review_reasoning_effort; do
  value="$(cfg "$key")" || { ready=0; continue; }
  valid_effort "$value" || { say WARN "invalid $key: $value"; ready=0; }
done
AGY="$(agy_bin)"
if [ -n "$AGY" ]; then
  gm="$(cfg gemini_model gemini-4-neon-high)" || gm=""
  if [[ "$gm" != gemini-* ]]; then
    say MISSING "gemini_model must start with gemini-"; degraded+=(Gemini)
  else
  # A real round trip is the only reliable sign-in check.
  reply="$(cd "${TMPDIR:-/tmp}" && run_with_timeout 180 "$AGY" -p "You are running non-interactively. Do not use any tools, do not create a plan or any files, and do not ask for approval. Reply in this message with exactly the word PONG and nothing else." --mode plan --model "$gm" --output-format json </dev/null 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 0 ] && [ "$(printf '%s' "$reply" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("response","").strip() if d.get("status")=="SUCCESS" else "")' 2>/dev/null)" = PONG ]; then say OK "agy (Antigravity) $("$AGY" --version 2>/dev/null) — signed in, $gm responding"
  elif printf '%s' "$reply" | grep -qiE 'authenticat|sign ?in|log ?in'; then
    say MISSING "agy installed but not signed in"; fix "run 'agy' in a terminal once and sign in with Google"; degraded+=(Gemini)
  else say MISSING "agy did not respond (exit $rc): $(printf '%s' "$reply" | tail -1 | cut -c1-140)"; fix "run 'agy' in a terminal to see the error; check 'agy models' for '$gm'"; degraded+=(Gemini); fi
  fi
else say MISSING "Antigravity CLI (agy) — Gemini CLI no longer serves Free/Pro/Ultra accounts"
  fix "curl -fsSL https://antigravity.google/cli/install.sh | bash, then run 'agy' once to sign in"; degraded+=(Gemini); fi

if command -v codex >/dev/null; then
  if run_with_timeout 30 codex login status </dev/null >/dev/null 2>&1; then say OK "codex $(codex --version 2>/dev/null | head -1) — signed in"
  else say MISSING "codex login status failed or timed out"; fix "codex login   (choose Sign in with ChatGPT)"; degraded+=(Codex); fi
else say MISSING "codex CLI"; fix "npm i -g @openai/codex, then: codex login (Sign in with ChatGPT)"; degraded+=(Codex); fi

if command -v gh >/dev/null; then
  if run_with_timeout 30 gh auth status >/dev/null 2>&1; then say OK "gh — signed in"; else say WARN "gh not signed in (needed for PRs)"; fix "gh auth login"; ready=0; fi
else say WARN "gh CLI missing (needed for PRs)"; fix "brew install gh && gh auth login"; ready=0; fi

if root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  say OK "git repo: $root"
  [ -f "$root/.multimodel/config.yaml" ] && say OK "config: .multimodel/config.yaml" || say INFO "no .multimodel/config.yaml yet (init_task.sh creates it)"
  if ! secrets="$(find_secrets "$root")"; then say WARN "cannot determine Gemini exclusions"; ready=0; fi
  if [ -n "$secrets" ]; then
    say INFO "secret-like files (Gemini receives best-effort deny rules for these):"; printf '%s\n' "$secrets" | sed 's/^/           /'
    while IFS= read -r s; do
      git -C "$root" ls-files --error-unmatch "$s" >/dev/null 2>&1 && say WARN "secret-like file is TRACKED by git: $s (Codex can read it; consider removing it from git)"
    done <<<"$secrets"
  fi
else say WARN "not inside a git repository (Codex dispatch and PR steps need one)"; ready=0; fi

echo
if [ ${#degraded[@]} -eq 0 ]; then
  if [ "$ready" -eq 1 ]; then echo "MODE: full — Claude + Gemini + Codex"; else echo "MODE: limited — configuration or PR prerequisites need attention"; fi
else echo "MODE: degraded — missing: ${degraded[*]} (a Claude subagent can stand in; say so in summaries)"; fi
[ "$ready" -eq 1 ] && [ ${#degraded[@]} -eq 0 ]
