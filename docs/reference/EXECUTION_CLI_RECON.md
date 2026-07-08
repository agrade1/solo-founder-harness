# EXECUTION_CLI_RECON.md

실행 계층 구현 §9-1 "CLI 실측" 결과. `EXECUTION_LAYER_ARCH.md`가 전제한 `claude` CLI 플래그가 실제 설치본에 존재하는지 검증한다.

- **작성일**: 2026-07-08
- **실측 대상**: `/Users/jihun/.nvm/versions/node/v24.18.0/bin/claude`
- **버전 핀**: **claude 2.1.204 (Claude Code)** — ExecutionProvider는 기동 시 `claude --version`으로 이 버전 이상인지 확인하고, 어긋나면 경고.
- **방법**: `--help` / `<subcmd> --help` 정적 조회만 (실제 생성 호출 없음 = 구독 토큰 미소모). 실행 시점 동작(stream-json 이벤트 스키마)은 §후반 "미완 항목" 참고.

---

## 1. 설계 전제 플래그 매칭

| 설계(ARCH §1·§4) 전제 | 실측 결과 (2.1.204) | 판정 |
|---|---|---|
| `-p` / `--print` 헤드리스 | 있음 | ✅ |
| `--output-format stream-json` | 있음 (choices: text·json·stream-json, `--print` 전용) | ✅ |
| `--input-format stream-json` | 있음 (text·stream-json) | ✅ |
| `--include-partial-messages` | 있음 (stream-json 전용) | ✅ |
| `--replay-user-messages` | 있음 | ✅ |
| `--resume [value]` / `-r` | 있음 (세션 ID로 재개) | ✅ 후속 지시 주입 경로 확보 |
| `--session-id <uuid>` | 있음 (**세션 ID 사전 지정 가능**) | ✅ 오케스트레이터가 ID를 먼저 할당해 추적 — 설계보다 유리 |
| `--fork-session` | 있음 (resume 시 새 ID 분기) | ✅ 리뷰어 신선 컨텍스트/분기에 활용 가능 |
| `--permission-mode <mode>` | 있음. choices: **acceptEdits**, auto, bypassPermissions, manual, dontAsk, plan | ✅ 설계의 acceptEdits 존재 |
| `--allowedTools` / `--disallowedTools` | 있음 (콤마/공백 구분, 예 `"Bash(git *)" Edit`) | ✅ 권한 컴파일러 대상 |
| `--append-system-prompt` / `--system-prompt` (+ `-file` 변형) | 있음 | ✅ 역할 주입 |
| `--model <model>` | 있음 | ✅ 모델 다이얼(§1.1) |
| `--fallback-model <model>` | 있음 (자동 폴백) | ✅ **강등 사다리(§1.1/§6.2)에 직접 활용** — B단계에서 `--model opus --fallback-model sonnet`로 한도 병목 시 자동 강등 |
| `--add-dir <dirs...>` | 있음 | ✅ worktree 외 필요한 읽기 경로 허용 |
| `--mcp-config` / `--strict-mcp-config` / `--settings` | 있음 | ✅ 세션별 설정/훅 주입 경로 |
| `claude agents` (백그라운드 세션 관리, `--json` 목록, `--bg`) | 있음 | ✅ **v4 병행 오케스트레이션 기반 이미 존재** — 세션을 detached로 띄우고 `agents --json`으로 상태 폴링 가능 |

→ **핵심 전제는 전부 충족.** ExecutionProvider(§1) 인터페이스는 이 CLI로 구현 가능.

---

## 2. 어긋난 전제 — 조치 필요

### 2.1 `--max-turns` 없음 (⚠ 설계 수정)

- ARCH §3.1 SessionSpec의 `budget: { max_turns: 40 }`가 매핑할 CLI 플래그가 **없다.** 2.1.204에는 `--max-turns`가 존재하지 않음.
- 대안으로 있는 것: `--max-budget-usd <amount>` — 설명이 "Maximum dollar amount to spend on **API**"라 **API 키 사용자 전용**으로 보임(구독 토큰 경로에는 USD 계측이 없어 무효 가능성 큼). 실측 필요 시 별도 확인.
- **조치(권장)**: turn 예산은 CLI에 위임하지 말고 **오케스트레이터가 stream-json 이벤트에서 assistant turn을 카운트해 상한 초과 시 `stop()`** 으로 강제한다. 어차피 세션 수명은 오케스트레이터가 소유하므로(§5 상태머신) 이 방식이 설계 철학과 더 일치. → SessionSpec `budget.max_turns`는 **CLI 플래그가 아니라 오케스트레이터 정책값**으로 재정의.
- 부수: `--max-budget-usd`는 anthropic(A안, API 키) provider 쓸 때의 예산 가드로만 백로그.

---

## 3. 미완 항목 — 실제 호출 1회 필요 (다음 단계 진입 조건)

플래그 존재는 정적 확인으로 끝났지만, **stream-json 이벤트 스키마**(event 종류·필드: `system/init`의 session_id, `assistant`/`user` 메시지, `tool_use`/`tool_result`, `result`의 usage·is_error 등)는 실제 1회 실행해야 확정된다. 이벤트 파서(§9-2)가 이 스키마에 의존하므로 **다음 작업의 선행 조건**.

- 제안 프로브(최소 비용, 도구 미사용): `printf 'reply with the single word: ok' | claude -p --output-format stream-json --include-partial-messages` → 나오는 NDJSON 이벤트 종류/필드를 캡처해 이 문서 §3에 스키마 표로 추가.
- 이건 **실제 구독 토큰을 쓰는 호출**이므로 창업자 승인 후 실행.

---

## 4. 실측이 바꾸는 설계 반영 요약

1. `SessionSpec.budget.max_turns` = CLI 플래그 아님 → **오케스트레이터 이벤트 카운팅으로 강제** (ARCH §3.1 각주 갱신 대상).
2. 강등 사다리(§1.1)는 `--model` + **`--fallback-model`** 조합으로 CLI 레벨 자동 폴백까지 활용 가능 (설계는 오케스트레이터 재산출만 가정했음 — 더 견고해짐).
3. 세션 ID는 `--session-id`로 **사전 할당** → run_state.sessions[] 추적이 단순해짐.
4. v4 병행은 `claude agents`(`--bg` + `--json` 폴링)라는 1급 기반이 이미 있음 → SessionManager가 프로세스 핸들을 직접 들 필요가 줄 수 있음(설계 시 재검토).

---

## 5. 다음 작업 (ARCH §9 순서 기준)

- [x] §9-1 CLI 플래그 실측 (이 문서)
- [ ] **선행: stream-json 이벤트 스키마 프로브 1회** (§3, 승인 필요)
- [ ] §9-2 ExecutionProvider(CLI) 골격 + 이벤트 파서 + 단일 세션 수명
- [ ] §9-3 권한 컴파일러(티어→플래그+훅)
