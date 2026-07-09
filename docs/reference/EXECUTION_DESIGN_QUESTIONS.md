# EXECUTION_DESIGN_QUESTIONS.md

구현(§9-2 등) 중 발견한 **설계 판단이 필요한 지점** 모음. 구현자는 여기에 정리만 하고 결정하지 않는다 — 설계는 Fable 세션에서 처리해 `EXECUTION_LAYER_ARCH.md`에 반영한다.

- 작성 시작: 2026-07-08 (§9-2 ExecutionProvider 구현 중)
- 규칙: 각 항목 = 배경 / 선택지 / 잠정 구현 상태 / 결정 시 영향 범위.

> **전부 해소됨 (2026-07-09, ARCH v0.3 §11 결정 로그).**
> - **Q1 → A 확정** (Model A one-shot+resume, B 기각). ARCH §1.0. claudeCliProvider 잠정 딱지 제거·확정 승격.
> - **Q2 → 하이브리드** (SPEC·API_CONTRACT 인라인 + 배경문서 경로+Read). ARCH §3.1.1. PromptCompiler는 §9-5.
> - **Q3 → 그레이스 1턴(WIP 커밋+STATUS)→stop→DEFERRED**. ARCH §3.1.2. 상태머신 BUDGET_GRACE, 강제는 §9-7.
> 아래 원문은 결정 근거 추적용으로 보존.

---

## Q1. 세션 수명 모델 — one-shot+resume(A) vs 지속형 stdin(B) ⭐블로킹

**배경**: ARCH §1 `ExecutionProvider`는 지속형 세션(start/send/events/stop)을 전제한다. 그러나 RECON 실측상 `claude -p`는 **호출당 1회성**(프롬프트 1개 → 이벤트 스트림 → `result` → 프로세스 종료)이다. 세션 연속성은 `--resume <session_id>`로만 이어진다.

**선택지**:
- **A) 호출당 프로세스 (현재 잠정 구현)**: 첫 turn = `--session-id <uuid>`로 시작, 이후 turn마다 `--resume <id>`로 새 프로세스. 장점: 단순, CLI 기본 사용법과 일치, 프로세스 누수 없음. 단점: turn마다 프로세스 기동 + 컨텍스트 재로드(프롬프트 캐시가 완화하나 0은 아님), 매 turn `system/init` 재발생.
- **B) 지속형 단일 프로세스**: `--input-format stream-json`으로 프로세스를 띄워두고, send()가 stdin에 stream-json user 메시지를 써서 같은 프로세스에 turn을 이어붙인다(`--replay-user-messages`로 에코 확인). 장점: 프로세스 1개 = 논리 세션 1개(SessionHandle-라이브프로세스 정합), turn 간 재기동/재로드 없음. 단점: stdin 메시지 프로토콜(정확한 JSON 형식) 실측 필요, 장수명 프로세스 관리·정지·행(hang) 처리 복잡.

**잠정 구현**: `claudeCliProvider.ts`는 **A**로 작성됨(명확히 "잠정" 주석). `events()`는 invocation마다 큐를 교체하므로, 소비자는 send() 후 events()를 **다시** 호출해 새 turn 스트림을 받아야 한다 — 이 소비 계약도 B 채택 시 "세션 수명 전체를 잇는 단일 스트림"으로 바뀔 수 있음.

**결정 시 영향**: `claudeCliProvider.ts` 재작성 여부, `events()` 계약(turn 단위 vs 세션 단위), SessionManager(v4) 프로세스 보유 방식. **§9-2를 마감 확정하려면 이 결정이 선행**(현재는 A로 동작·테스트됨).

---

## Q2. start()의 initialPrompt 구성 책임 — task-prompt 확장 포맷

**배경**: `ExecutionProvider.start(spec, initialPrompt)`에서 `initialPrompt`는 문자열로 받는다. ARCH §3.1은 SessionSpec(role/inputs/ownership/dod/forbidden)을 정의하지만, 이것들이 **하나의 착수 프롬프트 텍스트로 어떻게 조립되는지**(task-prompt의 실행 계층 확장)는 미정. inputs 문서들을 프롬프트에 인라인할지, 경로만 줄지(세션이 Read 도구로 열지)도 결정 필요.

**선택지(예시)**: (a) 오케스트레이터가 inputs 문서 전문을 프롬프트에 인라인 / (b) 경로 목록 + "필요 시 Read하라" 지시 / (c) 핵심(PRD/계약)만 인라인 + 나머지 경로.

**잠정 구현**: provider는 문자열을 받기만 함(구성 로직 없음). 조립기는 미구현 — SessionSpec→프롬프트 컴파일러는 오케스트레이터 붙일 때.

**결정 시 영향**: 토큰 소모(인라인 클수록 비용↑), 세션 자율성(경로만 주면 Read 권한/도구 필요), 권한 컴파일러(§9-3)의 allowedTools에 Read 포함 범위.

---

## Q3. turn 예산 초과 시 동작

**배경**: RECON §2.1로 `max_turns`는 CLI 플래그가 아니라 오케스트레이터가 `assistant` 이벤트를 세어 강제하기로 정리됨. 다만 **한도 도달 시 처리**는 미정.

**선택지**: (a) 즉시 stop() + 해당 태스크 `DEFERRED`(보류 목록) / (b) "마무리하고 종료하라" 지시 1회 주입 후 stop() / (c) 리뷰어에게 넘겨 부분 결과 평가.

**잠정 구현**: 미구현(카운팅·강제 로직은 오케스트레이터 몫, 아직 없음). provider는 이벤트만 흘림.

**결정 시 영향**: 상태머신 전이(`RUNNING → DEFERRED/ABORTED`), MISSION_REPORT 보류 항목 기록 방식.

---

## Q4. develop 병합 전략 (구현: `git push . <branch>:<base>`)

**배경**: SessionRunner/미션은 게이트·리뷰 통과 후 세션 브랜치를 base(develop)에 `git push . <branch>:<base>`(ff)로 병합한다. base가 **메인 작업트리에 체크아웃돼 있으면** git이 거부(`refusing to update checked out branch`). 세션은 worktree를 쓰므로 보통 메인 트리는 develop이 아닐 수 있으나, 사용자가 develop에 있으면 미션이 병합 못 함.

**선택지**: (a) 전용 병합 worktree에서 `merge --ff-only` (항상 동작, 무겁다) / (b) `receive.denyCurrentBranch=updateInstead` 설정 요구 / (c) 미션 시작 시 메인 트리를 스크래치로 이동. **미결** — 필드에서 실제 운영 형태 보고 결정.

**잠정**: `git push . :` 그대로. 스모크는 스크래치 브랜치 체크아웃으로 회피.

---

## Q5. rate limit 의미론 — 언제 실제로 대기하나 (구현: status != "allowed" → 대기)

**배경**: `rate_limit_event.rate_limit_info.status`의 정확한 값 집합(allowed / warning / exceeded / rejected 등)과 "세션이 성공했는데도 대기해야 하는가"가 미확정. 현재는 `status !== "allowed"`면 대기·강등 카운트. 그러나 스모크에서 세션이 **성공 완주했는데도** 큰 대기(7107s)가 기록됨 → 성공한 세션 뒤 불필요 대기 위험(다음 태스크 직전으로 이월해 마지막 뒤 대기는 제거함).

**선택지**: (a) 세션이 rate limit로 **실패**했을 때만 대기 / (b) `overageStatus`/`status` 특정 값에서만 대기 / (c) resetsAt이 임계 이내일 때만. **미결** — 실제 한도 도달 시 이벤트 값을 관측해 튜닝 필요.

**잠정**: 대기는 다음 태스크 직전에만(마지막 태스크 뒤엔 안 함). 강등 카운트는 그대로.

---

## (해소됨, 참고) 실측으로 결정된 것 — RECON 참조

- `--max-turns` 부재 → 오케스트레이터 이벤트 카운팅 (RECON §2.1). *동작*만 Q3로 남음.
- print+stream-json은 `--verbose` 필수 (RECON §1). 구현 반영됨.
- 강등 사다리 = `--model`+`--fallback-model` CLI 자동 폴백 활용 (RECON §4).
- rate limit 대응 = `rate_limit_event`(resetsAt 등) 실데이터 구동 (RECON §4).
