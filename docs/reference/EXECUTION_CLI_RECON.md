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

> **호출 요건(실측)**: `--print`(-p) + `--output-format stream-json` 조합은 **`--verbose` 필수** (없으면 즉시 에러 종료). ExecutionProvider start 인자에 `--verbose` 고정 포함.

---

## 2. 어긋난 전제 — 조치 필요

### 2.1 `--max-turns` 없음 (⚠ 설계 수정)

- ARCH §3.1 SessionSpec의 `budget: { max_turns: 40 }`가 매핑할 CLI 플래그가 **없다.** 2.1.204에는 `--max-turns`가 존재하지 않음.
- 대안으로 있는 것: `--max-budget-usd <amount>` — 설명이 "Maximum dollar amount to spend on **API**"라 **API 키 사용자 전용**으로 보임(구독 토큰 경로에는 USD 계측이 없어 무효 가능성 큼). 실측 필요 시 별도 확인.
- **조치(권장)**: turn 예산은 CLI에 위임하지 말고 **오케스트레이터가 stream-json 이벤트에서 assistant turn을 카운트해 상한 초과 시 `stop()`** 으로 강제한다. 어차피 세션 수명은 오케스트레이터가 소유하므로(§5 상태머신) 이 방식이 설계 철학과 더 일치. → SessionSpec `budget.max_turns`는 **CLI 플래그가 아니라 오케스트레이터 정책값**으로 재정의.
- 부수: `--max-budget-usd`는 anthropic(A안, API 키) provider 쓸 때의 예산 가드로만 백로그.

---

## 3. stream-json 이벤트 스키마 (실측 완료)

프로브: `printf 'reply with the single word: ok' | claude -p --output-format stream-json --include-partial-messages --verbose` (2026-07-08, 승인 후 실행. 비용 $0.06, 14 이벤트). 도구 사용 없는 최소 호출.

**공통**: 모든 이벤트에 top-level `type`, `session_id`, `uuid`. 하위 구분은 `subtype`.

| type / subtype | 핵심 필드 | 파서 용도 |
|---|---|---|
| `system` / `init` | `session_id`, `model`(예 `claude-opus-4-8[1m]`), `cwd`, `permissionMode`, `tools`(배열), `agents`, `mcp_servers`, `skills`, `slash_commands`, `claude_code_version` | **세션 기동 확인 + session_id 확보**. `--session-id` 미지정 시 여기서 취득. 상태머신 `RUNNING` 진입 |
| `assistant` | `message`{`id`,`role`,`model`,`content`[{type: text/tool_use…}],`stop_reason`,`usage`}, `parent_tool_use_id`, `request_id` | **turn 카운트**(assistant 이벤트 = 1 turn → max_turns 강제). tool_use content로 도구 호출 관측 |
| `stream_event` | `event`(Anthropic SSE: message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop), `parent_tool_use_id`, `ttft_ms` | StatusBoard 실시간 텍스트/진행. 첫 토큰 지연(ttft) |
| `system` / `status` | `status` | 세션 상태 표시 |
| `system` / `hook_started`·`hook_progress`·`hook_response` | `hook_name`, `hook_event`, `outcome`, `exit_code`, `stdout`/`stderr` | **T3 거부 훅 관측** — PreToolUse 훅 발화·거부 결과가 여기로. 권한 위반 감지 |
| `rate_limit_event` | `rate_limit_info`{`status`(allowed/…), `resetsAt`(epoch s), `rateLimitType`(five_hour/weekly), `overageStatus`, `overageDisabledReason`, `isUsingOverage`} | **강등 사다리 + 체크포인트/재개의 1급 신호** (§4.2 참고) |
| `result` / `success` | `is_error`, `result`(최종 텍스트), `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage`{input/output/cache_creation/cache_read/…, `modelUsage`(모델별)}, `stop_reason`, `terminal_reason`, `permission_denials`(배열), `api_error_status` | **세션 종료 처리**: 성공/실패 판정, 토큰·비용 집계(run_state.usage), 권한 거부 목록, 종료 사유 |

파서 계약 요지:
- 스트림은 NDJSON(한 줄 = 한 JSON). `result`가 **정확히 1회, 마지막**에 오며 세션 종료 신호.
- `is_error` + `terminal_reason` + `api_error_status`로 실패 분류 → 상태머신 `ABORTED` 사유.
- usage는 `assistant.usage`(중간)와 `result.usage`(최종 합계) 둘 다 존재 → 최종은 `result.usage` 채택(기존 provider usage 규약과 정합).

---

## 4. 실측이 바꾸는 설계 반영 요약

1. `SessionSpec.budget.max_turns` = CLI 플래그 아님 → **오케스트레이터가 `assistant` 이벤트를 카운트해 강제** (`result.num_turns`로 사후 검증). ARCH §3.1 각주 갱신 대상.
2. 강등 사다리(§1.1)는 `--model` + **`--fallback-model`** 조합으로 CLI 레벨 자동 폴백까지 활용 가능 (설계는 오케스트레이터 재산출만 가정했음 — 더 견고해짐).
3. 세션 ID는 `--session-id`로 **사전 할당**하거나 `system/init.session_id`로 취득 → run_state.sessions[] 추적 단순화.
4. v4 병행은 `claude agents`(`--bg` + `--json` 폴링)라는 1급 기반이 이미 있음 → SessionManager가 프로세스 핸들을 직접 들 필요가 줄 수 있음(설계 시 재검토).
5. **`rate_limit_event` 실존(설계 강화)**: ARCH §6.2 rate limit 대응(강등/체크포인트)이 추측이 아니라 **CLI가 turn마다 흘려주는 실데이터**로 구동 가능. `rate_limit_info.status`가 임계로 바뀌면 강등 사다리 발동, `resetsAt`(epoch)까지 체크포인트 대기 후 자동 재개. `overageStatus/overageDisabledReason`로 유료 초과분(overage) 사용 가부도 판단. → §6.2를 이벤트 기반으로 구체화 가능.
6. **T3 거부 관측 경로 확인**: PreToolUse 훅 결과가 `system/hook_response`(+`result.permission_denials`)로 스트림에 노출 → 오케스트레이터가 권한 위반을 사후 로그가 아니라 실시간으로 감지.
7. **비용 계측 보너스**: 구독 경로에서도 `result.total_cost_usd`·`modelUsage`(모델별)가 채워짐 → 미션 예산·모델 소모 프로파일(ARCH §10 첫 미션 계측)을 USD/모델 단위로 집계 가능.

---

## 5. 다음 작업 (ARCH §9 순서 기준)

- [x] §9-1 CLI 플래그 실측 (이 문서 §1·§2)
- [x] stream-json 이벤트 스키마 프로브 (이 문서 §3)
- [x] §9-2 ExecutionProvider(CLI) 골격 + 이벤트 파서 + 단일 세션 수명 (`src/exec/`) — **마감 확정** (Q1=Model A 결정, ARCH §1.0)
- [x] §9-3 권한 컴파일러(티어→규칙+훅패턴) (`src/exec/permissionCompiler.ts` + `registry/permission_policy.json`, 단위 포함 19/19)
- [x] §9-4 worktree 수명 + L1 기계 게이트 (`src/exec/{worktree,machineGate,runProcess}.ts`, 단위 포함 29/29)
- [ ] §9-5 대화형 게이트(ApprovalQueue) + diff 미리보기 + tell + PromptCompiler(§3.1.1) → v3 acceptance ← **다음**

**§9-4 산출물**: `worktree.ts`(세션당 `.harness/worktrees/<run>/<sid>` + 브랜치 `harness/<run>/<sid>`, develop 기준, 생성/제거/조회 — 병합·푸시는 게이트 몫) + `machineGate.ts`(L1: package.json scripts에서 typecheck/lint/test/build 탐지·실행, 없으면 skip, 하나라도 실패=passed:false) + `runProcess.ts`(버퍼링 실행 헬퍼). `.harness/`는 gitignore. worktree 테스트는 실제 git 임시레포로 검증.

**§9-2 산출물**: `src/exec/{types,streamParser,eventQueue,mockExecProvider,claudeCliProvider}.ts` + 단위 테스트 + 실측 fixture. Model A 확정.
**§9-3 산출물**: `registry/permission_policy.json`(PERMISSION_POLICY.md §7 → 기계본) + `permissionCompiler.ts`(SessionSpec+정책 → allow/ask/deny 규칙 + Claude Code settings + T3 hookDenyPatterns) + `materializeSettings`. claudeCliProvider가 `--settings`로 소비.
⚠ **e2e 실측 대기**: `--settings`가 `permissions.allow/ask/deny`를 이 형태로 수용하는지, 규칙 문자열 문법(`Bash(cmd:*)`/`Read(glob)`) 정확성은 세션 실호출 시 확인.

호출 인자 확정형(§9-2 착수 기준):
```
claude -p --output-format stream-json --include-partial-messages --verbose \
  --permission-mode acceptEdits --allowedTools <컴파일 목록> \
  --model <spec.model> --fallback-model <강등대상> \
  --session-id <사전할당 uuid> --add-dir <worktree> \
  --append-system-prompt <역할>
# 후속 지시: --resume <session_id> (stdin으로 메시지)
```
