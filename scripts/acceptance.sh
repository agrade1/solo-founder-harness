#!/usr/bin/env bash
# Acceptance Test 1~5 자동 검증 (docs/ACCEPTANCE_TEST_CHECKLIST.md 기준)
# 외부 의존성 없이 실행. throwaway 프로젝트로 검증 후 정리한다.
set -uo pipefail
cd "$(dirname "$0")/.."

PROJ="_acceptance_check"
PDIR="projects/$PROJ"
HARNESS="npx tsx src/cli.ts"

PASS=0
FAIL=0
check() { # check "설명" <조건 종료코드>
  if [ "$2" -eq 0 ]; then echo "  OK   $1"; PASS=$((PASS+1));
  else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi
}

VAULT="projects/_acceptance_vault"
cleanup() { rm -rf "$PDIR" "$VAULT"; }
trap cleanup EXIT
cleanup

echo "== build =="
npm run -s build || { echo "빌드 실패"; exit 1; }

echo ""
echo "== Test 1: init =="
$HARNESS init "$PROJ" >/dev/null
test -d "$PDIR/docs";    check "docs 폴더 생성" $?
test -d "$PDIR/outputs"; check "outputs 폴더 생성" $?
for f in 00_IDEA.md TASKS.md CONTEXT_SUMMARY.md DECISIONS.md WORKLOG.md API_CONTRACT.md; do
  test -f "$PDIR/docs/$f"; check "docs/$f" $?
done

echo ""
echo "== Test 2: list =="
OUT="$($HARNESS list)"
echo "$OUT" | grep -q "Core Agents (8)";            check "8 core agents" $?
echo "$OUT" | grep -q "Common Prompt:.*(존재)";      check "common prompt 존재" $?
echo "$OUT" | grep -q "Workflows (4)";              check "workflows 출력" $?

echo ""
echo "== Test 3: run idea-validation =="
OUT="$($HARNESS run idea-validation --project "$PROJ")"
echo "$OUT" | grep -q "chief_of_staff → research → pm → red_team → founder_ceo"; check "workflow 순서" $?
test -f "$PDIR/docs/01_RESEARCH.md";     check "01_RESEARCH.md 저장" $?
test -f "$PDIR/docs/06_CEO_DECISION.md"; check "06_CEO_DECISION.md 저장" $?
test -f "$PDIR/outputs/run_state.json";  check "run_state.json 생성" $?
grep -q '"failed_agent": null' "$PDIR/outputs/run_state.json"; check "failed_agent 기록(null)" $?
grep -q '"completed_steps"' "$PDIR/outputs/run_state.json";    check "completed_steps 기록" $?
grep -q '"started_at"' "$PDIR/outputs/run_state.json";         check "started_at 기록" $?

echo ""
echo "== Test 4: summary =="
$HARNESS summary --project "$PROJ" >/dev/null
grep -q "## 다음 작업" "$PDIR/docs/CONTEXT_SUMMARY.md"; check "CONTEXT_SUMMARY 다음 작업 표시" $?
grep -q "## 현재 상태" "$PDIR/docs/CONTEXT_SUMMARY.md"; check "CONTEXT_SUMMARY 현재 상태 표시" $?

echo ""
echo "== Test 5: task-prompt =="
$HARNESS task-prompt --project "$PROJ" >/dev/null
TP="$PDIR/outputs/claude_code_task_prompt.md"
test -f "$TP"; check "claude_code_task_prompt.md 생성" $?
for h in "## Context" "## Task" "## Include" "## Exclude" "## Rules" "## Done Criteria"; do
  grep -qF "$h" "$TP"; check "섹션 $h" $?
done
grep -qF "패키지 설치" "$TP"; check "패키지 설치 금지 규칙" $?
grep -qF "배포" "$TP";       check "배포 금지 규칙" $?
grep -qF "DB" "$TP";         check "DB 변경 금지 규칙" $?

echo ""
echo "== Test 6: obsidian export (--vault) =="
$HARNESS run idea-validation --project "$PROJ" --vault "$VAULT" >/dev/null
VDIR="$VAULT/$PROJ"
test -f "$VDIR/idea-validation_run.md"; check "vault 인덱스 노트 생성" $?
test -f "$VDIR/research.md";            check "vault agent 노트 생성" $?
grep -q "^project:" "$VDIR/research.md";        check "노트 frontmatter" $?
grep -q "\[\[idea-validation_run\]\]" "$VDIR/research.md"; check "노트 wikilink(인덱스)" $?
grep -q "\[\[research\]\]" "$VDIR/idea-validation_run.md";  check "인덱스 wikilink(agent)" $?

echo ""
echo "== Test 7: run --resume =="
RS="$PDIR/outputs/run_state.json"
# pm에서 강제 실패 (idea-validation: chief_of_staff→research→pm→red_team→founder_ceo)
HARNESS_FAIL_AT=pm $HARNESS run idea-validation --project "$PROJ" >/dev/null 2>&1
grep -q '"status": "failed"' "$RS";        check "강제 실패 → status=failed" $?
grep -q '"failed_agent": "pm"' "$RS";      check "failed_agent=pm 기록" $?
grep -q '"resume_from": 2' "$RS";          check "resume_from=2 (pm step)" $?
# 완료 실행에 --resume → 덮어쓰기 방지 (재개 대상 아님)
$HARNESS run idea-validation --project "$PROJ" --resume >/dev/null 2>&1
grep -q '"status": "completed"' "$RS";     check "resume 후 status=completed" $?
grep -q '"resume_from": null' "$RS";       check "완료 후 resume_from=null" $?
grep -q '"founder_ceo"' "$RS";             check "resume 후 마지막 step 도달" $?
test -f "$PDIR/docs/06_CEO_DECISION.md";   check "resume 후 CEO 문서 생성" $?
# 완료 상태에서 재개 시도 → 덮어쓰기 없이 안내
OUT="$($HARNESS run idea-validation --project "$PROJ" --resume 2>&1)"
echo "$OUT" | grep -q "재개할 것이 없습니다"; check "완료 실행 재개 방지 안내" $?

echo ""
echo "== Test 8: token budget (--max-tokens) =="
# 호출당 100토큰(HARNESS_MOCK_TOKENS), 상한 250 → chief/research/pm 실행 후 예산 초과
OUT="$(HARNESS_MOCK_TOKENS=100 $HARNESS run idea-validation --project "$PROJ" --max-tokens 250 2>&1)"
grep -q '"failed_reason": "token_budget_exceeded"' "$RS"; check "예산 초과 → failed_reason 기록" $?
grep -q '"status": "failed"' "$RS";                       check "예산 초과 → status=failed" $?
grep -q '"resume_from": 3' "$RS";                         check "예산 초과 resume_from=3 (다음 step)" $?
echo "$OUT" | grep -q "80% 도달";                          check "80% 경고 출력" $?
# 예산 중단 시점엔 founder_ceo 미도달
node -e "const s=require('./$RS'); process.exit(s.completed_steps.includes('founder_ceo')?1:0)"; check "중단 시 founder_ceo 미실행" $?
# resume (예산 없이) → 완주
$HARNESS run idea-validation --project "$PROJ" --resume >/dev/null 2>&1
grep -q '"status": "completed"' "$RS"; check "resume 후 완료" $?
node -e "const s=require('./$RS'); process.exit(s.completed_steps.includes('founder_ceo')?0:1)"; check "resume 후 founder_ceo 실행" $?

echo ""
echo "== Test 9: approval gate (dev-preflight) =="
# 거부: stdin n → user_rejected 로 중단
echo n | $HARNESS run dev-preflight --project "$PROJ" >/dev/null 2>&1
grep -q '"failed_reason": "user_rejected"' "$RS"; check "승인 거부 → user_rejected" $?
grep -q '"status": "failed"' "$RS";               check "거부 → status=failed" $?
# --yes resume → 비대화 승인으로 완주
$HARNESS run dev-preflight --project "$PROJ" --resume --yes >/dev/null 2>&1
grep -q '"status": "completed"' "$RS";            check "--yes resume → 승인 완료" $?

echo ""
echo "== Test 10: Red Team 편향 분리 (critic 격리) =="
# mvp-planning: pm→ux_ui→design→[디자인 게이트]→tech_lead→[red_team⟲tech_lead]→founder_ceo
$HARNESS run mvp-planning --project "$PROJ" --yes >/dev/null 2>&1
RT="$PDIR/docs/05_RED_TEAM.md"
CEO="$PDIR/docs/06_CEO_DECISION.md"
grep -q "tech_lead:" "$RT";                 check "critic가 target(tech_lead) 결론은 봄" $?
if grep -q "ux_ui:" "$RT"; then false; else true; fi;  check "critic가 ux_ui 결론은 못 봄 (격리)" $?
if grep -q "pm:" "$RT"; then false; else true; fi;     check "critic가 pm 결론은 못 봄 (격리)" $?
grep -q "ux_ui:" "$CEO";                    check "일반 step(founder_ceo)은 full 컨텍스트 유지" $?

echo ""
echo "==================================="
echo " 결과: PASS=$PASS  FAIL=$FAIL"
echo "==================================="
[ "$FAIL" -eq 0 ] && { echo "ALL PASS ✅"; exit 0; } || { echo "일부 실패 ❌"; exit 1; }
