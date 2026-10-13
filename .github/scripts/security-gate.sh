#!/usr/bin/env bash
# Blocking security checks for a pull request.
#
# Usage: security-gate.sh <base-sha> <head-sha>
#
# Runs from a trusted checkout of the base branch (pull_request_target) and treats the PR purely
# as git data: nothing from the PR is executed, and the gitleaks config/ignore files come from the
# base checkout, so a PR cannot weaken the rules it is checked against.
#
# Env: GITLEAKS (binary, default "gitleaks"), GITHUB_STEP_SUMMARY (optional).
# Exit: 0 pass, 1 security problem found, 2 the gate itself could not run (fails closed).
set -euo pipefail

base=${1:-}
head=${2:-}
sha_re='^[0-9a-f]{40}([0-9a-f]{24})?$'
if [[ ! $base =~ $sha_re || ! $head =~ $sha_re ]]; then
  echo "usage: security-gate.sh <base-sha> <head-sha> (full commit SHAs)" >&2
  exit 2
fi

gitleaks_bin=${GITLEAKS:-gitleaks}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
repo_root=$(git rev-parse --show-toplevel)
config="$repo_root/.gitleaks.toml"
work=$(mktemp -d)
cleanup() {
  git worktree remove --force "$work/tree" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

for sha in "$base" "$head"; do
  git cat-file -e "$sha^{commit}" 2>/dev/null || { echo "commit $sha is not available locally" >&2; exit 2; }
done
merge_base=$(git merge-base "$base" "$head")
failures=()

# 1. Files that hold secrets by nature must not be committed at all.
#    Private keys inside text files are left to gitleaks, which inspects their content.
while IFS= read -r -d '' path; do
  name=${path##*/}
  case "$name" in
    .env.example | .env.sample | .env.template | .env.dist | .env.*.example) ;;
    .env | .env.*) failures+=("환경 변수 파일이 커밋되어 있습니다: \`$path\`") ;;
    id_rsa | id_dsa | id_ecdsa | id_ed25519 | *.p12 | *.pfx | *.jks | *.keystore)
      failures+=("개인 키/키스토어 파일이 커밋되어 있습니다: \`$path\`") ;;
  esac
done < <(git ls-tree -r -z --name-only "$head")

# 2. .gitignore (in the PR) must keep local env files out of future commits.
#    Only .gitignore files are checked out (sparse), with hooks and LFS smudging disabled.
git -c core.hooksPath=/dev/null worktree add --quiet --no-checkout --detach "$work/tree" "$head"
git -C "$work/tree" sparse-checkout set --no-cone '.gitignore' >/dev/null
GIT_LFS_SKIP_SMUDGE=1 git -C "$work/tree" -c core.hooksPath=/dev/null checkout --quiet --detach "$head"
for env_file in .env .env.local; do
  if ! git -C "$work/tree" check-ignore -q --no-index -- "$env_file"; then
    failures+=("\`.gitignore\`가 \`$env_file\` 파일을 제외하지 않습니다. \`.env\`와 \`.env.*\` 패턴을 추가하세요.")
  fi
done

# 3. Secrets (API keys, tokens, private keys) in any commit of the PR, not just the final tree:
#    a key added and removed again within the PR is still published in its history.
report="$work/gitleaks.json"
set +e
"$gitleaks_bin" git "$repo_root" \
  --no-banner --redact --ignore-gitleaks-allow --exit-code 3 \
  --config "$config" --gitleaks-ignore-path "$repo_root" \
  --log-opts="$merge_base..$head" \
  --report-format json --report-path "$report"
status=$?
set -e
case $status in
  0) ;;
  3)
    # Leaks were found, so the gate fails even if the report cannot be read (never fail open).
    if findings=$(jq -r '.[] | "비밀값 의심(\(.RuleID)): `\(.File)`:\(.StartLine) — 커밋 \(.Commit[0:12])"' "$report") &&
      [[ -n $findings ]]; then
      while IFS= read -r line; do failures+=("$line"); done <<<"$findings"
    else
      failures+=("gitleaks가 비밀값을 발견했지만 상세 보고서를 읽지 못했습니다. 실행 로그를 확인하세요.")
    fi
    ;;
  *)
    echo "gitleaks failed with exit code $status" >&2
    exit 2
    ;;
esac

{
  echo '## 보안 검사 (security-gate)'
  echo
  if ((${#failures[@]} == 0)); then
    echo '✅ 필수 보안 문제가 발견되지 않았습니다.'
  else
    echo "❌ 필수 보안 문제 ${#failures[@]}건 — 해결하기 전에는 merge할 수 없습니다."
    echo
    for failure in "${failures[@]}"; do echo "- $failure"; done
    echo
    echo '비밀값이 한 번이라도 push되었다면 파일을 지우는 것만으로는 부족합니다. **해당 키를 즉시 폐기·재발급**하세요.'
  fi
} | tee -a "$summary"

((${#failures[@]} == 0)) || exit 1
