# CONTEXT_SUMMARY.md

최종 갱신: 2026-07-21

## 최신 (2026-07-22 세션 — V3 M3c-3a signal P0 보완, M3c-3b 계획 검토 전)

- **startup/in-flight signal 즉시 종료 결함 보완.** fake `npx` fixture만.
- **원인**: AbortSignal이 serve(startup 완료 후)에만 붙어 startup/in-flight signal이 timeout(30s/60s)까지 대기.
- **보완**: 단일 관리 Promise로 재구성, **downstream spawn 직후부터** abort 연결(이미 aborted면 즉시). signal ⇒ 즉시 group 종료+pending reject+queue 폐기, child close 후 HOME 삭제. main SIGINT=130/SIGTERM=143(그대로), settled 후 stdout 미기록. listener 완료 시 제거, cleanup 정확히 1회(경합 안전), markDead가 timer clear.
- **downstream 응답 계약 위반(malformed/bad jsonrpc/id mismatch/result 비객체/cap/timeout/조기 close)=fatal group 종료. 일반 JSON-RPC tool error·result budget·입력 정책 거부=세션 유지**(그 호출만 거부).
- **P1**: main에서 env 백도어 제거, cleanup 실패는 `cleanupFaultForTest` 함수 seam으로만.
- 테스트 21→26(+5: exec SIGINT 130/SIGTERM 143 3초 내·descendant·HOME, env 무시 exit 0, downstream malformed/bad-result fatal, 정책거부/tool error 뒤 정상호출). 검증: exec 75 + core 234 + acceptance 71.
- **M3c-3b = 계획 검토 전 유지. 5개는 아직 노출 승인 아님. 전체 M3c 미완료.**

## 최신 (2026-07-22 세션 — V3 M3c-3a proxy P0/P1 보완, M3c-3b 착수 보류)

- **M3c-3a 프록시 P0 3건+P1 보완. M3c-3b(profile/handoff 배선)는 보류. 전체 M3c 미완료.** fake PATH `npx` fixture만.
- **P0-1** `main()`+ESM 가드(실행 진입점) — stdin/stdout 구동, stdout JSON-RPC 전용, stdin 정상종료+cleanup 성공만 exit 0, cleanup 실패/startup 실패/signal non-zero, SIGINT/SIGTERM에서 group 종료+HOME cleanup. **P0-2** tools/list/tools/call은 **bare name**만(`mcp__shadcn__` prefix는 host가 생성 — 서버 반환 금지), prefix 입력 거부, host-namespaced는 내부 보고만. **P0-3** `terminateProcessGroup()` 공용, fatal downstream(timeout/cap/malformed/id-mismatch/조기종료)은 즉시 그룹 종료+안전 오류 응답 후 finalize; 정책 거부(result_too_large 등)는 downstream 유지.
- **P1**: negotiated protocolVersion 저장→upstream init 응답 사용, initialize→initialized→tools/* 상태 머신, notification 무응답, id string/number 구분(1≠"1"), buffer/queue(≤64) 상한, constructor/spawn 실패 cleanup, cleanup_failed 표면화.
- 테스트: 기존 13개 공식 MCP 계약으로 교정(bare·순서) + 8 추가 = 21. 검증: exec 75 + core 229 + acceptance 71.
- **M3c-3b = 계획 검토 후 착수(보류). 5개는 아직 노출 승인 아님.**

## 최신 (2026-07-22 세션 — V3 M3c-3a shadcn read-only filtering MCP proxy, offline)

- **M3c-3a offline proxy 완료. profile 등록·노출 승인 아님. 전체 M3c 미완료.** fake PATH `npx` fixture만(실제 shadcn/network/Claude 없음). registry/tool_profiles.json·handoff·profiles·CLI 미수정.
- **`src/tools/shadcnReadMcpProxy.ts`(+`.test.ts`)·`src/tools/shadcnReadPolicy.ts`(신규)**: 원본 7개 전부 노출 문제 → 로컬 필터 MCP 프록시가 경계 제공. upstream엔 5개만·**로컬 제한 schema**(downstream desc/schema 미노출), downstream 고정 `npx --yes shadcn@4.13.1 mcp`(seam 없음). startup: components.json 검사(child 이전)→downstream init(허용 protocol·caps.tools·serverInfo)→tools/list **실측 7개 정확 일치** 아니면 fail-closed. 금지 2개 tools/list 미노출+call fail-closed(downstream 미전달), unknown/dup id/malformed fail-closed. 입력 정책(additionalProperties:false, registries=["@shadcn"]·types=["ui"]·limit1-20·offset0-1000·query1-200·view items 1-10 @shadcn/ prefix·traversal/URL/제어문자 금지). 상한: call≤6·60s·단일 256KiB·stdout2MiB·stderr64KiB, **resultChars>8000 hard reject(원문·pointer 미전달)**, isError/빈/structured/non-text fail-closed. child env allowlist+임시 HOME(ambient secret 미전달). 종료는 그룹 kill(detached, descendant 방치 없음)→close 확인→temp 정리.
- 테스트(+13, core 221). 검증: exec 75 + core 221 + acceptance 71.
- **미완료**: profile 등록·노출 승인·handoff 연결·result-size enforcement 정식 배선 = M3c-3b. 5개는 아직 노출 승인 아님.

## 최신 (2026-07-22 세션 — V3 M3c-2 actual live read semantics acceptance PASS)

- **M3c-2 offline+actual live 완료(PASS). 전체 M3c 미완료.** live runner 1회 exit 0, Claude 미사용(shadcn@4.13.1 stdio), 실행으로 코드·git 불변.
- 고정 5개(`get_project_registries`→`list_items_in_registries`→`search_items_in_registries`→`view_items_in_registries`→`get_item_examples_from_registries`) 정확 순서 호출, 금지 2개 미호출, 5회 unchanged=true, 전 결과 contentTypes=[text]·structuredContentPresent=false·withinProposedBudget=true.
- 실측 responseBytes/textChars: 365/285, 274/194, 289/207, 172/94, **최대 get_item_examples 4441/4161(budget true)**. config 정확·권한(runtime700/config600/snapshot600)·redaction·cleanup·잔존 없음 통과.
- 증거 경계: resultChars/resultBytes·protocolVersion/serverInfo 정확값은 이번 출력에 없어 추측 안 함(계약 통과로만 기록; 2025-11-25/shadcn 1.0.0은 M3c-1 실측 구분). 단일 무변경≠모든 부작용 부재.
- **5개는 노출 승인 아닌 검증 후보. 권한 분류·profile·handoff·result-size enforcement 미착수. 다음: M3c-3 권한 매핑·필터링·result-size enforcement 계획 검토(구현 미착수).**

## 최신 (2026-07-22 세션 — V3 M3c-2 read semantics probe P0/P1 보완, live 전)

- **M3c-2 P0 2건+P1 2건+runner 정합성 보완. actual five read calls 승인 대기. 전체 M3c 미완료.** fake stdio MCP fixture만(실제 shadcn/network 없음).
- **P0-1**: 호출 계획·금지·protocol allowlist를 non-exported 내부 상수 + deep-freeze로. 외부는 clone getter(`getSemanticsCalls`/`getForbiddenCallTools`/`getAllowedProtocolVersions`)만. 시작 시 독립 contract와 exact 비교(이름·순서·args canonical hash·중복·금지). getter clone/set 변조가 실제 호출/인자·금지·allowlist에 영향 없음 테스트.
- **P0-2**: withinProposedBudget을 text가 아니라 **전체 결과 canonical `resultChars`≤8000**으로 판정(+resultBytes). responseBytes=raw line bytes. structuredContent 큰 경우 budget false(측정만).
- **P1-3**: fs snapshot에 root type/mode 포함, baseline symlink spawn 전 차단, `O_NOFOLLOW` fd fstat/read(TOCTOU), 파일별 1MiB·전체 16MiB 상한, MAX_FS_ENTRIES off-by-one 수정. root chmod/기존 symlink/oversized 테스트.
- **P1-4**: 모든 실패 경로 kill→bounded close 후 reject, close 전 HOME/cache 미삭제, cleanup 실패 `cleanup_failed`. 실패/runner 후 `m3c2-home-*` 잔존 없음.
- **runner**: clone getter 사용, mcp-config 정확·권한(config600/runtime700/snapshot600), snapshot 구조(허용 key)로 raw payload 검사, capabilities.tools plain object.
- 테스트(+2 net, core 208). 검증: exec 75 + core 208 + acceptance 71.
- **미완료**: 권한 분류·profile 등록·handoff 연결·result-size enforcement. 5개는 노출 승인 아닌 검증 후보.

## 최신 (2026-07-21 세션 — V3 M3c-2 controlled read semantics probe scaffold, offline)

- **M3c-2 controlled semantics scaffold offline 완료. actual five read calls 승인 대기. 전체 M3c 미완료.** 실제 shadcn/network 미실행(fake stdio MCP fixture). profile/handoff/registry/result-enforcement 없음.
- **`src/tools/shadcnReadSemanticsProbe.ts`(신규)**: exact `npx --yes shadcn@4.13.1 mcp`. init→initialized→tools/list(7개 exact)→ **읽기 후보 5개만 고정 인자로 순차 tools/call**(코드 상수, 주입 seam 없음). 금지 2개(get_add_command_for_items·get_audit_checklist)는 호출 경로 없음. serviceCwd 호출 전/후 재귀 snapshot(경로·타입·mode·size·SHA-256)로 무변경 검증 — 생성/수정/삭제/symlink 시 `filesystem_changed` fail-closed. HOME/cache는 serviceCwd 밖 임시. CallToolResult(content/structuredContent/isError) 계약·isError/빈/malformed 거부. **외부 결과 원문 미저장** — 파생 지표만(hash/count/type/elapsed/bytes/unchanged/budget). 상한: 5회·per-call 60s·overall 5min·단일 256KiB·stdout 2MiB·stderr 64KiB·budget 8,000 chars **측정만**(초과 `withinProposedBudget:false`, 자르지 않음). artifact `mcp-read-semantics.json`(mode:read-semantics·usableForHandoff:false·externalDataUntrusted:true, dir700/file600/wx). operationSummary{initialize:1,initialized:1,toolsListPages≥1,toolCalls:5,calledTools:[5개],forbiddenToolCalls:0}.
- **`scripts/m3c2-live-read-semantics.mjs`(신규)**: `HARNESS_LIVE_M3C2_SEMANTICS=1` 없으면 exit 2, Claude 미사용, metrics만 출력·cleanup·잔존 검사. **이번 세션 미실행.**
- 테스트(+14, core 206). 검증: exec 75 + core 206 + acceptance 71.
- **미완료(주장 금지)**: 5개는 노출 승인 아닌 검증 후보. 권한 분류·profile 등록·handoff 연결·result-size enforcement 미완료. **다음: actual five read calls(승인 후) → 노출 승인·enforcement 설계.**

## 최신 (2026-07-21 세션 — V3 M3c-1 actual live schema probe PASS, offline+live 완료)

- **M3c-1 offline+actual live 완료(PASS). 전체 M3c 미완료.** live runner 1회 실행 exit 0/OK, Claude 미사용, tools/call 없음, cleanup·잔존 프로세스 통과.
- 실측: package `shadcn@4.13.1`, protocolVersion **2025-11-25**, serverInfo `shadcn 1.0.0`, 도구 7개 정확. **annotations·outputSchema 전 도구 없음.** inputSchema 요약 — items(get_add_command_for_items·view_items_in_registries required), query required(get_item_examples/search), get_audit_checklist·get_project_registries 입력 없음, list/search에 registries?/types?/limit?/offset?.
- **schema/description 실측됐으나 annotations/outputSchema 증거 없음. description은 서버 제공 untrusted → 권한 분류 근거로 미확정.** profile 등록·handoff 연결·도구 호출·result-size enforcement 미완료.
- **다음: M3c-2 controlled read semantics 검증 계획.** 검증: exec 75 + core 192 + acceptance 71.

## 최신 (2026-07-21 세션 — V3 M3c-1 schema probe P0 보완, live 전, offline)

- **M3c-1 P0 6건 보완. 실제 live schema probe 미실행·승인 대기. 전체 M3c 미완료.** fake stdio MCP fixture만 사용(실제 claude/npx/network 없음).
- P0-1 runner `checkComponentsJson` import를 `shadcnPilot.js`로 정정 + offline smoke(exit 0). P0-2 `HARNESS_SHADCN_NPX_BIN` 제거(항상 `npx --yes shadcn@4.13.1 mcp`, 테스트는 PATH의 `npx` fixture). P0-3 schema **key** scrub 대상이면 `secret_in_schema_key` fail-closed(원 key 미노출). P0-4 protocolVersion `2025-11-25`+revision allowlist, capabilities(.tools)·serverInfo(name/version) 검증, description optional·title 수집·inputSchema/outputSchema root type:object 강제·annotations untrusted hint. P0-5 raw Buffer byte 상한+StringDecoder, 수집 후 child close bounded wait(미종료 `child_did_not_close`). P0-6 결과 `operationSummary{...,toolCalls:0}`·raw payload 미저장.
- 테스트(core 192). 검증: exec 75 + core 192 + acceptance 71, runner offline smoke·opt-in exit 2.
- **미확정(주장 금지)**: 권한 분류·profile 활성화·handoff 연결·result-size enforcement. 실제 schema는 runner 승인 실행 후.

## 최신 (2026-07-21 세션 — V3 M3c-1 tools/list schema discovery scaffold, offline)

- **M3c-1 schema scaffold offline 완료. actual live schema probe 승인 대기. 전체 M3c 미완료.** 실제 claude/npx/shadcn/네트워크 미실행(fake stdio MCP fixture 검증). tools/call 미구현·미전송, profile 등록·handoff 연결·권한 분류 없음.
- **`src/tools/shadcnSchemaProbe.ts`(신규)**: shadcn 전용 좁은 stdio JSON-RPC probe. `initialize→notifications/initialized→tools/list`만(tools/call 코드 경로 없음). 명령 정확히 `npx --yes shadcn@4.13.1 mcp`(주입 seam 없음, 테스트는 `HARNESS_SHADCN_NPX_BIN` launcher만 교체). protocolVersion `2025-06-18` 엄격 negotiation. registry 검사를 config/spawn 이전 강제. bare 도구명→`mcp__shadcn__` namespacing→M3c-0 7개 정확 일치. pagination(반복 cursor·페이지8·64개 상한), name/description/inputSchema 필수·outputSchema/annotations plain object, 깊이/키/크기 상한, JSON-RPC/malformed/no-init/timeout/non-zero/stdout(1MiB)/stderr(64KiB) 거부. 산출물 `mcp-schema-discovery.json`(mode:schema-discovery·usableForHandoff:false, raw payload 미저장, 반환==저장, dir700/file600/wx, deep-scrub, `ShadcnSchemaResult{schemaDiscovery:true}` 타입 분리).
- **`scripts/m3c-live-schema-probe.mjs`(신규)**: `HARNESS_LIVE_M3C_SCHEMA=1` 없으면 exit 2. shadcn MCP stdio 직접 실행(claude 미사용), 잔존 프로세스·tools/call 미전송 검증. **이번 세션 미실행.**
- 테스트(+12, core 188). 검증: exec 75 + core 188 + acceptance 71, npm pack 78(`shadcnSchemaProbe.js` 포함).
- **미확정(주장 금지)**: 권한 분류·profile 활성화·handoff 연결·result-size enforcement. 실제 schema는 runner 승인 실행 후 확정.

## 최신 (2026-07-21 세션 — V3 M3c-0 실제 live discovery 1회 실행, discovery offline+live 완료)

- **M3c-0 discovery offline+live 완료. 전체 M3c는 미완료.** Claude Code **2.1.216**에서 `shadcn@4.13.1` MCP discovery 1회 실행 — runner **exit 0/OK**, server `shadcn` **connected**, strict 격리(ambient canary 미기동), 권한(dir700/file600)·redaction·cleanup·잔존 프로세스 검사 통과. 실행으로 코드·git 상태 불변.
- **발견된 실제 MCP 도구 7개(원문, 권한 추측 금지)**: `get_add_command_for_items`, `get_audit_checklist`, `get_item_examples_from_registries`, `get_project_registries`, `list_items_in_registries`, `search_items_in_registries`, `view_items_in_registries` (모두 `mcp__shadcn__` prefix).
- **미착수**: profile 등록·handoff 연결·MCP 도구 호출·권한 등급 분류 없음(이름=권한 금지).
- **다음: M3c-1 — `tools/list` schema·semantics 검증 계획**(inputSchema·read/write 성격 실측 → 권한 매핑·profile 등록). 검증: exec 75 + core 176 + acceptance 71.

## 최신 (2026-07-21 세션 — V3 M3c-0 live runner 런타임 결함 2건 수정, live discovery 승인 대기)

- **runner 런타임 결함 수정(`scripts/m3c-live-discovery.mjs`만, src/dist 불변).** ① 잔존 polling의 `sleep` 미정의(ReferenceError) → inline `const sleep` 정의. ② versionEnv `LC_*` wildcard 제거 → 표준 POSIX LC 카테고리만 명시(LC_SECRET_TOKEN/LC_API_KEY 유출 차단). ③ `/bin/ps` 실패 fail-closed(`matchingShadcnPids`→{ok,error}, baseline 실패 exit 2·polling 실패 FAIL, redact).
- offline 실측: 잔존 프로세스 stub → polling 진입·ReferenceError 0·exit 1(테스트 PID ownership 정리), 정상 stub exit 0, LC_SECRET/LC_API 미전달, opt-in 없음 exit 2. 검증 exec 75/core 176/acceptance 71 유지.

## 최신 (2026-07-21 세션 — V3 M3c-0 live runner 최종 보안 보완, live discovery 승인 대기)

- **live runner 최종 보안 보완 완료. 실제 live discovery 승인 대기.** `scripts/m3c-live-discovery.mjs`만(src/dist 불변). 실제 Claude/npx/network 미실행(임시 stub 실측).
- `claude --version`: allowlist env만·timeout 10s·maxBuffer 64KiB(초과/오류 fail-closed, sentinel/ambient secret 미전달, claudeBin redact). discovery 오류는 rawMessage로 sentinel 검사 후 redact 출력(always-false 버그 정정). discovery 전/후 `/bin/ps`로 `shadcn@4.13.1 … mcp` 잔존 PID 감지(≤5s polling, 자동 kill 없이 redact 보고·FAIL). offline stub: runner exit 0, version env=allowlist만(sentinel/secret 부재). opt-in 없음 exit 2.
- 검증: node --check·build·npm test(exec 75/core 176/acceptance 71)·tsc noEmit·git diff --check 클린. **실제 도구명·profile·handoff·result-size enforcement 미확정, M3c 완료 아님.**

## 최신 (2026-07-21 세션 — V3 M3c-0 offline hardening, live discovery 미실행)

- **M3c-0 offline hardening 완료. live discovery 미실행.** Codex 재현(custom registry 수용·빈 도구 수용·foreign pin package·duplicate 도구명 평문 노출) 반영.
- **P0-1**: `runShadcnDiscovery`가 시작 직후 `checkComponentsJson` 강제(config/spawn/산출물보다 먼저) → custom/malformed/symlink/oversized면 `registry_<code>`·spawn 없음·runtimeDir 미생성. **P0-2**: `package` 우회 인자 제거 → 무조건 `shadcn@4.13.1`. **P0-3**: shadcn 도구 0개면 `no_tools`(성공 1~64). **P0-4**: 전 경로 typed 오류 code 보존+message scrub, 성공 snapshot(status/tools/package/timestamp) scrub 후 반환==저장(deepEqual), `redactNames`(scrub 전용·child 미전달).
- **P1**: components.json `O_NOFOLLOW` fd fstat/read(TOCTOU 방지), stdout 1MiB·stderr 64KiB 상한(초과 kill), 강제 env(MCP_CONNECTION_NONBLOCKING 등) testEnv 우회 불가, snapshot persist wx 충돌 typed·부분성공 미반환, runner 강화(claude --version·config 서버1개·권한·snapshot 계약·canary/sentinel 부재).
- **테스트(core 176)**: registry 판정·package 고정·discovery 성공/실패·registry 핵심강제·no_tools·redaction·forced env·persist·stream 상한. runPreflight/handoff/M3b.2 불변, registry/tool_profiles.json 불변. 검증: exec 75 + core 176 + acceptance 71.
- **실제 도구명·profile·handoff·result-size enforcement는 여전히 미확정. M3c 완료 아님.** live discovery는 별도 승인 후 실행.

## 최신 (2026-07-20 세션 — V3 M3c-0 shadcn discovery scaffold, offline)

- **M3c discovery scaffold offline 완료. 실제 discovery 및 profile 활성화는 미완료(미실행).** 실제 Claude/npx/shadcn/네트워크·MCP 도구 호출 안 함. registry 미등록·handoff 미연결.
- **`src/tools/shadcnPilot.ts`(신규)**: (1) shadcn 파일럿 정책 — `SHADCN_PACKAGE="shadcn@4.13.1"` pin, `npx --yes shadcn@4.13.1 mcp`, server=shadcn, secretRefs=[], `shadcnDiscoveryProfile`(tools=[] 발견 대상). (2) `checkComponentsJson` — 없음/registries 없음/빈 객체 허용, 항목 있음/비plain object→custom_registry_forbidden, malformed·symlink·비일반·64KiB→fail-closed(내용·secret 미포함). (3) `runShadcnDiscovery` — runPreflight와 분리된 별도 API, 단일 shadcn strict config + headless `claude -p` system/init 도구명 수집, 서버 정확 [shadcn]+connected, foreign/duplicate/empty/too-long/too-many/malformed/non-zero/no-init/timeout(60s) 거부, ≤64도구·≤256B·≤64KiB, raw init 미저장, 오류 redaction. 산출물 `mcp-discovery.json`(mode:"discovery"·usableForHandoff:false, `ShadcnDiscoveryResult{discovery:true}`)로 `PreflightSuccess{ok:true}`와 타입 분리.
- **`scripts/m3c-live-discovery.mjs`(신규)**: `HARNESS_LIVE_M3C_DISCOVERY=1` 없으면 exit 2, npm test/CI 비대상, 임시 serviceCwd·ambient canary·PID ownership 검사·signal/finally cleanup, 실제 도구명 출력·snapshot, 도구 호출/TUI 미실행. **이번 세션 미실행.**
- **테스트**: registry 판정·pin·discovery 성공/실패·산출물 권한·redaction·registry/tool_profiles.json 불변. runPreflight/handoff/M3b.2 불변. (하드닝 후 core 176 — 위 07-21 항목 참조.)
- **실제 shadcn 도구명(browse/search/install/add 등)은 아직 미확인** — runner를 사람이 실행해야 발견. **다음: M3c 파일럿 계획 검토(discovery 실행 → 도구명 확정 → profile 등록·handoff 연결).**

## 최신 (2026-07-20 세션 — V3 M3b.2 actual live acceptance 완료, PASS)

- **M3b.2 offline + actual live 완료(PASS)**: 실제 Claude Code 2.1.215에서 live runner(`scripts/m3b2-live-handoff.mjs`, `HARNESS_LIVE_M3B2=1`) exit 0/PASS. 앞선 P0(argv/planning 경로/sentinel 출력) 수정 후 재검증. 임시 `m3b2-live-*` 정리 완료.
- **통과 범위**: exact Hook 6종(exec form) · empty MCP snapshot(servers=[]/tools=[])·config({}) · planning contextRoot 접근(`--add-dir`, 00_IDEA/06_CEO_DECISION Read 성공, serviceCwd docs 미생성) · Read 성공/실패 callId correlation · Bash 승인(permission_requested callId=null + tool_requested/succeeded, 비출력 sentinel 검사) · Write 수동 거부(requested+permission·marker 부재, denied 미합성) · SessionEnd 1건 · ambient MCP/Hook canary 미기동(strict + `--setting-sources ""`) · trace redaction·권한(dir700/file600)·원문 미저장 · run_state 불변 · argv `-p`/stream-json 없음(`--` 꼬리).
- **버전 종속 실측**: 2.1.215. CLI 변경 시 재검증. 실패 시도(argv P0·planning P0-1·sentinel P0-2)는 역사 기록으로 유지.
- **다음: M3c(shadcn read) 파일럿 계획 검토**(구현 아님). 검증: exec 75 + core 159 + acceptance 71.

## 최신 (2026-07-20 세션 — V3 M3b.2 두 번째 live P0 2건 + 수정, 전체 PASS 아님)

- **두 번째 live acceptance 전체 PASS 아님**: argv `--` 꼬리는 통과했으나 P0 2건 발견. 실제 Claude/TUI 미재실행, 수정·offline 검증만.
- **P0-1 planning 경로 단절**: task prompt Include는 `docs/*.md` 상대경로인데 대화형 cwd=serviceCwd, 실제 planning 문서는 `projectPaths(project).root/docs`. Claude가 docs 못 찾고 serviceCwd에 잘못된 `docs/WORKLOG.md` 생성. → 수정: `contextRoot=projectPaths(project).root` + argv `--add-dir <contextRoot>` + initialPrompt 경로 계약(Include=contextRoot 절대경로, serviceCwd/contextRoot 별개, WORKLOG=contextRoot/docs/WORKLOG.md, serviceCwd docs 금지) + preview에 두 경로 별도 표시 + 128KB fallback도 contextRoot 접근. `--disallowedTools mcp__* -- <initialPrompt>` 꼬리 유지.
- **P0-2 sentinel TUI 평문 출력**: Bash 검증이 `printf '%s' "$M3B2_LIVE_TOKEN"`이라 fake sentinel 값이 TUI에 출력됨(실제 credential 아님, runner fake). → 수정: `node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'`(비출력 존재 검사)로 변경. 값은 terminal/settings/config/snapshot/trace/outcome에 미출력. collector redaction 단위 테스트 유지.
- **테스트/runner**: `--add-dir=contextRoot`·경로 계약·serviceCwd docs 미생성 회귀(core 단위 + runner), planning 문서(00_IDEA/06_CEO_DECISION) Read 성공 trace, Write 거부 안내(기본 Yes에서 Enter 금지·방향키 No·재시도 금지).
- **상태: M3b.2 live 재검증 대기**(전체 PASS 아님). 검증: build/tsc noEmit 클린, exec 75 + core 159 + acceptance 71.

## 최신 (2026-07-20 세션 — V3 M3b.2 첫 live 시도 무효(argv P0) + 수정)

- **첫 live acceptance 시도 무효(argv P0)**: 대화형 spawn argv 꼬리가 `--disallowedTools mcp__* <initialPrompt>`였는데, `--disallowedTools`(가변 인자)가 프롬프트를 deny 규칙으로 소비 → Claude Code 2.1.215에서 `Permission deny rule "..." matches no known tool` 경고 폭주. **Hook 검증 미수행, PASS 아님.**
- **수정**: `src/core/handoff.ts` argv 꼬리를 `--disallowedTools`, `mcp__*`, `--`, `initialPrompt`로(옵션 종료 구분자 `--`). 회귀 테스트 2지점 추가(`handoff.test.ts` 기존 성공 테스트 강화 + 전용 P0 테스트), runner(`m3b2-live-handoff.mjs`) 사후 argv 검증에 `--` 종료·prompt 격리 확인 추가. 대화형 TUI·stdio inherit·`-p`/stream-json 미사용 불변.
- **상태: M3b.2 live acceptance 재실행 대기**(offline 검증만 완료, 실제 Claude/TUI 미재실행). 사람이 runner 재실행해야 실제 Hook 검증 성립. **M3c(shadcn read)는 live 통과 후.**
- 검증: build/tsc noEmit 클린, exec 75 + core 158 + acceptance 71.

## 최신 (2026-07-20 세션 — V3 M3b.2 offline 최종 보완)

- **offline 최종 보완(실제 Claude/TUI/live Hook 미실행)**: ① 승인 preview 전체 redaction — `buildPreview`가 task prompt head만이 아니라 cwd·trace 등 모든 동적 문자열을 포함한 최종 결과 전체를 scrub(승인 화면 secret 평문 부재). ② collector 검증 예외 정규화 — stat/readability 검증을 try/catch로 감싸 부재·디렉터리·stat/access 오류를 예외 없이 scrub된 `setup_failed`로 반환(preflight/spawn/handoff 기록 없음). production 경로는 `PACKAGE_ROOT/dist/tools/hookCollector.js` 유지 + 테스트용 `collectorPath` seam. ③ 테스트 정합성 — wx 충돌 테스트를 "trace 파일 exclusive-create 충돌"로 개명, collector 부재/디렉터리 setup_failed 테스트 추가, preview 전체 scrub 테스트 추가. 검증: exec 75 + core 157 + acceptance 71.
- **다음: M3b.2 actual Claude Hook live acceptance(수동)** — 아래 07-19 항목과 동일(empty MCP/settings/Hook 대화형 경로 live 미검증). **M3c(shadcn read)는 live 통과 후.**

## 최신 (2026-07-19 세션 — V3 M3b.2 Interactive handoff, offline)

- **M3b.2 완료(offline + P0/P1 보완)**: 문서 완료 → Claude Code 대화형(TUI) 핸드오프. `src/core/handoff.ts`(신규, `runHandoff` 명시적 outcome union)·`src/commands/handoff.ts`(신규)·`src/cli.ts`·`src/commands/run.ts`(`--handoff`/`--cwd`). 시퀀스: print → completed 확인 → summary/task-prompt 갱신 → initialPrompt(128KB 초과 시 절대경로 지시, "AGENTS.md·CLAUDE.md 준수" 명시) → missing binary/non-TTY 폴백 → 승인 게이트 → **collector 존재 검증(setup_failed)** → **fail-closed preflight(빈 MCP config, ambient 감지 차단)** → 산출물 exclusive-create(0600/dir700) → spawn. argv: `--strict-mcp-config --mcp-config <빈> --settings <hook-settings> --setting-sources "" --add-dir <contextRoot> --permission-mode default --tools default --disallowedTools mcp__* -- <initialPrompt>` (가변 인자 `--disallowedTools` 뒤 `--`로 옵션 파싱 종료 → prompt를 positional로; `--add-dir <contextRoot>`는 planning 문서 접근용, P0 수정 반영). **`-p`/stream-json 없음, stdio inherit.** Hook settings 공식 exec form(command=node, args=[dist collector 절대경로, kind]). redaction refs는 env 이름에서 파생(값 미기록)→`HARNESS_TOOL_SECRET_REFS`(이름)+preflight `redactNames`(scrub 전용, child 미전달). run_state.handoff는 실제 spawn 시에만(종료코드·completed 불변). trace JSONL은 spawn 전 빈 0600 사전 생성(append 후 0600 유지). 실제 Claude/TUI/live Hook 미실행. 검증: exec 75 + core 154 + acceptance 71.
- **다음: M3b.2 actual Claude Hook live acceptance(수동)** — `--setting-sources ""` 수용, exec-form Hook 6종 등록, 6 payload, trace redaction·0600, TUI 유지·stream-json 미사용. **M3c(shadcn read)는 live 통과 후.**

## 이전 (2026-07-19 세션 — V3 M3b.1 HookTrace 기반, offline)

- **M3b.1 완료(offline + P0/P1 하드닝)**: Hook payload→공통 ToolTrace JSONL. `src/tools/{toolTrace,hookCollector,hookSettings}.ts`(+test), `trace.ts` sanitizeValue(민감 key 마스킹+depth 상한). 6 이벤트/필수 필드, collector fail-closed(엄격 config·payload 계약 검증·PreToolUse/PermissionRequest exit2·사후 exit1·stack/secret 미출력), PermissionRequest 공식 payload엔 correlation ID 없음→callId=null·synthetic 미생성·permissionOutcomeObservable:false, SessionEnd는 종료 사실만(unresolved·승인 결과 추측 금지), UTF-8 byte·재귀 depth 상한, settings shell-safe quoting+denyMatchers dedupe, env 계약(secret 이름만), 원문 미저장. `toRunEvent`는 post-session/테스트용(실시간 emit 없음). 실제 Claude/TUI 미실행. 검증: exec 75 + core 131 + acceptance 63.
- **다음 M3b.2**: handoff command/spawn, settings 파일 write·claude 실행, 실제 Claude Hook 이름 대응 실측. 대화형은 `stdio:inherit`+Hooks만(stream-json은 M3a preflight 전용). (M3c shadcn은 그 뒤.)

## 이전 (2026-07-19 세션 — V3 M3a offline+live 완료)

- **M3a offline+live 완료**: 수동 live runner(`scripts/m3a-live-preflight.mjs`, `HARNESS_LIVE_M3A=1`)로 실제 Claude Code **2.1.215** 실측 PASS — expected server connected, `mcp__expected__read_thing` 정확 일치, ambient canary 미기동(strict 격리), sentinel/config/snapshot redaction 통과, fixture·임시 디렉터리 잔존 없음. **버전 종속 실측(CLI 변경 시 재검증)**. offline(파서/config/preflight/보안 보완)은 커밋 `cbb8749`.
- **다음**: **M3b 계획 검토**(handoff trace: Hook→ToolTrace JSONL). M3c shadcn은 그 뒤.

## 이전 (2026-07-19 세션 — V3 M3a live 전 보안 보완)

- **M3a 보안 보완**: npx 정확 고정버전 강제(unpinned/latest 거부, node 예외), config 강화(중복도구·transport 혼합·credential·secret 실값 거부), preflight env 격리(allowlist+선언 secret만, testEnv seam), snapshot redaction 정합(반환=저장, 실패 시 미생성), init fixture 9곳 `mcpServers:[]`. 실제 claude 미실행. 검증: exec 75 + core 94 + acceptance 63.
- **다음**: M3a live(실제 구독 호출 실측) → M3b handoff trace → M3c shadcn read.

## 이전 (2026-07-19 세션 — V3 M3a Headless MCP preflight, offline)

- **M3a 완료(offline)**: system/init 파서 확장(`McpServerStatus`, connected는 "connected"만), MCP config 생성(`claudeCodeMcpAdapter.ts` — 서버 검증·@latest 거부·alwaysLoad·SHA-256·runtime gitignore), headless preflight(`preflight.ts` — argv/env 강제·hard timeout·init 후 의도적 종료), snapshot 검증(정확 비교·canary 자동 실패·fail-closed `PreflightError`·redaction). 실제 claude 미실행(stub acceptance). M2.1 MCP fail-closed 유지. 검증: exec 75 + core 74 + acceptance 63.
- **다음**: M3a live(실제 구독 호출로 argv·system/init·strict 격리·canary 실측) → M3b handoff trace(Hook→ToolTrace JSONL) → M3c shadcn read.

## 이전 (2026-07-19 세션 — V3 M2.1 P0 보완)

- **M2.1 완료(M3 이전 선행 보완)**: ① 정책 실제 전달 — `ProviderExecContext{claudeArgs,redactNames}`로 compile된 policy를 runWorkflow→runAgent→claudeCodeProvider spawn argv까지 배선(mock/anthropic 무시, 미지정 회귀 없음). ② MCP fail-closed — `hasMcpBinding` profile은 run_start 이전 거부(loader/compile은 성공, M3용). ③ secret redaction — invalid secretRef 오류 index만, provider 오류 stderr/stdout `redactSecrets` 통과, 값은 context로 미전달(이름만). ④ JSONL writer optional 재귀 redaction(원본 불변). 검증: exec 74 + core 52 + acceptance 63.
- **다음 M3**: M3a preflight(stream-json/system·init snapshot/canary 격리) → M3b handoff trace(Hook→ToolTrace JSONL) → M3c shadcn read. MCP config 생성·전달·snapshot 강제가 여기서 배선(그 후 MCP profile fail-closed 해제 가능).

## 이전 (2026-07-17 세션 — V3 M0 + M1 + M2)

- **V3 M2 완료(Capability/ToolProfile 정책 계층)**: `src/tools/{capabilities,profiles,adapters,redact}.ts` + `src/providers/capabilities.ts`. 3계층 capability(repo_write_direct 분리), ToolBinding 4종(builtin 포함), ToolProfile(bindings 필드, exposedTools compile 파생), 수동 validator(의존성 0), compileToolProfile(4버킷), binding 기반 fail-fast(run 시작 전), redaction, `--bare` argv. registry=`planning-none`/`planning-local-readonly`만. `--tool-profile`·`--bare` CLI 플래그. golden snapshot 회귀. M1 무영향. 검증: exec 74 + core 37 + acceptance 63.
- **다음 M3**: handoff + shadcn read + stream-json 파싱(tool 이벤트 실 방출·trace 배선) + mcp-config write·claude 전달 + `system/init` snapshot 격리 실측.

## 이전 (2026-07-17 세션 — V3 M0 + M1)

- **V3 M1 완료(진행 이벤트 모델)**: `src/core/progress.ts`(RunEvent/ProgressReporter) — run_start/step_start/step_end/gate_jump/run_end + tool_*(타입 골격) + note{level}. runWorkflow가 모든 top-level step에 이벤트 방출(index 1-based, kind/round, 실제 jump만 gate_jump), try/finally로 예외에도 run_end{failed} 보장. RunState.step_timings 저장. 렌더러(`commands/progress.ts`) 이벤트 소비형 재작성(출력 계약 보존, gate/approval 스피너 없음). `src/tools/trace.ts` 범용 JSONL writer 골격(runWorkflow 미배선). 테스트: core 8 신규(`test:core`). 검증: exec 74 + core 8 + acceptance 63.
- **V3 M0 완료(문서 동기화)**: taskPrompt provider 수정, CLI 버전 package.json 단일 원본, CLAUDE.md 교정, SUPERSEDED→archive, HANDOFF v2.6 각주.
- **다음**: M2(Capability/Profile 기반) — 별도 승인 대기. M3에서 handoff+shadcn read+stream-json 파싱(여기서 tool 이벤트 실 방출·trace 배선). 활성 기준: `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`, `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md`.
- **후속 정리 항목**: README v1/v2.6 범위 서술 갱신, V3 문서의 exec/mission 실행 계층 미참조, package.json.files(M2에서 registry/schemas 추가).

## 최신 (2026-07-08 세션)

- **진행 표시자 추가**: run 중 TTY 스피너(`⠹ [2/5] research 실행 중… 0:42`)+경과시간, 비TTY는 `▶` 폴백. `src/commands/progress.ts` + `runWorkflow.ts`의 `ProgressReporter` 인터페이스. core는 TTY 무지 유지. 57/57.
- **실행 계층 설계 핸드오프**: 창업자 비전(문서→자동 실행→병행/다중 라이브 세션→라이브 분화, 큰 이슈만 예/아니요) vs 현재(문서 생성만) 갭·다음 스텝 정리 → `docs/reference/EXECUTION_LAYER_DESIGN_BRIEF.md`. **설계는 별도 Fable 세션 예정.** (결정: docs/DECISIONS.md 2026-07-08)

## 현재 상태

- **하네스 v1 구현 완료.** acceptance Test 1~5 전부 통과 (`npm test` → 30 checks all pass).
- 5개 명령 동작: list / init / run / summary / task-prompt (mock provider 기반, 실제 LLM 미호출).
- 코드 구조:
  - `src/cli.ts` — commander 진입점
  - `src/core/` — paths, registry, project, runAgent, runWorkflow, validate, saveArtifact, summary, taskPrompt
  - `src/providers/` — provider 인터페이스 + mockProvider
  - `src/commands/` — 각 CLI 명령 래퍼
- `scripts/acceptance.sh` = 통합 검증 스위트 (`npm test`/`npm run acceptance`).
- git: origin = github.com/agrade1/solo-founder-harness, main 브랜치에 단계별 커밋/푸시.
- 비공개: `projects/idea-discovery/IDEA_*.md`는 .gitignore로 원격 제외.

## v2 진행 상황 (2026-07-06 착수)

- **provider 전략 C안 확정** (설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md): mock/claude-code(B안,구독)/anthropic(A안,API) 3종 교체. 지금은 claude-code, A안은 나중.
- **[v2-1 완료] Provider 인터페이스 async화 + token usage 필드.** `generate()` → `Promise<AgentResult>`, run_state에 provider+usage 기록, `run --provider` 플래그.
- **[v2-2 완료] claude-code provider(B안).** `claude -p --output-format json` stdin 위임, usage 파싱. AgentRunInput에 ideaContent(00_IDEA.md) 추가. extractMainJudgment 문단형 대응 버그수정. dev-preflight end-to-end 검증 완료. mock acceptance 30/30 유지.
- 사용: `harness run <wf> --project <p> --provider claude-code` (claude CLI가 Max 구독 로그인 상태여야 함). 기본은 mock.
- **[v2-3 완료] 스키마 검증 재생성 루프.** 필수 헤더 누락 시 피드백해 재생성(`--max-regen <n>`, 기본 1). run_state.regenerations 기록.
- **[v2-4 완료] Red Team 비평 루프.** workflow steps를 `(string|{critique_loop})[]`로 확장. critic(red_team)이 Critical 리스크 발견 시 target(tech_lead)에 되먹여 revise→재검토, Critical 소멸/max_rounds까지. mvp-planning에 내장(`↻[red_team⟲tech_lead×2]`). run_state.critique_rounds 기록. mock+stub 검증, acceptance 30/30 유지.
- **[v2-6 완료] CEO 게이트 분기.** WorkflowStep에 `{gate}` 확장. decider(founder_ceo) 판정이 on 키와 맞으면 해당 agent로 되돌려 재실행(max_jumps로 무한루프 방지). full-predev에 내장(`⤴[founder_ceo?축소→pm,검증→research×1]`). run_state.gate_jumps 기록. mock+stub 검증.
- **[v2-5 완료] anthropic provider(A안).** @anthropic-ai/sdk 연동, 프롬프트 빌더를 promptParts.ts로 공유. ANTHROPIC_API_KEY 필요(종량과금). 키 없으면 안전 실패+claude-code 안내. 기본 provider는 mock 유지. **실제 유료 호출 미검증**.
- provider 3종(mock/claude-code/anthropic) + 루프 3종(재생성/비평/게이트) 완비.

- **[실전 검증 완료]** mvp-planning을 claude-code로 실제 실행 → 비평 루프 실작동 확인(red_team이 Critical 2건 발견→tech_lead 반영 수정→재검토→max_rounds 종료). 루프가 출력 개선함.
- **v2 완료 → v2.0.0 태그** (develop→main 병합).
- **[v2.1-A 완료] 라이브러리화.** 경로 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(=CWD, projects). 서비스 레포마다 설치. v2.1.0 태그·푸시 완료.
- **[B-② 완료] 동적 분화(fanout).** planner(tech_lead)가 `SPAWN id=..|name=..|focus=..` 선언 → fanout이 파싱 → **기본 계획만(사람 승인 게이트)**, `--allow-spawn` 시 하위 전문 에이전트 런타임 생성·실행(outputs/spawned/<id>.md). dev-preflight 내장. run_state.spawned_agents. v2.2.0 태그.
- **[B-③ 완료] 멀티에이전트 task-prompt.** spawned_agents 있으면 task-prompt에 "병렬 실행" 섹션(FE/BE별 담당·계획문서·통합·승인게이트) 생성. **하네스는 스펙 생성만, 실제 병렬 코딩은 Claude Code subagent(사람 승인 후).** stub 검증. **v2.3.0 태그**(develop→main 병합).
- **[Obsidian 완료] Obsidian 연동.** run 결과를 vault로 read-only export — agent별 노트(frontmatter + `[[wikilink]]` 이전/다음/인덱스) + run MOC 인덱스(실행 순서 링크 + 메타). `run --vault <path>` / `HARNESS_VAULT`, opt-in(미지정 시 무동작). `src/core/obsidianExport.ts`. acceptance Test 6 추가 → **35/35 통과**. (develop, 미태그 — v2.4.0 예정)

## v2.5 안정화 Phase 0 (2026-07-07, V3_KICKOFF 기반)

- v3 착수 조건 미충족 → v3 선결로 v2.5 Phase 0 먼저 구현(V3_KICKOFF.md 0-1~0-4). 각 항목 단위 커밋(develop).
- **[0-1] run --resume** — RunState status/failed_reason/resume_from/loop_state, 실패 지점부터 재개(완료 step은 산출물 복원, 재실행 X).
- **[0-2] token budget** — `--max-tokens`/`HARNESS_MAX_TOKENS`, 초과 시 중단→--resume, 80% 경고.
- **[0-3] approval gate** — `{approval}` step, 거부=user_rejected(재개 가능), `--yes` 비대화. dev-preflight 착수 승인 1곳.
- **[0-4] Red Team 편향 분리** — critic은 target 결론만 격리(contextMode=conclusion_only).
- mock `npm test` → **57/57 통과**.

## 현재 상태 요약 (한 줄)

provider 3종 + 루프 3종 + 분화 + 멀티에이전트 task-prompt + Obsidian + v2.5 안전장치(resume/budget/approval/편향분리) + ux_ui 디자인 레퍼런스 확장(v2.6.0)까지 완비. mock 기준 `npm test` 57/57. git: **main=v2.6.0**. public github 설치 지원(dist 커밋, `npm install github:agrade1/solo-founder-harness`). 실사용 개발 착수 1건 완료(audit-evidence-engine) → v3 게이트 충족.

## Phase 1 도그푸딩 완료 (2026-07-08)

- 실제 아이디어 A(증적엔진)/B(폐쇄망) full-predev(claude-code) 검증 — **CEO 게이트 두 분기(축소/검증) 실발화**.
- A로 dev-preflight(--allow-spawn --yes) → 하위 3개 실제 실행 + 승인게이트 + task-prompt 병렬 스펙 handoff.
- 하네스 self-review(mvp-planning) — critique_loop 2R + 0-4 편향분리 실전 검증.
- 실전 검증된 v2.5 경로: 게이트 두 분기·무한루프 가드·분화+allow-spawn·승인게이트·critique_loop·편향분리·토큰계측. 스키마 경고 0. (resume/budget만 실패상황 미재현, mock 검증됨.)
- 산출물: `docs/backlog/V3_FIELD_NOTES.md`. 아이디어 원문/결과는 gitignore된 `projects/dogfood-*` 로컬 전용.

## v3 진입 게이트 충족 (2026-07-08, 이 세션)

- **"실제 개발 착수 1건" 게이트 충족됨.** 별도 private 레포 `github.com/agrade1/audit-evidence-engine`(하네스 로컬 설치)에서 아이디어 A(증적엔진)를 full-predev(claude-code) 검증 → task-prompt → **실제 코드 착수 완주**(`scripts/collect_evidence.sh`: KISA U-코드 읽기전용 점검→증적 패키지. CEO 판정 경계 준수로 remediation/제품코드 없음). 아이디어 F(인프라교육)도 idea-validation로 추가 검증("추가 검증" 판정).
- → v3 착수 3조건(아이디어 2건 검증 + 1건 개발착수) **모두 충족.** 이제 v3는 "규율상 착수 가능" 상태.

## 다음 작업 (self-review 결론 반영)

- v3 게이트는 충족됐으나, self-review 처방대로 **바로 v3.0 코딩에 들어가지 않는다.** execute는 안전경계 시나리오("게이트 이후 실패 시 롤백 주체") 서면 뒤에만, report는 **관측성 통증이 실사용에서 수치로 확인된 뒤** 최소형. (FIELD_NOTES "자기검토 결론" 참고.)
- **관측성 통증 측정법**(v3 report 필요성 판단 기준): 하네스를 실서비스에 반복 사용하며 — ① run당 소요/토큰을 run_state에서 집계했을 때 "매번 파일 열어 확인"이 번거로운가, ② 프로젝트 여러 개의 최신 run 상태를 한눈에 못 봐서 불편한가, ③ 게이트 되돌림/실패 원인을 run_state.json 수동 파싱으로 찾는 빈도가 높은가. 이 통증이 실제로 쌓이면 그때 `harness report`(read-only 스냅샷 표)를 최소형으로.
- 하네스 자체는 현재 "충분히 좋다"(v2.5.0) — 다음 코딩은 하네스가 아니라 **실서비스(audit-evidence-engine 등)** 쪽에서 나온다.
- [보류] anthropic 유료 1회 실검증(비용), resume/budget 실패상황 재현 — 우선순위 낮음.
- 범위 확장 금지 유지. 하네스는 현재 "충분히 좋다"(v2.5.0).
