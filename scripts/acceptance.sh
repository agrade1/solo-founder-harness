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

echo "== Test 11: 토큰 린트 (scripts/token-lint.mjs) =="
TL="$PDIR/tl"; mkdir -p "$TL/src"
printf '{"primitive":{"color":{"blue-500":"#3b82f6"}},"semantic":{"color":{"action":"{primitive.color.blue-500}"}},"component":{"btn":{"bg":"{semantic.color.action}"}}}\n' > "$TL/tokens.json"
printf 'const a="#ff0000";\nconst b="var(--primitive-color-blue-500)";\nconst c="#000"; // token-lint-ignore\n' > "$TL/src/bad.tsx"
node scripts/token-lint.mjs --tokens "$TL/tokens.json" "$TL/src" > "$TL/out.txt" 2>&1
[ $? -eq 1 ]; check "위반 소스 → exit 1" $?
grep -q "미등록 raw hex #ff0000" "$TL/out.txt"; check "미등록 hex 검출" $?
grep -q "primitive 토큰 직접 참조" "$TL/out.txt"; check "primitive 직접참조 검출" $?
if grep -q "#000" "$TL/out.txt"; then false; else true; fi; check "token-lint-ignore 줄 건너뜀" $?
printf 'const x="ok";\n' > "$TL/src/bad.tsx"
node scripts/token-lint.mjs --tokens "$TL/tokens.json" "$TL/src" >/dev/null 2>&1
[ $? -eq 0 ]; check "클린 소스 → exit 0" $?
printf '{"primitive":{"c":{"x":"#fff"}},"semantic":{"a":"{semantic.b}"}}\n' > "$TL/broken.json"
node scripts/token-lint.mjs --tokens "$TL/broken.json" "$TL/src" >/dev/null 2>&1
[ $? -eq 1 ]; check "깨진 tokens.json(계층위반/없는참조) → exit 1" $?

echo ""
echo "== Test 12: handoff (offline — 실제 claude/TUI 미실행) =="
# 직전 Test 10에서 run_state=completed. 실제 claude/preflight/spawn을 타지 않는 경로만 검증.
# 12a) --print: preflight/spawn/state 변경 없이 재진입 명령만 출력.
OUT="$($HARNESS handoff --project "$PROJ" --print 2>&1)"
echo "$OUT" | grep -q "harness handoff --project '$PROJ'"; check "--print → 재진입 명령 출력" $?
echo "$OUT" | grep -q -- "--yes";                          check "--print 재진입 명령에 --yes" $?
if [ -d "$PDIR/outputs/runtime" ]; then false; else true; fi; check "--print → runtime 디렉터리 미생성" $?
if grep -q '"handoff"' "$RS"; then false; else true; fi;   check "--print → run_state.handoff 미기록" $?
# 12b) claude 바이너리 부재 → 설치/재진입 안내, spawn·기록 없음(비-TTY보다 먼저 판정).
OUT="$(HARNESS_CLAUDE_BIN=/nonexistent/claude-xyz $HARNESS handoff --project "$PROJ" --yes 2>&1)"
echo "$OUT" | grep -q "claude CLI를 찾을 수 없습니다"; check "missing binary → 설치 안내" $?
if grep -q '"handoff"' "$RS"; then false; else true; fi;  check "missing binary → run_state.handoff 미기록" $?
grep -q '"status": "completed"' "$RS";                    check "missing binary → completed 상태 불변" $?
# 12c) run이 completed 아니면 handoff 거부.
echo n | $HARNESS run dev-preflight --project "$PROJ" >/dev/null 2>&1   # user_rejected → failed
# 출력을 먼저 캡처한다(handoff는 not_completed에서 exit 1 → pipefail 오판 방지).
OUT="$($HARNESS handoff --project "$PROJ" 2>&1)"
echo "$OUT" | grep -q "상태가 아닙니다"; check "not_completed → handoff 거부" $?

echo ""
echo "== Test 13: M4a durable orchestration (offline — network/LLM/provider/TTY 미사용) =="
# 임시 workspace에서만 도는 kernel 수직 슬라이스. 상세 체크는 스크립트가 자체 출력한다.
M4A_OUT="$(node scripts/m4a-offline-acceptance.mjs 2>&1)"
M4A_RC=$?
[ "$M4A_RC" -eq 0 ];                        check "M4a offline acceptance exit 0" $?
echo "$M4A_OUT" | grep -q " FAIL=0";        check "M4a 내부 체크 전부 통과" $?
echo "$M4A_OUT" | grep -q "child completed"; check "M4a result 전파 확인 출력" $?
if [ -d "outputs/orchestration" ]; then false; else true; fi
check "레포에 orchestration 산출물 미생성(임시 workspace 전용)" $?

echo ""
echo "== Test 14: M4b 배타 자원 class · scheduler · writer lock (offline) =="
# 임시 workspace 전용. 상세 체크는 스크립트가 자체 출력한다(기존 Test 1~13 무변경).
M4B_OUT="$(node scripts/m4b-offline-acceptance.mjs 2>&1)"
M4B_RC=$?
[ "$M4B_RC" -eq 0 ];                          check "M4b offline acceptance exit 0" $?
echo "$M4B_OUT" | grep -q " FAIL=0";          check "M4b 내부 체크 전부 통과" $?
echo "$M4B_OUT" | grep -q "b-live는 ready로 유예(동시 실행 0)"
check "M4b 같은 class 동시 실행 0 확인 출력" $?
echo "$M4B_OUT" | grep -q "stale_writer";     check "M4b stale writer 거부 확인 출력" $?
echo "$M4B_OUT" | grep -q "run_lock_held";    check "M4b writer lock 경합 거부 확인 출력" $?
if [ -d "outputs/orchestration" ]; then false; else true; fi
check "레포에 orchestration 산출물 미생성(임시 workspace 전용)" $?

echo ""
echo "== Test 15: M4c 라우팅 · 메시지 10종 · 승인 manifest · specialist registry (offline) =="
# 임시 workspace 전용. 상세 체크는 스크립트가 자체 출력한다(기존 Test 1~14 무변경).
M4C_OUT="$(node scripts/m4c-offline-acceptance.mjs 2>&1)"
M4C_RC=$?
[ "$M4C_RC" -eq 0 ];                              check "M4c offline acceptance exit 0" $?
echo "$M4C_OUT" | grep -q " FAIL=0";              check "M4c 내부 체크 전부 통과" $?
echo "$M4C_OUT" | grep -q "중앙이 sibling inbox로 route"
check "M4c 중앙 경유 sibling 전달 확인 출력" $?
echo "$M4C_OUT" | grep -q "route_not_related";    check "M4c 무관한 수신자 거부 확인 출력" $?
echo "$M4C_OUT" | grep -q "ambiguous_recipient";  check "M4c 모호한 수신자 거부 확인 출력" $?
echo "$M4C_OUT" | grep -q "중앙 → fresh reviewer inbox"
check "M4c reviewer 왕복 확인 출력" $?
echo "$M4C_OUT" | grep -q "manifest_expired";     check "M4c 만료 승인 거부 확인 출력" $?
echo "$M4C_OUT" | grep -q "max_sessions_exceeded"; check "M4c maxSessions 초과 거부 확인 출력" $?
echo "$M4C_OUT" | grep -q "dependency_not_pinned"; check "M4c 미pin dependency 거부 확인 출력" $?
echo "$M4C_OUT" | grep -q "state_pre_m4c_unsupported"
check "M4c pre-M4c state fail-closed 확인 출력" $?
if [ -d "outputs/orchestration" ]; then false; else true; fi
check "레포에 orchestration 산출물 미생성(임시 workspace 전용)" $?

echo ""
echo "== Test 16: M5d offline self-hosting (승인 1건 · 실제 파일 수정 · 수동 복사 0회) =="
# 임시 workspace 전용. 상세 체크는 스크립트가 자체 출력한다.
M5D_OUT="$(node scripts/m5d-offline-acceptance.mjs 2>&1)"
M5D_RC=$?
[ "$M5D_RC" -eq 0 ];                              check "M5d offline acceptance exit 0" $?
echo "$M5D_OUT" | grep -q " FAIL=0";              check "M5d 내부 체크 전부 통과" $?
echo "$M5D_OUT" | grep -q "버그 파일이 실제로 고쳐졌다"
check "M5d implement 단계가 실제 바이트를 냈다" $?
echo "$M5D_OUT" | grep -q "의존 task도 같은 실행에서 완주했다"
check "M5d DAG 전진(수동 개입 0) 확인 출력" $?
echo "$M5D_OUT" | grep -q "신규 파일 발행은 fail closed"
check "M5d B-16 잔여(신규 발행 차단) 확인 출력" $?
echo "$M5D_OUT" | grep -q "paused로 착지한다(hang 없음)"
check "M5d hang 대신 pause 확인 출력" $?
echo "$M5D_OUT" | grep -q "spawn 0회 — deadline/cancellation 자손 정리 증명 아님"
check "M5d spawn 0회 확인 출력(자손 정리 증명 아님)" $?
echo "$M5D_OUT" | grep -q "같은 배타 class의 두 task가 같은 batch에 함께 들어가지 않는다"
check "M5d 배타 resource class 동시 실행 0 확인 출력 (B-25)" $?
echo "$M5D_OUT" | grep -q "자식 프로세스가 durable 상태만으로 run을 이어받았다"
check "M5d 별도 프로세스 재시작 확인 출력 (B-26)" $?

echo ""
echo "== Test 17: M5 deadline·cancellation 자손 정리 (실제 spawn) =="
# 실제로 프로세스를 띄운다(다른 acceptance는 spawn 0회다). 임시 workspace 전용.
M5CL_OUT="$(node scripts/m5d-cleanup-acceptance.mjs 2>&1)"
M5CL_RC=$?
[ "$M5CL_RC" -eq 0 ];                             check "M5 cleanup acceptance exit 0" $?
echo "$M5CL_OUT" | grep -q " FAIL=0";             check "M5 cleanup 내부 체크 전부 통과" $?
echo "$M5CL_OUT" | grep -q "실제로 손자를 낳았다"
check "M5 실제 자손 생성 관측 출력" $?
echo "$M5CL_OUT" | grep -q "deadline 초과 뒤 손자가 실제로 죽었다"
check "M5 deadline 자손 정리 확인 출력 (B-24)" $?
echo "$M5CL_OUT" | grep -q "취소 뒤 손자가 실제로 죽었다"
check "M5 cancellation 자손 정리 확인 출력 (B-24)" $?
echo "$M5CL_OUT" | grep -q "SIGKILL 경로를 밟았다"
check "M5 SIGKILL 승격 경로 확인 출력" $?
echo "$M5CL_OUT" | grep -q "관측한 손자 전부가 사라졌다"
check "M5 reparent된 유출까지 확인 출력" $?

echo ""
echo "== Test 18: M6 계층 오케스트레이션 · context bundle · coordinator rotation (offline) =="
# 임시 workspace 전용 · spawn 0회 · live 0회. 상세 체크는 스크립트가 자체 출력한다.
M6_OUT="$(node scripts/m6-offline-acceptance.mjs 2>&1)"
M6_RC=$?
[ "$M6_RC" -eq 0 ];                               check "M6 offline acceptance exit 0" $?
echo "$M6_OUT" | grep -q " FAIL=0";               check "M6 내부 체크 전부 통과" $?
echo "$M6_OUT" | grep -q "parent가 결과 대신 위임으로 착지한다"
check "M6 ① spawn 배선 — 위임 착지 확인 출력" $?
echo "$M6_OUT" | grep -q "child 결과가 parent inbox로 route됐다"
check "M6 ① parent→child→parent 결과 라우팅 확인 출력" $?
echo "$M6_OUT" | grep -q "중앙이 sibling inbox로 route했다"
check "M6 ① child→중앙→sibling 전달 확인 출력" $?
echo "$M6_OUT" | grep -q "요청에 상태·권능·경로·예산 필드가 없다"
check "M6 ② 요청 union에 권능 필드 부재 확인 출력" $?
echo "$M6_OUT" | grep -q "거부된 spawn 요청은 child를 만들지 않는다"
check "M6 ② 승인은 kernel이 한다(요청만으로 생성 0) 확인 출력" $?
echo "$M6_OUT" | grep -q "거부된 전달은 durable 메시지를 남기지 않는다"
check "M6 ② 거부된 요청의 durable 흔적 0 확인 출력" $?
echo "$M6_OUT" | grep -q "spawn turn이 산출물을 주장하면 plan_invalid다"
check "M6 위임 turn의 산출물 조용한 유실 차단 확인 출력" $?
echo "$M6_OUT" | grep -q "같은 revision에서 두 번 만들면 byte-identical이다"
check "M6 context bundle 결정성 확인 출력" $?
echo "$M6_OUT" | grep -q "교체 전후 graph·decision·artifact hash가 전부 같다"
check "M6 ③ coordinator 교체 등가성 확인 출력" $?
echo "$M6_OUT" | grep -q "교체 후 완주한 run이 무교체 대조 run과 같은 graph 다이제스트에 도달한다"
check "M6 ③ 무교체 대조 run 대비 등가성 확인 출력" $?
echo "$M6_OUT" | grep -q "task 하나를 위조하면 graph 다이제스트가 갈린다"
check "M6 ③ 다이제스트가 위조에 반응함 확인 출력(공허한 체크 아님)" $?
echo "$M6_OUT" | grep -q "서로 다른 run의 decisionHash는 다르다"
check "M6 ③ decisionHash의 run 사이 동일성을 주장하지 않음 확인 출력" $?
echo "$M6_OUT" | grep -q "시각·revision만 바뀐 state는 세 다이제스트가 전부 그대로다"
check "M6 ③ 다이제스트가 시각에 둔감함 확인 출력" $?
if [ -d "outputs/orchestration" ]; then false; else true; fi
check "레포에 orchestration 산출물 미생성(임시 workspace 전용)" $?

echo "== Test 19: M7 research gateway · evidence · 승인 감사 · 사람 gate (offline · 무과금) =="
# 임시 디렉터리 전용 · 검색 API 0회 · live LLM 0회. 상세 체크는 스크립트가 자체 출력한다.
M7_OUT="$(node scripts/m7-offline-acceptance.mjs 2>&1)"
M7_RC=$?
[ "$M7_RC" -eq 0 ];                               check "M7 offline acceptance exit 0" $?
echo "$M7_OUT" | grep -q "FAIL=0";                check "M7 내부 체크 전부 통과" $?
echo "$M7_OUT" | grep -q "선언 밖 본문은 요청이 되지 않는다"
check "M7 ① 선언 파서가 본문을 요청으로 삼지 않음" $?
echo "$M7_OUT" | grep -q "중앙이 운반하는 것은 원문 전체가 아니라 상한 절삭된 발췌다"
check "M7 ① 원문/발췌 분리 확인 출력" $?
echo "$M7_OUT" | grep -q "같은 query 재호출이 backend를 다시 부르지 않는다"
check "M7 ② 캐시 확인 출력" $?
echo "$M7_OUT" | grep -q "extract는 미허용 도메인이면 거부된다"
check "M7 ② 도메인 fail-closed(extract) 확인 출력" $?
echo "$M7_OUT" | grep -q "적대적 문장이 데이터 블록 안에 있다"
check "M7 ③ 주입 fixture가 데이터로 갇힘 확인 출력" $?
echo "$M7_OUT" | grep -q "본문의 경계 위조가 무력화된다"
check "M7 ③ 경계 위조 차단 확인 출력" $?
echo "$M7_OUT" | grep -q "깨끗한 승인은 finding 0"
check "M7 ④ 감사가 공허하지 않음(깨끗하면 0건) 확인 출력" $?
echo "$M7_OUT" | grep -q "digest가 가리키는 부재 경로를 잡는다"
check "M7 ④ C-67 규칙 동작 확인 출력" $?
echo "$M7_OUT" | grep -q "상한 초과 도구 등록은 로드 자체가 거부된다"
check "M7 ⑤ 도구 예산 상한 fail-closed 확인 출력" $?
echo "$M7_OUT" | grep -q "답(decision)을 만드는 요청 갈래는 존재하지 않는다"
check "M7 ⑥ 사람 gate — 결정 위조 경로 부재 확인 출력" $?
echo "$M7_OUT" | grep -q "live 검색 API 실호출 0회"
check "M7 미증명(live 미실행)을 스스로 밝힘" $?

echo ""
echo "==================================="
echo " 결과: PASS=$PASS  FAIL=$FAIL"
echo "==================================="
[ "$FAIL" -eq 0 ] && { echo "ALL PASS ✅"; exit 0; } || { echo "일부 실패 ❌"; exit 1; }
