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
# [B-41] 파이프라인 시나리오는 **별도 프로젝트**를 쓴다: 활성 파이프라인이 있으면 그 프로젝트에서
# 일반 `run`이 거부되므로(pipeline_run_reserved) $PROJ를 공유하면 Test 3~12가 깨진다.
PPROJ="_acceptance_pipe"
PPDIR="projects/$PPROJ"
cleanup() { rm -rf "$PDIR" "$VAULT" "$PPDIR"; }
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
echo "$M5D_OUT" | grep -q "신규 파일도 발행된다(B-16 개방"
check "M5d B-16 완전 개방(신규 발행) 확인 출력 — V3 M9 선결 2" $?
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
echo "$M7_OUT" | grep -q "registry profile이 secret을 \*\*이름으로만\*\* 선언한다"
check "M7 ⑦ secret은 registry에 이름만(값 없음) 확인 출력" $?
echo "$M7_OUT" | grep -q "키가 없으면 호출 전에 fail-closed다"
check "M7 ⑦ 키 부재 fail-closed 확인 출력" $?
echo "$M7_OUT" | grep -q "안내가 값을 요구하지 않고 셸 설정을 지시한다"
check "M7 ⑦ 키 값을 사용자에게 요구하지 않음 확인 출력" $?
echo "$M7_OUT" | grep -q "live 검색 API 실호출 0회"
check "M7 offline 스크립트가 자신의 범위(live 미포함)를 밝힘" $?

echo "== Test 20: M8 디자인 산출물 계약 · shadcn read 배선 · handoff 접근성/범위 (offline · 무과금) =="
# 임시 디렉터리 전용 · shadcn registry 실조회 0회 · live LLM 0회. 상세 체크는 스크립트가 자체 출력한다.
M8_OUT="$(node scripts/m8-offline-acceptance.mjs 2>&1)"
M8_RC=$?
[ "$M8_RC" -eq 0 ];                               check "M8 offline acceptance exit 0" $?
echo "$M8_OUT" | grep -q "FAIL=0";                check "M8 내부 체크 전부 통과" $?
echo "$M8_OUT" | grep -q "계층 건너뛰기(semantic raw 값)는 거부된다"
check "M8 ① tokens 3계층 강제 확인 출력" $?
echo "$M8_OUT" | grep -q "선언된 쌍의 대비 미달을 실제로 잡는다"
check "M8 ② 접근성이 계산 기반(공허하지 않음) 확인 출력" $?
echo "$M8_OUT" | grep -q "min을 임의 값(1)으로 낮춰 통과시키는 우회를 거부한다"
check "M8 ② 대비 기준 완화 우회 차단 확인 출력" $?
echo "$M8_OUT" | grep -q "text-\* 토큰을 선언에서 빼 검사를 비우는 것을 거부한다"
check "M8 ② 선언 누락으로 검사를 비울 수 없음 확인 출력" $?
echo "$M8_OUT" | grep -q "M8이 새 tool profile을 추가하지 않았다(4개 유지)"
check "M8 ③ shadcn read 계층 재사용(새 proxy·profile 없음) 확인 출력" $?
echo "$M8_OUT" | grep -q "프로젝트 층: components.json의 custom registry는 거부된다"
check "M8 ④ custom/private registry 차단(프로젝트 층) 확인 출력" $?
echo "$M8_OUT" | grep -q "inventory 층: 비공식 출처 호스트는 거부된다"
check "M8 ④ custom/private registry 차단(inventory 층) 확인 출력" $?
echo "$M8_OUT" | grep -q "발췌가 원문이 아니다(절삭이 실제로 일어난다)"
check "M8 ⑤ registry 원문/발췌 분리 확인 출력" $?
echo "$M8_OUT" | grep -q "범위: UX flow에 없는 화면은 거부된다"
check "M8 ⑥ handoff 범위 검증 확인 출력" $?
echo "$M8_OUT" | grep -q "승인 후 토큰이 바뀌면 그 승인을 재사용할 수 없다"
check "M8 ⑥ 사람 승인 재사용 금지 확인 출력" $?
echo "$M8_OUT" | grep -q "같은 세션 재사용은 거부된다"
check "M8 ⑦ fresh 세션 강제(자기 승인 금지) 확인 출력" $?
echo "$M8_OUT" | grep -q "shadcn registry 실조회 0회"
check "M8 offline 스크립트가 자신의 범위(live 미포함)를 밝힘" $?

echo ""
echo "== Test 21: M9 개발 파이프라인 — 선결 4건 · DAG 계약/물질화 · 소유권 경합 · 격리 worktree (offline · 무과금) =="
# 임시 디렉터리 전용 · live LLM 0회. ⑥만 **실제 git**을 로컬에서 부른다(네트워크 0 · 원격 0).
M9_OUT="$(node scripts/m9-offline-acceptance.mjs 2>&1)"
M9_RC=$?
[ "$M9_RC" -eq 0 ];                               check "M9 offline acceptance exit 0" $?
echo "$M9_OUT" | grep -q "FAIL=0";                check "M9 내부 체크 전부 통과" $?
echo "$M9_OUT" | grep -q "테스트 명령·러너·argv를 담을 통로가 없다"
check "M9 ① run-tests가 닫힌 채로 열렸다 확인 출력" $?
echo "$M9_OUT" | grep -q "승인된 신규 파일이 실제로 발행된다(B-16 개방)"
check "M9 ② B-16 신규 발행이 실제 바이트를 냈다 확인 출력" $?
echo "$M9_OUT" | grep -q "겹치는 소유권 아래 쓰기는 거부된다"
check "M9 ③ B-29 동시 쓰기 거부 확인 출력" $?
echo "$M9_OUT" | grep -q "겹치지 않는 경로는 열려 있다(병렬을 막지 않는다)"
check "M9 ③ 게이트가 병렬을 막지 않음(공허하지 않음) 확인 출력" $?
echo "$M9_OUT" | grep -q "순서가 강제되지 않는 두 task의 소유권 겹침은 거부된다"
check "M9 ④ DAG 소유권 충돌 fail-closed 확인 출력" $?
echo "$M9_OUT" | grep -q "문서가 실행 권한을 만들 통로가 없다"
check "M9 ④ DAG 문서가 승인 manifest를 우회하지 못함 확인 출력" $?
echo "$M9_OUT" | grep -q "resourceClasses가 kernel로 1:1 보존된다(B-30)"
check "M9 ⑤ B-30 문서→kernel 1:1 보존 확인 출력" $?
echo "$M9_OUT" | grep -q "거부된 물질화가 durable 잔류를 남기지 않는다(run 벽돌화 0)"
check "M9 ⑤ 부분 물질화 방지(리뷰 A급 수정) 확인 출력" $?
echo "$M9_OUT" | grep -q "격리 worktree 디렉터리가 실제로 생겼다"
check "M9 ⑥ 실제 git worktree 생성 확인 출력" $?
echo "$M9_OUT" | grep -q "브랜치를 만들지 않았다(--detach)"
check "M9 ⑥ 브랜치 미생성(원격 쓰기 표현 불가 유지) 확인 출력" $?
echo "$M9_OUT" | grep -q "멈춘 marker가 표시에서 사라지지 않는다"
check "M9 ⑦ F2 진행 표시가 실패를 숨기지 않음 확인 출력" $?
echo "$M9_OUT" | grep -q "세 리뷰어가 한 세션을 겸할 수 없다"
check "M9 ⑧ 리뷰 3종이 각각 다른 fresh 세션 확인 출력" $?
echo "$M9_OUT" | grep -q "저자가 자기 코드를 리뷰할 수 없다"
check "M9 ⑧ 자기 승인 금지 확인 출력" $?
echo "$M9_OUT" | grep -q "테스트 실행 책임은 test 렌즈에 못 박힌다"
check "M9 ⑧ test 렌즈 책임 고정 확인 출력" $?
echo "$M9_OUT" | grep -q "live LLM 0회"
check "M9 offline 스크립트가 자신의 범위(live 미포함)를 밝힘" $?

echo ""
echo "== Test 22: M10 T1·T2·T3 — 크래시 복구 · 통합 시나리오 · 무인 loop end-to-end (offline · 무과금) =="
# 임시 디렉터리 전용 · live LLM 0회. ①②는 **실제 프로세스**를 띄우고 ②는 controller를 실제 SIGKILL한다.
M10_OUT="$(node scripts/m10-offline-acceptance.mjs 2>&1)"
M10_RC=$?
[ "$M10_RC" -eq 0 ];                              check "M10 T1·T2 offline acceptance exit 0" $?
echo "$M10_OUT" | grep -q "FAIL=0";               check "M10 T1·T2 내부 체크 전부 통과" $?
echo "$M10_OUT" | grep -q "정상 timeout이 run을 격리하지 않는다"
check "M10 ① 관측된 정리는 확인으로 적는다(과격리 없음) 확인 출력" $?
echo "$M10_OUT" | grep -q "관측하지 못한 정리를 확인으로 적지 않는다"
check "M10 ② 거짓 성공 영수증 금지 확인 출력" $?
echo "$M10_OUT" | grep -q "자원을 놓지 않고 격리한다"
check "M10 ② 격리가 자원을 놓지 않음 확인 출력" $?
echo "$M10_OUT" | grep -q "죽은 writer의 lock을 회수해 재시작이 열린다"
check "M10 ③ stale lock 회수로 재시작이 열림 확인 출력" $?
echo "$M10_OUT" | grep -q "새 attempt로 재개해 완주한다"
check "M10 ④ 크래시 잔재 정착·재개 확인 출력" $?
echo "$M10_OUT" | grep -q "결과·artifact가 중복 발행되지 않았다"
check "M10 ④ 중복 없음 확인 출력" $?
echo "$M10_OUT" | grep -q "같은 문서로 이어받아 완성한다"
check "M10 ⑤ C-76 부분 물질화 이어받기 확인 출력" $?
echo "$M10_OUT" | grep -q "결정 없이는 결과를 발행하지 못한다"
check "M10 T2 사람 결정 gate 우회 없음 확인 출력" $?
echo "$M10_OUT" | grep -q "막힌 그래프에서 loop가 조용히 진행하지 않는다"
check "M10 T2 의존성 실패가 조용히 진행하지 않음 확인 출력" $?
echo "$M10_OUT" | grep -q "변조된 run은 task를 하나도 건드리지 않고 거부된다"
check "M10 T2 요약 변질 fail-closed 확인 출력" $?
echo "$M10_OUT" | grep -q "회전(재열기)이 같은 context bundle을 낸다"
check "M10 T2 context rotation 등가 확인 출력" $?
echo "$M10_OUT" | grep -q "한 번의 실행이 세 단계를 \*\*의존 순서대로\*\* 완주한다"
check "M10 T3 end-to-end가 무인 loop 한 번에 돈다 확인 출력" $?
echo "$M10_OUT" | grep -q "계획 파일 0개로 돌았다"
check "M10 T3 계획을 모델이 만들었다(정적 계획 파일 0개) 확인 출력" $?
echo "$M10_OUT" | grep -q "프롬프트가 지시 본문·문맥·\*\*role\*\*을 담았다"
check "M10 T3 프롬프트가 durable 지시·문맥·role을 담았다 확인 출력" $?
echo "$M10_OUT" | grep -q "무인 loop가 사람 개입 없이 돌았다(pause 0건)"
check "M10 T3 사람 개입 0건 확인 출력" $?
echo "$M10_OUT" | grep -q "좌초 프로세스 탐색(관측자 없음)"
check "M10 스크립트가 자신의 범위(미증명 4건 + 문서 누락 표현 불가)를 밝힘" $?

echo ""
echo "== Test 23: M11 사용자 결정 4건 — 병합 조건 대체(C-80) · worker 신원 승인 축(C-86) · 리뷰 왕복 강제(C-98) (offline · 무과금) =="
# 임시 디렉터리 전용 · live LLM 0회. `C-93`은 문서 한정이라 여기서 밟을 것이 없다(로드맵 본문이 산출물).
M11_OUT="$(node scripts/m11-offline-acceptance.mjs 2>&1)"
M11_RC=$?
[ "$M11_RC" -eq 0 ];                              check "M11 결정 acceptance exit 0" $?
echo "$M11_OUT" | grep -q "FAIL=0";               check "M11 내부 체크 전부 통과" $?
echo "$M11_OUT" | grep -q "닫힌 worktree action 집합에 branch/merge/push가 없다"
check "M11 ① 병합 단계가 존재하지 않는다는 근거 출력" $?
echo "$M11_OUT" | grep -q "대조군: 필드 없는 정상 worktree record는 통과한다"
check "M11 ① 검사가 공허하지 않음(대조군) 출력" $?
echo "$M11_OUT" | grep -q "그리고 영수증이 ambient라고 말한다(조용한 fallback이 아니다)"
check "M11 ② 신원 미승인 run이 조용하지 않음(영수증에 ambient) 출력" $?
echo "$M11_OUT" | grep -q "신원을 승인하면 영수증이 approved라고 말한다"
check "M11 ② 위 단정이 상수가 아님(approved 대조군) 출력" $?
echo "$M11_OUT" | grep -q "대조군: 계약을 지킨 신원은 승인 게이트를 지난다"
check "M11 ② 계약 위반만 거부(무조건 거부가 아님) 출력" $?
echo "$M11_OUT" | grep -q "대조군: 리뷰어가 저자와 같은 엔진이면 verify가 완료되지 않는다"
check "M11 ③ 리뷰 왕복을 loop가 강제함 출력" $?

echo ""
echo "== Test 24: M11 무인 loop CLI 진입점 — autopilot-create · --worker-backend · backend별 --plan-dir (offline · 무과금) =="
# **이 배선 자체가 `C-104`가 이름한 사고 형태를 막는다**: 다른 offline acceptance는 전부 여기 등록돼
# 있는데 이 스크립트만 빠져 있었다(= 사람이 기억해야만 도는 31건). 통합 세션이 그것을 닫았다.
# `--import tsx`가 필요하다 — 이 스크립트는 실제 argv로 `src/cli.ts`를 기동한다(dist가 아니라 소스).
M11CLI_OUT="$(node --import tsx scripts/m11-cli-entrypoint-acceptance.mjs 2>&1)"
M11CLI_RC=$?
[ "$M11CLI_RC" -eq 0 ];                           check "M11 CLI 진입점 acceptance exit 0" $?
echo "$M11CLI_OUT" | grep -q "FAIL=0";            check "M11 CLI 진입점 내부 체크 전부 통과" $?
# `--`로 패턴 시작 — grep이 옵션으로 읽으므로 `--`로 끊는다(통합에서 실측한 실패다).
echo "$M11CLI_OUT" | grep -q -- "--worker-backend 미지정은 offline-plan이다"
check "M11 CLI 기본 backend가 offline-plan(구독을 소모하지 않는다) 출력" $?
echo "$M11CLI_OUT" | grep -q "worker_backend_unapproved로 거부한다"
check "M11 CLI live backend가 승인 없이는 표현 불가 출력" $?
echo "$M11CLI_OUT" | grep -q "빈 디렉터리로 취급하지 않는다"
check "M11 CLI --plan-dir 부재가 조용한 fallback이 아님 출력" $?
echo "$M11CLI_OUT" | grep -q "읽지 않는 인자를 조용히 받지 않는다"
check "M11 CLI live에 --plan-dir을 주면 거부(오해 방지) 출력" $?
echo "$M11_OUT" | grep -q "승인이 왕복을 요구하지 않으면 게이트는 돌지 않는다"
check "M11 ③ 요구하지 않는 승인은 강요받지 않음 출력" $?

echo ""
echo "== Test 25: M11 지시→계획→집행→산출물→완료 — DAG operations 축 · kernel 지시-계획 bind (offline · 무과금) =="
# `C-104`/판정 ⑥ ⓖ의 교훈대로 **만들자마자 여기 등록한다** — 사람이 기억해야만 도는 스크립트를 만들지 않는다.
# `--import tsx`가 필요하다(`.ts` 모듈을 직접 import한다).
M11B38_OUT="$(node --import tsx scripts/m11-b38-offline-acceptance.mjs 2>&1)"
M11B38_RC=$?
[ "$M11B38_RC" -eq 0 ];                           check "M11 B-38 acceptance exit 0" $?
echo "$M11B38_OUT" | grep -q "FAIL=0";            check "M11 B-38 내부 체크 전부 통과" $?
echo "$M11B38_OUT" | grep -q "디스크에 없던 파일을 실제로 만들었다"
check "M11 B-38 typed write가 산출물 바이트를 만듦 출력" $?
echo "$M11B38_OUT" | grep -q "승인에 없는 authorityId는 거부된다"
check "M11 B-38 지시는 권위를 만들지 못함 출력" $?
echo "$M11B38_OUT" | grep -q "영수증이 하나도 남지 않았다"
check "M11 C-111 지시 밖 계획이 kernel bind에서 거부됨 출력" $?
echo "$M11B38_OUT" | grep -q "B-38 이전과 바이트 동일하다"
check "M11 B-38 기존 지시 본문 바이트 불변 출력" $?

echo ""
echo "== Test 26: M12 L2a 아이디어 문서 → DAG 문서 초안 — plan-dag · validate-dag (offline · 무과금) =="
# `C-104`/판정 ⑥ ⓖ의 교훈대로 **만들자마자 여기 등록한다** — 직전 두 slice가 두 번 빠뜨린 함정이다.
# 스크립트가 실제 argv로 `src/cli.ts`를 띄우므로 재기동 안에서 `--import tsx`를 스스로 챙긴다.
M12L2A_OUT="$(node scripts/m12-l2a-offline-acceptance.mjs 2>&1)"
M12L2A_RC=$?
[ "$M12L2A_RC" -eq 0 ];                           check "M12 L2a acceptance exit 0" $?
echo "$M12L2A_OUT" | grep -q "FAIL=0";            check "M12 L2a 내부 체크 전부 통과" $?
echo "$M12L2A_OUT" | grep -q "아이디어 문서의 \*\*모든 줄\*\*이 지시에 실렸다"
check "M12 L2a 아이디어 원문이 지시 본문에 실림 출력" $?
echo "$M12L2A_OUT" | grep -q "자르지 않는다는 것을 출력이 명시한다"
check "M12 L2a 상한 초과가 fail closed(조용한 자르기 아님) 출력" $?
echo "$M12L2A_OUT" | grep -q "typed write가 \*\*디스크에 없던 초안 파일을 만들었다\*\*"
check "M12 L2a 초안이 typed write로 실제 생성됨 출력" $?
echo "$M12L2A_OUT" | grep -q "\*\*불통과 초안이 지워지지 않았다\*\*"
check "M12 L2a 불통과 초안이 산출물로 남음 출력" $?
echo "$M12L2A_OUT" | grep -q "지시가 DAG node key 전부를 이름으로 싣는다"
check "M12 L2a 문서 계약이 상수에서 파생됨 출력" $?

echo ""
echo "== Test 27: M12 L2b DAG 문서 → 승인 manifest 초안 — draft-approval · validate-approval (offline · 무과금) =="
# `C-104`/판정 ⑥ ⓖ의 교훈대로 **만들자마자 여기 등록한다**.
# 스크립트가 실제 argv로 `src/cli.ts`를 띄우므로 재기동 안에서 `--import tsx`를 스스로 챙긴다.
M12L2B_OUT="$(node scripts/m12-l2b-offline-acceptance.mjs 2>&1)"
M12L2B_RC=$?
[ "$M12L2B_RC" -eq 0 ];                           check "M12 L2b acceptance exit 0" $?
echo "$M12L2B_OUT" | grep -q "FAIL=0";            check "M12 L2b 내부 체크 전부 통과" $?
echo "$M12L2B_OUT" | grep -q "각각 혼자서\*\* 승인 검증기를 막는다"
check "M12 L2b 초안이 그대로 실행될 수 없음(sentinel마다 개별 거부) 출력" $?
echo "$M12L2B_OUT" | grep -q "그 승인으로 autopilot-create가 12-task run을 만든다"
check "M12 L2b 채운 승인이 실행 경로까지 감(대조군) 출력" $?
echo "$M12L2B_OUT" | grep -q "PATH에 후보가 있어도 실행 파일 자리는 전부 sentinel이다"
check "M12 L2b PATH 자동 발견이 없음 출력" $?
echo "$M12L2B_OUT" | grep -q "digest가 그 파일 내용의 sha256이다"
check "M12 L2b 명시한 경로만 digest가 실림(대조군) 출력" $?
echo "$M12L2B_OUT" | grep -q "재실행은 채우던 초안을 덮어쓰지 않는다"
check "M12 L2b 초안을 지우거나 덮어쓰지 않음 출력" $?


echo ""
echo "== Test 28: B-41 단계 체크포인트 오케스트레이션 — pipeline status/next/approve/restart/unlock (mock · 무과금) =="
# `C-104`/판정 ⑥ ⓖ의 교훈대로 **만들자마자 여기 등록한다**. 종료 코드는 **파이프 없이** 잰다
# (`| tail` 뒤에서 재면 tail의 코드가 잡힌다).
$HARNESS init "$PPROJ" >/dev/null
printf '# idea\n\n## 아이디어 한 줄 정의\n\n- 체크포인트 acceptance 아이디어\n' > "$PPDIR/docs/00_IDEA.md"
PS="$PPDIR/outputs/pipeline_state.json"

OUT="$($HARNESS pipeline status --project "$PPROJ" 2>&1)"; RC=$?
[ "$RC" -eq 0 ];                                      check "status(파이프라인 없음) exit 0" $?
echo "$OUT" | grep -q "파이프라인 없음";               check "status가 미시작을 말한다" $?
test ! -f "$PS";                                      check "status는 state를 만들지 않는다(read-only)" $?

# ① 1단계 실행 → **확인 대기**로 들어간다 (다음 단계는 돌지 않는다)
OUT="$($HARNESS pipeline next --project "$PPROJ" 2>&1)"; RC=$?
[ "$RC" -eq 0 ];                                      check "next(1단계) exit 0" $?
echo "$OUT" | grep -q "확인 대기";                     check "1단계 후 확인 대기 진입" $?
grep -q '"status": "awaiting_approval"' "$PS";         check "durable 상태가 awaiting_approval" $?
CP1="$(echo "$OUT" | grep -o 'checkpoint: [0-9a-f]\{12\}' | head -1 | awk '{print $2}')"
[ -n "$CP1" ];                                        check "checkpoint id 출력" $?
node -e "const s=require('./$PS');process.exit(s.pending&&s.pending.seeds.length>=5?0:1)"
check "영수증에 승인 판단 seed가 실린다" $?
test ! -f "$PPDIR/docs/03_UX_FLOW.md";                check "다음 단계 산출물이 아직 없다(전진 없음)" $?

# ② 확인 대기 중에는 우회가 전부 막힌다
BEFORE="$(cat "$PS")"
$HARNESS run mvp-planning --project "$PPROJ" --yes >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ];                                      check "확인 대기 중 직접 run 거부(exit 2)" $?
$HARNESS task-prompt --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ];                                      check "확인 대기 중 task-prompt 거부(exit 2)" $?
$HARNESS handoff --project "$PPROJ" --cwd . >/dev/null 2>&1; RC=$?
[ "$RC" -eq 1 ];                                      check "확인 대기 중 handoff 거부(exit 1)" $?
OUT="$($HARNESS pipeline next --project "$PPROJ" 2>&1)"; RC=$?
[ "$RC" -eq 0 ];                                      check "대기 중 next는 안내만(exit 0)" $?
[ "$BEFORE" = "$(cat "$PS")" ];                        check "네 방향 거부가 state 바이트를 건드리지 않았다" $?

# ③ 신원 결박: 틀린 checkpoint id는 거부, 맞으면 전진
$HARNESS pipeline approve idea-validation --checkpoint 000000000000 --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 1 ];                                      check "틀린 checkpoint id 승인 거부(exit 1)" $?
[ "$BEFORE" = "$(cat "$PS")" ];                        check "거부가 state를 바꾸지 않았다" $?
$HARNESS pipeline approve idea-validation --checkpoint "$CP1" --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ];                                      check "승인 exit 0" $?
grep -q '"decision": "approved"' "$PS";                check "승인 영수증 기록" $?
$HARNESS run dev-preflight --project "$PPROJ" --yes >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ];                                      check "승인 직후 단계 건너뛰기 run 거부(exit 2)" $?

# ④ 승인된 문서를 바꾸면 다음 단계가 **모델 호출 전에** 거부한다
cp "$PPDIR/docs/02_PRD.md" "$PPDIR/outputs/_prd.bak"
printf '\n변조\n' >> "$PPDIR/docs/02_PRD.md"
OUT="$($HARNESS pipeline next --project "$PPROJ" 2>&1)"; RC=$?
[ "$RC" -eq 1 ];                                       check "승인 후 문서 교체 → next 거부(exit 1)" $?
echo "$OUT" | grep -q "승인된 산출물이 승인 시점 바이트와 다릅니다"; check "drift 사유 출력" $?
test ! -f "$PPDIR/docs/03_UX_FLOW.md";                 check "거부 시 2단계 산출물 미생성(모델 호출 전 정지)" $?
cp "$PPDIR/outputs/_prd.bak" "$PPDIR/docs/02_PRD.md"

# ⑤ 남은 세 단계를 실행·승인해 완주한다 (내부 승인 step만 비대화 승인)
for STAGE in mvp-planning dev-preflight dev-handoff; do
  OUT="$($HARNESS pipeline next --project "$PPROJ" --yes-internal-gates 2>&1)"; RC=$?
  [ "$RC" -eq 0 ];                                     check "next($STAGE) exit 0" $?
  CP="$(echo "$OUT" | grep -o 'checkpoint: [0-9a-f]\{12\}' | head -1 | awk '{print $2}')"
  $HARNESS pipeline approve "$STAGE" --checkpoint "$CP" --project "$PPROJ" >/dev/null 2>&1; RC=$?
  [ "$RC" -eq 0 ];                                     check "approve($STAGE) exit 0" $?
done
grep -q '"status": "completed"' "$PS";                 check "4단계 승인 후 completed" $?
$HARNESS task-prompt --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ];                                       check "완료 후에는 task-prompt가 열린다" $?

# ⑥ 완료 후 승인 문서를 바꾸면 하류가 다시 닫힌다
printf '\n변조\n' >> "$PPDIR/docs/06_CEO_DECISION.md"
$HARNESS task-prompt --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ];                                       check "완료 후 문서 교체 → task-prompt 거부(exit 2)" $?

# ⑦ lock: mutating 명령은 거부되고 status는 읽힌다 · 살아 있는 owner의 lock은 회수하지 않는다
printf '{"pid": %s, "nonce": "aaaaaaaaaaaaaaaa", "at": "2026-01-01T00:00:00.000Z"}' "$$" > "$PPDIR/outputs/pipeline.lock"
$HARNESS pipeline next --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ];                                       check "lock 보유 중 mutation 거부(exit 2)" $?
$HARNESS pipeline status --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ];                                       check "lock 중에도 status는 동작(exit 0)" $?
$HARNESS pipeline unlock --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 1 ];                                       check "살아 있는 owner의 lock은 회수 거부(exit 1)" $?
test -f "$PPDIR/outputs/pipeline.lock";                check "거부 시 lock이 남는다" $?
rm -f "$PPDIR/outputs/pipeline.lock"

# ⑧ restart: 종료된 파이프라인만 · 기존 state는 지우지 않고 rename 보관
$HARNESS pipeline restart --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ];                                       check "completed에서 restart exit 0" $?
ls "$PPDIR/outputs" | grep -q '^pipeline_state\..*\.json$'; check "restart가 기존 state를 archive로 보관(삭제 없음)" $?
grep -q '"current_index": 0' "$PS";                    check "restart 후 첫 단계로" $?
$HARNESS pipeline restart --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 1 ];                                       check "진행 중 파이프라인의 restart 거부(exit 1)" $?

# ⑨ 손상된 state는 fail closed (바이트 불변 · exit 2)
echo '{ not json' > "$PS"
$HARNESS pipeline status --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ];                                       check "손상 state → status exit 2" $?
$HARNESS pipeline next --project "$PPROJ" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ];                                       check "손상 state → next exit 2" $?
[ "$(cat "$PS")" = '{ not json' ];                     check "손상 state 바이트 불변" $?

echo ""
echo "==================================="
echo " 결과: PASS=$PASS  FAIL=$FAIL"
echo "==================================="
[ "$FAIL" -eq 0 ] && { echo "ALL PASS ✅"; exit 0; } || { echo "일부 실패 ❌"; exit 1; }
