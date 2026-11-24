#!/usr/bin/env bash
# Usage: doctor.sh  — run from the project repo. Checks tools, sign-ins and secret exposure.
source "$(dirname "$0")/_lib.sh"
ok=0; degraded=()
say() { printf '%-8s %s\n' "$1" "$2"; }
fix() { printf '         fix: %s\n' "$1"; }

AGY="$(agy_bin)"
if [ -n "$AGY" ]; then
  gm="$(cfg gemini_model gemini-4-neon-high)"
  # A real round trip is the only reliable sign-in check.
  reply="$(cd "${TMPDIR:-/tmp}" && run_with_timeout 180 "$AGY" -p "You are running non-interactively. Do not use any tools, do not create a plan or any files, and do not ask for approval. Reply in this message with exactly the word PONG and nothing else." --mode plan --model "$gm" --output-format text </dev/null 2>&1)"
  if printf '%s' "$reply" | grep -q PONG; then say OK "agy (Antigravity) $("$AGY" --version 2>/dev/null) — signed in, $gm responding"
  elif printf '%s' "$reply" | grep -qiE 'authenticat|sign ?in|log ?in'; then
    say MISSING "agy installed but not signed in"; fix "run 'agy' in a terminal once and sign in with Google"; degraded+=(Gemini)
  else say MISSING "agy did not respond: $(printf '%s' "$reply" | tail -1 | cut -c1-140)"; fix "run 'agy' in a terminal to see the error; check 'agy models' for '$gm'"; degraded+=(Gemini); fi
else say MISSING "Antigravity CLI (agy) — Gemini CLI no longer serves Free/Pro/Ultra accounts"
  fix "curl -fsSL https://antigravity.google/cli/install.sh | bash, then run 'agy' once to sign in"; degraded+=(Gemini); fi

if command -v codex >/dev/null; then
  if run_with_timeout 30 codex login status </dev/null >/dev/null 2>&1; then say OK "codex $(codex --version 2>/dev/null | head -1) — signed in"
  else say MISSING "codex installed but not signed in"; fix "codex login   (choose Sign in with ChatGPT)"; degraded+=(Codex); fi
else say MISSING "codex CLI"; fix "npm i -g @openai/codex, then: codex login (Sign in with ChatGPT)"; degraded+=(Codex); fi

if command -v gh >/dev/null; then
  if gh auth status >/dev/null 2>&1; then say OK "gh — signed in"; else say WARN "gh not signed in (needed for PRs)"; fix "gh auth login"; fi
else say WARN "gh CLI missing (needed for PRs)"; fix "brew install gh && gh auth login"; fi

if root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  say OK "git repo: $root"
  [ -f "$root/.multimodel/config.yaml" ] && say OK "config: .multimodel/config.yaml" || say INFO "no .multimodel/config.yaml yet (init_task.sh creates it)"
  secrets="$(find_secrets "$root")"
  if [ -n "$secrets" ]; then
    say INFO "secret-like files (Gemini is blocked from reading these automatically):"; printf '%s\n' "$secrets" | sed 's/^/           /'
    while IFS= read -r s; do
      git -C "$root" ls-files --error-unmatch "$s" >/dev/null 2>&1 && say WARN "secret-like file is TRACKED by git: $s (Codex can read it; consider removing it from git)"
    done <<<"$secrets"
  fi
else say WARN "not inside a git repository (Codex dispatch and PR steps need one)"; fi

echo
if [ ${#degraded[@]} -eq 0 ]; then echo "MODE: full — Claude + Gemini + Codex"
else echo "MODE: degraded — missing: ${degraded[*]} (a Claude subagent can stand in; say so in summaries)"; fi
