# WORKLOG.md

## 2026-07-21 (V3 M3c-1 — actual live schema probe PASS, offline+live 완료)

**M3c-1 offline+actual live 완료.** 사용자 승인 하에 `HARNESS_LIVE_M3C_SCHEMA=1 node scripts/m3c-live-schema-probe.mjs`를 1회 실행 — **runner exit 0 / schema discovery OK**. Claude CLI/구독 미사용(shadcn MCP stdio 직접), tools/call 없음, cleanup·잔존 프로세스 검사 통과. 실행으로 코드·git 상태 불변.
- **환경/결과**: package `shadcn@4.13.1`, **protocolVersion `2025-11-25`**, serverInfo `shadcn 1.0.0`. 도구 **7개 정확 일치**. **annotations: 전 도구 없음. outputSchema: 전 도구 없음.**
- **실측 inputSchema 요약**(서버 제공, 아직 권한 근거 아님):
  - `get_add_command_for_items`: items(required)
  - `get_audit_checklist`: 입력 없음
  - `get_item_examples_from_registries`: registries?, query(required)
  - `get_project_registries`: 입력 없음
  - `list_items_in_registries`: registries?, types?, limit?, offset?
  - `search_items_in_registries`: registries?, query(required), types?, limit?, offset?
  - `view_items_in_registries`: items(required)
- **한계(주장 금지)**: schema/description은 실측됐으나 **annotations/outputSchema 증거는 없음**(hint 부재). description은 **서버 제공 untrusted 정보**이므로 아직 read/write **권한 분류 근거로 확정하지 않는다**(이름·description=권한 금지). profile 등록·handoff 연결·MCP 도구 호출·result-size enforcement는 **미완료**. **전체 M3c 미완료.**
- **다음: M3c-2 — controlled read semantics 검증 계획**(승인·격리 하에서 각 도구의 실제 read-only 성격·결과 크기를 통제된 방식으로 확인 → 그 근거로 권한 등급·profile 등록·result-size enforcement). 이번 단계에서 M3c-2 코드·registry 변경·handoff 연결·도구 호출 없음.

## 2026-07-21 (V3 M3c-1 — schema probe P0 보완, live 전, offline)

**M3c-1 P0 6건 보완. 실제 live schema probe 미실행·승인 대기.** 실제 claude/npx/네트워크 미실행(fake stdio MCP fixture만).
- **P0-1 runner import 오류**: runner가 `checkComponentsJson`을 `shadcnSchemaProbe.js`에서 import(undefined)하던 것을 `dist/tools/shadcnPilot.js`에서 정확히 import. opt-in + fake npx(PATH)로 runner를 끝까지 도는 offline smoke 테스트 추가(exit 0·`is not a function` 부재 검증). 실제 npx/network 미호출.
- **P0-2 실행 명령 우회 제거**: production의 `HARNESS_SHADCN_NPX_BIN` 지원 완전 제거 → `runShadcnSchemaProbe`는 항상 `npx --yes shadcn@4.13.1 mcp`만 실행. 테스트는 임시 PATH에 `npx` 이름 fixture 배치 방식으로 전환. "주입 seam 없음" 문서 주장과 코드 일치(bogus env override 무시 테스트).
- **P0-3 schema key redaction**: 문자열 value뿐 아니라 **객체 key**도 검사 — key가 scrub 대상(secret/credential)이면 이름을 변형하지 않고 typed `secret_in_schema_key`로 fail-closed(오류·snapshot에 원 key 평문 없음). 중첩 properties key sentinel 테스트 추가.
- **P0-4 공식 MCP 계약 정합화**: 요청 protocolVersion `2025-11-25`(+ 이전 revision negotiation allowlist), "2025-06-18 최신 stable" 주장 제거. init result에서 capabilities plain object·`capabilities.tools` 존재·serverInfo.name/version non-empty string 검증. Tool.description은 **optional string**, optional **title** 수집, inputSchema·outputSchema root `type:"object"` 강제, annotations는 untrusted hint로 알려진 boolean 필드 타입만 검증(권한 판정 근거 아님).
- **P0-5 UTF-8·프로세스 lifecycle**: stdout byte 상한은 raw Buffer.length로 계산, `StringDecoder`로 chunk 경계 UTF-8 손상 방지. 수집 성공 후 stdin close→child close **bounded wait**(grace 후 SIGKILL, close 확인 전 resolve/저장 금지, 미종료 시 typed `child_did_not_close`). 멀티바이트 chunk 분할·종료 지연 fixture 테스트 추가.
- **P0-6 tools/call 증거 정직화**: 결과에 고정 `operationSummary {initialize:1, initialized:1, toolsListPages:n, toolCalls:0}` 반환, runner가 이를 검사. snapshot에 raw JSON-RPC payload 미저장, tools/call 생성 경로 부재 유지.
- 검증: build/tsc noEmit 클린, exec 75 + core 192 + acceptance 71, node --check·opt-in 게이트 exit 2·runner offline smoke PASS, git diff --check 클린.
- **미확정(주장 금지)**: 권한 분류·profile 활성화·handoff 연결·result-size enforcement. 실제 schema는 runner 승인 실행 후 확정. **전체 M3c 미완료.**

## 2026-07-21 (V3 M3c-1 — tools/list schema discovery scaffold, offline)

**M3c-1 schema scaffold offline 완료. actual live schema probe 승인 대기.** 실제 claude/npx/shadcn/네트워크 미실행(fake stdio MCP fixture로만 검증). **tools/call 미구현·미전송**, profile 등록·registry 변경·handoff 연결·권한 분류 없음.
- **좁은 stdio schema probe**(`src/tools/shadcnSchemaProbe.ts` 신규): shadcn 전용(범용 MCP client 아님). shadcn MCP 서버와 직접 stdio JSON-RPC로 `initialize → notifications/initialized → tools/list`까지만 대화. **tools/call 코드 경로 없음.** 실행 명령은 정확히 `npx --yes shadcn@4.13.1 mcp`(package/command/args 주입 seam 없음; 테스트는 launcher 실행 파일만 `HARNESS_SHADCN_NPX_BIN`으로 교체, pinned args 불변). MCP protocolVersion 상수(`2025-06-18`)·허용 집합으로 negotiation 엄격 검증.
- **registry 강제**: `checkComponentsJson`을 config/spawn 이전에 재사용 — custom/private/malformed/symlink/oversized면 runtimeDir·config·spawn 없이 `registry_<code>` 실패.
- **tools/list 검증**: 서버 bare 도구명을 host가 `mcp__shadcn__`로 namespacing → M3c-0 확정 7개와 정확 일치(누락/추가/중복 거부). pagination 지원(nextCursor), 반복 cursor·페이지 상한(8)·64개 초과 거부. 각 도구 name/description/inputSchema 필수, outputSchema·annotations 존재 시 plain object. schema 깊이(16)·객체 키(256)·문자열(8KiB)·도구(64KiB)·snapshot(256KiB) 상한. JSON-RPC version/id 불일치·malformed line·no-init·timeout·non-zero·stdout(1MiB)/stderr(64KiB) 상한 거부.
- **산출물**(`mcp-schema-discovery.json`, mode:`schema-discovery`·usableForHandoff:false): package/server/protocolVersion/serverInfo/tools/configHash/timestamp. raw protocol payload 미저장(추출 schema만), 반환==저장 deepEqual, dir 0700·file 0600·wx, 문자열 deep-scrub(redactNames scrub 전용·child env 미전달). 타입 `ShadcnSchemaResult{schemaDiscovery:true}`로 PreflightSuccess·discovery와 분리.
- **live runner**(`scripts/m3c-live-schema-probe.mjs` 신규): `HARNESS_LIVE_M3C_SCHEMA=1` 없으면 Claude/npx 미호출 exit 2, npm test/CI 비대상. 실제 Claude CLI 미사용 — shadcn MCP stdio 직접 실행. 임시 standard-registry serviceCwd, package/network 경고, signal/finally cleanup·잔존 프로세스(ownership 확인 후 kill) 검사, tools/call 미전송 검증. **이번 작업 미실행.**
- **테스트**(`src/tools/shadcnSchemaProbe.test.ts` 신규, +12): fake stdio MCP fixture로 정상 수집·7개 정확·누락/추가/중복·JSON-RPC version/id·malformed schema·depth·pagination 성공/반복 cursor/page 상한·timeout/non-zero/stdout·stderr 상한·registry 거부(부작용 0)·고정 package·redaction·반환=저장·0700/0600·wx 충돌·**fixture 수신 method에 tools/call 부재**. M3a preflight·M3c-0 discovery 불변.
- 검증: build/tsc noEmit 클린, exec 75 + core 188 + acceptance 71, node --check·opt-in 게이트 exit 2, git diff --check 클린, npm pack entryCount 78(`dist/tools/shadcnSchemaProbe.js` 포함·runner/snapshot/test 제외).
- **미완료(주장 금지)**: 권한 분류·profile 활성화·handoff 연결·result-size enforcement는 **미확정**. 실제 schema는 아직 실측 안 됨(runner 승인 대기). **전체 M3c 미완료.**

## 2026-07-21 (V3 M3c-0 — 실제 live discovery 1회 실행, discovery offline+live 완료)

**M3c-0 discovery offline+live 완료.** 사용자 승인 하에 `HARNESS_LIVE_M3C_DISCOVERY=1 node scripts/m3c-live-discovery.mjs`를 **정확히 1회** 실행. 코드·문서·git 상태는 실행으로 바뀌지 않았다(runner는 임시 경로만 사용·자체 정리).
- **환경/결과**: Claude Code **2.1.216**, package `shadcn@4.13.1`(`npx --yes shadcn@4.13.1 mcp`). runner **exit 0 / discovery OK**. server `shadcn` **connected**.
- **strict 격리·ambient canary**: ambient `.mcp.json` canary 서버는 strict(shadcn 단일) config로 배제 — canary 미기동(pid-file 부재), init 도구 전부 `mcp__shadcn__*` prefix, 서버 목록에 canary 없음. 실행 후 독립 `/bin/ps`에서도 canary·shadcn MCP 프로세스 잔존 없음.
- **검사 통과(exit 0 근거)**: generated mcp-config = 서버 1개(shadcn)·`npx --yes shadcn@4.13.1 mcp`, dir 0700·config/snapshot 0600, snapshot `mode="discovery"`·`usableForHandoff=false`·tools non-empty·raw init 필드 부재, config/snapshot/result에 sentinel 평문 부재, 잔존 프로세스 없음(5초 polling), 임시 디렉터리 cleanup 완료.
- **system/init에서 발견된 실제 MCP 도구 7개(원문 그대로, 권한 분류·browse/search/install/add 추측 매핑 금지)**:
  - `mcp__shadcn__get_add_command_for_items`
  - `mcp__shadcn__get_audit_checklist`
  - `mcp__shadcn__get_item_examples_from_registries`
  - `mcp__shadcn__get_project_registries`
  - `mcp__shadcn__list_items_in_registries`
  - `mcp__shadcn__search_items_in_registries`
  - `mcp__shadcn__view_items_in_registries`
- **미착수(규칙)**: profile 등록·handoff 연결·MCP 도구 호출·권한 등급 분류 없음. **전체 M3c는 미완료.**
- **다음 단계: M3c-1 — `tools/list` schema·semantics 검증 계획**(각 도구의 inputSchema·read/write 성격을 실측·문서로 확정한 뒤에야 권한 매핑·profile 등록으로 진행). 이름만으로 권한을 추정하지 않는다.

## 2026-07-21 (V3 M3c-0 — live runner 런타임 결함 2건 수정, 실제 live discovery 승인 대기)

`scripts/m3c-live-discovery.mjs`만 수정(src/dist 불변). 실제 Claude/npx/network 미실행 — 임시 stub으로만 실측.
- **`sleep` 미정의(ReferenceError) 수정**: 잔존 프로세스 polling의 `await sleep(500)`가 정의 없이 호출되던 것을 inline `const sleep = (ms) => new Promise((r) => setTimeout(r, ms))`로 정의. 잔존 검출 경로에서 ReferenceError 없이 5초 polling 후 FAIL 확인.
- **`LC_*` wildcard 제거**: versionEnv가 모든 `LC_*`를 전달해 `LC_SECRET_TOKEN`/`LC_API_KEY`도 새던 것을 제거. 표준 POSIX LC 카테고리(LC_ALL/LC_CTYPE/LC_MESSAGES/LC_NUMERIC/LC_TIME/LC_COLLATE/LC_MONETARY)만 명시 allowlist.
- **`/bin/ps` 실패 fail-closed**: `matchingShadcnPids`가 실패 시 빈 Map으로 성공 처리하던 것을 `{ok:false,error}`로 변경. baseline ps 실패=discovery 전 exit 2, polling 중 ps 실패=problems 기록·FAIL. 오류는 redact.
- offline 강제 실패-path 실측: 잔존 `shadcn@4.13.1 … mcp` 프로세스 생성 stub → polling 진입·ReferenceError 없음·**exit 1**, 테스트 PID는 ownership 확인 후 정리. LC_SECRET_TOKEN/LC_API_KEY 주입해도 version env dump 부재. 정상 stub exit 0·opt-in 없음 exit 2 유지.
- 검증: node --check·build·npm test(exec 75/core 176/acceptance 71)·tsc noEmit·git diff --check 클린.

## 2026-07-21 (V3 M3c-0 — live runner 최종 보안 보완 완료, 실제 live discovery 승인 대기)

`scripts/m3c-live-discovery.mjs`만 보완(src/dist 불변). 실제 Claude/npx/network 미실행 — 임시 stub으로만 실측.
- `claude --version`을 **allowlist env(PATH/HOME/USER/SHELL/TMPDIR/TMP/TEMP/LANG/LC_*)만** 전달·timeout 10s·maxBuffer 64KiB로 실행(초과/오류 fail-closed). sentinel·ambient TOKEN/KEY/SECRET/PASSWORD/AUTH 미전달. claudeBin 출력도 redact.
- discovery 오류는 **rawMessage로 sentinel 노출 여부 먼저 검사** 후 사용자 출력에만 redact(이전 always-false 버그 정정).
- discovery 전/후 `/bin/ps`로 `shadcn@4.13.1 … mcp` PID 집합 비교(최대 5초 polling) — 이전에 없던 잔존 PID는 **자동 kill 없이** PID/command redact 보고·FAIL. canary PID ownership cleanup 유지.
- offline stub 실측: runner exit 0, version env = allowlist만(sentinel/ambient secret 부재 확인). opt-in 없음 exit 2 유지.
- 검증: node --check·build·npm test(exec 75/core 176/acceptance 71 유지)·tsc noEmit·git diff --check 클린.
- **실제 live discovery는 승인 대기.** 실제 도구명·profile·handoff·result-size enforcement 미확정, M3c 완료 아님.

## 2026-07-21 (V3 M3c-0 — offline hardening, live discovery 미실행)

**M3c-0 offline hardening 완료. live discovery 미실행.** Codex 재현(customRegistryAccepted/emptyToolsAccepted/foreignPinnedPackage + duplicate 도구명 평문 노출)을 반영한 P0/P1 보완. 실제 Claude/npx/shadcn/네트워크 미실행.
- **P0-1 registry 검사를 핵심 API에서 강제**: `runShadcnDiscovery` 시작 직후 `checkComponentsJson(serviceCwd)` — config/runtime/spawn보다 먼저. 실패 시 `registry_<code>` ShadcnDiscoveryError, runtimeDir·mcp-config·discovery snapshot 미생성·spawn 없음. runner 사전 검사는 보조.
- **P0-2 package 고정 우회 제거**: `RunShadcnDiscoveryOpts.package`·`shadcnDiscoveryProfile(pkg)` 인자 제거. production API는 무조건 `SHADCN_PACKAGE="shadcn@4.13.1"`. 다른 exact-pin package도 주입 불가. generic npx pin 검증은 `claudeCodeMcpAdapter` 테스트 유지. shadcnPilot 테스트는 생성 config가 정확히 `npx --yes shadcn@4.13.1 mcp`인지 검증.
- **P0-3 빈 discovery 거부**: system/init에 shadcn MCP 도구 0개면 `no_tools` 실패(성공 1~64개). snapshot 미생성. runner도 tools.length>0 독립 검증.
- **P0-4 전 경로 redaction**: typed ShadcnDiscoveryError를 그대로 rethrow하지 않고 **code 보존 + message scrub**한 새 오류로 정규화(duplicate server/tool·status·spawn/stderr·persistence 공통). 성공 snapshot의 status/tools/package/timestamp도 scrub 후 반환·저장(반환==저장 deepEqual). `redactNames?`(scrub 전용, child env 미전달) 추가. credential 형태·redactNames sentinel 평문 부재 테스트.
- **P1-5 components.json TOCTOU 방지**: `O_NOFOLLOW`로 fd를 열고 같은 fd로 fstat/read(경로 재오픈 없음). ENOENT만 허용, symlink(ELOOP)/non-regular/read error/64KiB 초과 fail-closed, 64KiB+1 byte 초과 미판독.
- **P1-6 stream 출력 상한**: stdout 누적 1MiB(수신 시 byte 검사 후 push → NdjsonParser buffer 무한 증가 방지)·stderr 64KiB 초과 시 child kill + `stdout_too_large`/`stderr_too_large`.
- **P1-7 강제 env 우선순위**: `MCP_CONNECTION_NONBLOCKING`/`ENABLE_TOOL_SEARCH`/`CLAUDE_CODE_DISABLE_AUTO_MEMORY`는 testEnv 병합 후 **마지막에 강제** — testEnv가 덮어쓸 수 없음(테스트로 env 덤프 검증).
- **P1-8 snapshot persistence 정규화**: mkdir/write/wx 충돌도 typed+redacted `persist` 오류로 반환. 기존 mcp-discovery.json·symlink는 `wx`로 덮어쓰지 않고 부분 성공 미반환.
- **P1-9 live runner 강화**: 동일 `HARNESS_CLAUDE_BIN` `claude --version` 검증·기록(실패 시 미실행), generated mcp-config가 서버 1개(shadcn)·`npx --yes shadcn@4.13.1 mcp` 검사, canary config/snapshot 부재, dir 0700·config/snapshot 0600, snapshot mode/usableForHandoff=false/tools non-empty·raw init 부재, random sentinel parent-only(config/snapshot/result/error 평문 부재·child 미전달), 출력은 scrub된 snapshot 값만. **이번 작업 미실행.**
- 검증: build/tsc noEmit 클린, exec 75 + core 176 + acceptance 71, node --check·opt-in 게이트 exit 2, git diff --check 클린.
- **실제 도구명·profile·handoff·result-size enforcement는 여전히 미확정.** M3c 완료 아님.

## 2026-07-20 (V3 M3c-0 — shadcn MCP discovery scaffold, offline)

**M3c discovery scaffold offline 완료. 실제 discovery 및 profile 활성화는 미완료(미실행).** 실제 Claude/npx/shadcn/네트워크·MCP 도구 호출은 하지 않았다. registry 미등록·handoff 미연결.
- **shadcn 파일럿 정책**(`src/tools/shadcnPilot.ts` 신규): `SHADCN_PACKAGE="shadcn@4.13.1"`(고정 pin), 실행 선언 `npx --yes shadcn@4.13.1 mcp`, server=`shadcn`, secretRefs=[]. `shadcnDiscoveryProfile(pkg)` — in-code profile(bindings.component_registry_read=mcp, **tools=[]** 발견 대상). `@latest`/무버전/범위는 기존 `buildMcpConfig`(compileServer) 규칙대로 거부.
- **표준 registry 검사** `checkComponentsJson(serviceCwd)`: 파일 없음→허용, registries 없음/빈 plain object→허용, 항목 있음/plain object 아님→`custom_registry_forbidden`, malformed·root 비객체·symlink·일반 파일 아님·64KiB 초과→fail-closed(코드만, 파일 내용·credential·env secret 미포함).
- **전용 MCP discovery** `runShadcnDiscovery(...)`: runPreflight의 exact-profile 검증을 **완화하지 않고 별도 API**로 구현. 단일 shadcn 서버 strict config, headless `claude -p --output-format stream-json --strict-mcp-config --setting-sources "" --mcp-config <gen> --tools "" --permission-mode plan`(env MCP_CONNECTION_NONBLOCKING=0·ENABLE_TOOL_SEARCH=false·auto-memory 차단), system/init에서 실제 도구명 수집. 서버 정확 `["shadcn"]`+connected 필수, 다른 서버/다른 prefix 도구·중복·빈이름·malformed·non-zero·no-init·timeout(기본 60s) 거부. 도구 ≤64개·각 ≤256B·snapshot ≤64KiB. raw init 미저장, 오류·반환 redaction.
- **discovery 산출물 분리**: `mcp-discovery.json`(mode:"discovery"·usableForHandoff:false·package·server·status·tools·configHash·timestamp, dir700/file600/wx). 타입 `ShadcnDiscoveryResult{discovery:true}`·`ShadcnDiscoveryError`로 `PreflightSuccess{ok:true}`와 분리 → 정상 preflight·handoff 승인 근거로 사용 불가.
- **수동 live discovery runner**(`scripts/m3c-live-discovery.mjs` 신규): `HARNESS_LIVE_M3C_DISCOVERY=1` 없으면 exit 2(Claude/npx 미호출), npm test/CI 비대상, package download·네트워크·구독 사용량 명시, 임시 serviceCwd·components.json(registries:{})·ambient .mcp.json canary(strict 격리 확인), 실제 도구명 출력·snapshot, 도구 호출·interactive TUI 미실행, signal/finally cleanup + canary PID ownership(`/bin/ps`) 검사. **이번 작업에서 실제 실행하지 않음.**
- **테스트**(`src/tools/shadcnPilot.test.ts` 신규, +21): components.json 없음/없는 registries/빈 객체 허용, custom/private/third-party·배열 registries 거부, malformed/symlink/oversized/non-regular 거부, 정확한 shadcn@4.13.1 pin·비pin 거부, discovery 성공(generic fixture)·PreflightSuccess와 분리, extra server/foreign tool/duplicate/empty/too-long/too-many/not-connected/no-init/non-zero/timeout 거부, 산출물 권한·raw init 미저장·오류 redaction, registry/tool_profiles.json 불변. 일반 runPreflight·handoff argv·M3b.2 테스트 불변(코드 미수정).
- 검증(하드닝 후): build/tsc noEmit 클린, exec 75 + core 176 + acceptance 71, node --check·opt-in 게이트 exit 2, git diff --check 클린.
- **실제 shadcn 도구명(browse/search/install/add 등)은 아직 미확인** — 위 runner를 사람이 실행해야 발견된다. **다음: M3c 파일럿 계획 검토(실제 discovery 실행 → 도구명 확정 → profile 등록·handoff 연결).**

## 2026-07-20 (V3 M3b.2 — offline + actual live acceptance 완료, PASS)

**M3b.2 interactive handoff가 실제 Claude Code 2.1.215에서 live acceptance PASS(runner exit 0)로 완료됐다.** 앞선 argv P0(1차 무효)·planning 경로 P0-1·sentinel 출력 P0-2를 모두 수정한 뒤의 재검증 결과다(아래 실패 시도들은 역사 기록으로 유지).
- **runner**: `scripts/m3b2-live-handoff.mjs`(`HARNESS_LIVE_M3B2=1`, TTY 필수). 최종 exit 0 / PASS. 임시 `m3b2-live-*` 디렉터리 정리 완료.
- **실측 통과 범위(Claude Code 2.1.215)**:
  - exact Hook 6종 등록(exec form: SessionStart/PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/PermissionDenied·SessionEnd 계약 — hooks 키 집합·matcher1·handler1·args2 정확 일치).
  - empty MCP preflight snapshot `servers=[]`/`tools=[]` + mcp-config `mcpServers={}`.
  - planning contextRoot 접근(`--add-dir <contextRoot>`): 00_IDEA.md·06_CEO_DECISION.md를 contextRoot 절대경로로 Read 성공. serviceCwd에 docs/ 나 docs/WORKLOG.md 미생성(P0-1 해소 확인).
  - Read 성공/실패 callId correlation(tool_requested ↔ tool_succeeded / tool_failed 동일 callId).
  - Bash 승인: permission_requested(Bash, callId=null 별도) + tool_requested/succeeded(동일 callId). 비출력 sentinel 존재 검사(`node -e …`)로 값 미출력(P0-2 해소 확인).
  - Write 수동 거부: tool_requested + permission_requested 기록, rejectMarker 파일 부재·해당 경로 tool_succeeded 부재. tool_denied로 합성·연결하지 않음.
  - SessionEnd: session_end 정확 1건(callId/toolName=null).
  - ambient MCP canary(.mcp.json)·Hook canary(SessionStart+PreToolUse) 모두 미기동(strict MCP + `--setting-sources ""` 격리 확인).
  - trace redaction·권한(dir700/file600)·원문 미저장(transcript_path/raw tool_response 부재)·sentinel/credential 평문 부재, run_state.handoff 기록·completed 상태 불변, 대화형 argv에 `-p`/stream-json 없음(`--` 꼬리).
- **결론**: M3b.2 offline + actual live 완료. **다음 단계는 M3c(shadcn read) 파일럿 계획 검토**(구현 아님).

## 2026-07-20 (V3 M3b.2 — 두 번째 live에서 P0 2건 발견 + 수정, 전체 PASS 아님)

**두 번째 live acceptance는 전체 PASS가 아니다.** argv P0(`--`)는 통과했으나 아래 P0 2건이 새로 드러났다. 실제 Claude/TUI는 재실행하지 않고 수정·offline 검증만 했다.
- **통과 범위(2차 live)**: argv `--` 꼬리로 초기 프롬프트가 정상 전달됨(1차 무효 원인 해소). 대화형 세션이 실제로 열렸고 절차 입력이 가능했다.
- **P0-1 planning context 경로 단절**: task prompt의 `Include`는 `docs/*.md` 상대경로인데 대화형 cwd는 serviceCwd고 실제 planning 문서는 `projectPaths(project).root/docs`에 있다. live에서 Claude가 "docs 디렉터리가 없다"고 보고하고 serviceCwd 아래 잘못된 `docs/WORKLOG.md`를 만들었다.
  - 수정(`src/core/handoff.ts`): `contextRoot = projectPaths(project).root` 명시 → argv에 `--add-dir <contextRoot>` 추가 → initialPrompt에 경로 계약(Include의 docs/…는 contextRoot 절대경로, serviceCwd/contextRoot 별개, WORKLOG 대상 = contextRoot/docs/WORKLOG.md, serviceCwd에 docs 생성 금지) 명시 → 승인 preview에 serviceCwd·contextRoot 별도 표시 → 128KB fallback도 contextRoot 접근으로 읽힘. `--disallowedTools mcp__* -- <initialPrompt>` 꼬리 유지.
- **P0-2 sentinel TUI 평문 출력**: Bash 검증 명령이 `printf '%s' "$M3B2_LIVE_TOKEN"`이라 fake sentinel **값**이 TUI에 출력됐다. (실제 credential이 아니라 runner가 심은 fake sentinel이지만, "외부 미출력" 주장과 모순.)
  - 수정(`scripts/m3b2-live-handoff.mjs`): 값을 출력하지 않는 존재 검사 `node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'`로 변경. task prompt·안내·trace 판정을 새 명령에 맞춤. 실제 sentinel 값은 terminal/settings/config/snapshot/trace/outcome에 출력하지 않는다. collector redaction 단위 테스트는 유지.
- **테스트**(`src/core/handoff.test.ts`): 성공 테스트에 `--add-dir=contextRoot`·prompt 절대 contextRoot·WORKLOG 절대경로·경로 계약 문구 검증 추가. 전용 P0-1 테스트(serviceCwd≠contextRoot fixture, `--add-dir` 정확, `--` 꼬리 회귀 없음, serviceCwd에 docs/WORKLOG 미생성) 신규. 128KB fallback 테스트에 경로 계약·`--add-dir`·`--` 검증 추가. 기존 테스트 삭제·완화 없음.
- **runner 보강**: `--add-dir`=contextRoot 검사, planning 문서(00_IDEA/06_CEO_DECISION) Read 성공 trace 검증, serviceCwd/docs/WORKLOG.md 생성 시 실패, Write 단계 안내에 "기본 Yes에서 Enter 금지·방향키로 No·재시도 금지" 명시, permission mode default/manual 유지, manual deny는 marker 부재+tool_succeeded 부재로만 판정.
- **상태: M3b.2 live 재검증 대기**(전체 PASS 아님). fake sentinel이 출력됐으나 **실제 credential은 아니었다**. 수정 후 사람이 runner를 재실행해야 Hook 검증이 성립한다.
- 검증: build/tsc noEmit 클린, exec 75 + core 159 + acceptance 71, node --check·opt-in/non-TTY 게이트 exit 2.

## 2026-07-20 (V3 M3b.2 — 첫 live 시도 무효(argv P0) + 수정)

**첫 live acceptance 시도는 argv 파싱 오류로 무효였고, 실제 Hook 검증은 수행되지 않았다.** 실제 Claude/TUI는 재실행하지 않았다.
- **원인(P0)**: `src/core/handoff.ts`의 대화형 spawn argv 꼬리가 `--disallowedTools`, `mcp__*`, `initialPrompt` 순서였다. `--disallowedTools <tools...>`는 **가변 인자**라, 옵션 종료 구분자 `--` 없이 뒤에 붙은 initialPrompt(및 그 안의 모든 단어)를 deny 규칙으로 소비했다. Claude Code 2.1.215 실측에서 초기 프롬프트의 모든 단어가 `Permission deny rule "..." matches no known tool` 경고로 출력됨 → 세션이 acceptance 절차를 받지 못해 **무효**.
- **수정**: 꼬리를 `--disallowedTools`, `mcp__*`, `--`, `initialPrompt`로 변경(옵션 파싱 종료 후 프롬프트를 순수 positional로 전달). 대화형 TUI·`stdio:"inherit"`·`-p`/stream-json 미사용 계약 불변.
- **회귀 테스트**(`src/core/handoff.test.ts`): 기존 성공 테스트에 `argv.at(-2)==="--"`·마지막 인자=initialPrompt·`--disallowedTools` 값이 `mcp__*` 하나이고 그 뒤 `--`로 종료 검증 추가. 전용 P0 회귀 테스트(`[M3b.2][P0] interactive argv 꼬리 …`) 신규: 꼬리 4개 순서(`--disallowedTools`·`mcp__*`·`--`·prompt), `--` 정확히 1개, prompt가 deny 값 영역 밖. 기존 테스트 삭제·완화 없음.
- **runner**(`scripts/m3b2-live-handoff.mjs`): 사후 argv 검증에 `argv.at(-2)==="--"`, `--disallowedTools mcp__* -- <prompt>` 구조, 마지막 인자가 이번 실행 고유 live acceptance 지시(readOk 경로/‘live acceptance’) 포함을 추가. 실제 Claude/TUI 미실행.
- **상태**: **M3b.2 live acceptance 재실행 대기**(PASS 아님). 첫 시도 무효 → 수정 후 사람이 재실행해야 실제 Hook 검증이 이뤄진다.
- 검증: build/tsc noEmit 클린, exec 75 + core 158 + acceptance 71 통과(argv P0 회귀: 기존 성공 테스트 강화 + 전용 P0 테스트 1개 신규), node --check·opt-in/non-TTY 게이트 exit 2.

## 2026-07-20 (V3 M3b.2 — offline 최종 보완)

여전히 실제 Claude/TUI/live Hook은 실행하지 않는다(offline seam). 승인 preview·collector 검증 fail-closed 보강.
- **승인 preview 전체 redaction**(`src/core/handoff.ts` `buildPreview`): 기존엔 task prompt head만 scrub했으나, cwd·trace 등 **모든 동적 문자열**이 secret 값을 담을 수 있으므로 조립한 최종 preview 전체를 scrub한다. 승인 화면에 secret 평문이 노출되지 않는다.
- **collector 검증 예외 정규화**: collector stat/readability 검증 전체를 try/catch로 감싼다. 파일 부재·디렉터리·stat/access 오류 모두 예외 throw 없이 scrub된 `setup_failed`로 정규화(preflight/spawn/handoff 기록 없음). production 기본 경로는 `PACKAGE_ROOT/dist/tools/hookCollector.js` 유지, 테스트용 `collectorPath` seam 추가. 일반 파일이며 읽을 수 있을 때만 통과.
- **테스트 정합성**: 기존 "collector 산출물 부재(exclusive-create 충돌)" 테스트를 실제 의미대로 "trace 파일 exclusive-create(wx) 충돌"로 이름 변경. collector 경로 부재·디렉터리 두 `setup_failed` 테스트 추가(각각 preflight/spawn/handoff 기록 없음·runtime 미생성 검증). 승인 preview 전체 scrub 테스트 추가(cwd에 secret sentinel 심어도 preview 평문 없음 + 거부 시 기록 없음). command wrapper의 `setup_failed`→exitCode=1 동작 유지.
- 검증: exec 75 + core 157 + acceptance 71 전부 통과. build/tsc noEmit/diff --check 클린.

## 2026-07-19 (V3 M3b.2 — Interactive handoff, offline)

문서 완료 → Claude Code 대화형(TUI) 핸드오프. 실제 Claude/TUI/live Hook은 실행하지 않는다(seam 주입).
- **handoff 코어**(`src/core/handoff.ts` 신규): `runHandoff` — 결정 시퀀스를 명시적 outcome union으로 반환한다.
  print → completed 확인 → summary/task-prompt 자동 갱신 → initialPrompt(128KB 초과 시 절대경로 읽기 지시로 대체) →
  missing binary(설치+재진입 안내) → non-TTY 차단 → **collector fail-closed 검증(setup_failed)** → 승인 게이트(preview) → **fail-closed preflight(빈 MCP config)** → Hook settings·trace 준비 → spawn.
  **부작용 경계**: completed 확인 이후 summary/task-prompt 갱신은 outcome과 무관하게 수행(문서 갱신 자체는 handoff 결정과 독립). 그러나 runtime 산출물 write·run_state.handoff 기록·interactive spawn은 **spawned 경로에서만** 발생하고, print/reject/setup_failed/non_tty/missing_binary/preflight_failed/spawn_failed는 이들을 남기지 않는다.
- **명령/CLI**: `harness handoff --project <p> [--cwd <serviceRepo>] [--print] [--yes]`(`src/commands/handoff.ts` 신규),
  `harness run ... --handoff [--cwd]`(run이 completed일 때만). `src/cli.ts`·`src/commands/run.ts` 배선.
- **대화형 격리 spawn argv**(현재 구현): `--strict-mcp-config --mcp-config <runtime/mcp-config.json> --settings <runtime/hook-settings.json>
  --setting-sources "" --add-dir <contextRoot> --permission-mode default --tools default --disallowedTools mcp__* -- <initialPrompt>`. 가변 인자 `--disallowedTools`가 프롬프트를 deny 값으로 소비하지 않도록 `--`로 옵션 파싱을 종료하고 initialPrompt를 positional로 전달한다(`--`는 2026-07-20 argv P0 수정으로 추가). `--add-dir <contextRoot>`는 planning 문서(docs/*.md) 접근용(2026-07-20 P0-1 수정으로 추가). **`-p`/stream-json 없음, `stdio:"inherit"`.**
  env: `HARNESS_TOOL_*`(이름만) + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- **fail-closed preflight 보강**(`src/tools/preflight.ts`): `--setting-sources ""` argv + child env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
  `emptyConfig` allow-empty 경로(expected 서버/도구=[], ambient 하나라도 보이면 차단). 기존 profile `no_mcp_binding` 거부·M3a 의미 불변.
- **allow-empty config**(`src/providers/claudeCodeMcpAdapter.ts`): `buildEmptyMcpConfig`/`writeEmptyMcpConfig`(dir 0700/file 0600). 기존 buildMcpConfig 불변.
- **Hook settings 공식 exec form**(`src/tools/hookSettings.ts`): shell 문자열 조합 → `command`=node 실행 파일, `args`=[collectorPath, hookKind(, "deny")].
  collector는 배포 가능한 `dist/tools/hookCollector.js` 절대경로. settings에 secret 값 없음. `shellQuote`는 handoff 재진입 명령용으로 유지.
- **run_state.handoff**(optional): `{launched_at, cwd, prompt_bytes, trace_path, runtime_dir}` — **interactive child가 실제 spawn된 경우에만** 기록.
  print/reject/preflight 실패/spawn 실패/non-TTY/missing binary에서는 미기록. 종료코드·completed 상태 불변.
- **산출물**: `projects/<p>/outputs/runtime/<handoff-id>/{mcp-config.json,hook-settings.json}` + `outputs/tool-trace/<handoff-id>.jsonl`(gitignore 추가). raw payload/transcript 미저장.
- **P0/P1 보완**:
  - **collector 경로 P0**: import.meta.url 상대 계산 제거 → 항상 `PACKAGE_ROOT/dist/tools/hookCollector.js`(dev tsx·prod 동일). spawn/preflight 전 존재·일반 파일 검증, 없으면 `setup_failed`(build 안내).
  - **파일 권한 P0**: ToolTrace JSONL을 spawn 전 빈 0600 파일로 사전 생성(collector append 후에도 0600 유지). hook-settings/mcp-config/tools-snapshot 실제 stat 0600, runtime/trace dir 0700. 기존 파일·symlink는 exclusive-create(`wx`)로 fail-closed. 기본 handoff id는 `randomUUID` 포함(테스트 seam 유지).
  - **secret/redaction**: `process.env`에서 이름이 TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL/AUTH 형태이고 값이 있는 항목의 **이름만** redaction refs로 파생 → `HARNESS_TOOL_SECRET_REFS`(이름만)·collector 값 마스킹. preflight엔 `redactNames`(scrub 전용, child env 미전달) 추가. spawn/setup/preflight 오류·로그·outcome을 `redactSecrets` 처리.
  - **setting-sources 보완**: `--setting-sources ""`로 서비스 레포 CLAUDE.md 자동 로드 안 되므로 initialPrompt에 "AGENTS.md·CLAUDE.md 존재 시 먼저 읽고 준수" 명시. managed policy 우회는 계속 금지.
- **테스트**: `src/core/handoff.test.ts`(13) + `src/commands/handoff.test.ts`(4, `run --handoff` completed/failed stub 포함) + preflight(emptyConfig·setting-sources·env·mode·redactNames) + hookSettings exec form. sentinel 평문 부재: settings·generated env·preflight 오류·spawn 오류·실제 collector append JSONL. `test:core`에 `src/commands/*.test.ts` 추가. acceptance Test 12(handoff).
- 검증: exec 75 + core 154 + acceptance 71 전부 통과. build/tsc noEmit/diff --check 클린.
- **`runHandoff`는 명시적 outcome union 반환**(printed/not_completed/missing_binary/non_tty/rejected/setup_failed/preflight_failed/spawn_failed/spawned). 산출물 write·run_state 기록은 spawned 경로에서만.
- **남은 M3b.2 live acceptance**: 실제 Claude Hook 수동 검증(`--setting-sources ""` 수용, exec-form Hook 6종 등록, 6 payload, trace redaction·0600, TUI 유지·stream-json 미사용). **M3c(shadcn read)는 live 통과 후.**

## 2026-07-19 (V3 M3b.1 — Interactive HookTrace 기반, offline)

Hook payload→공통 ToolTrace JSONL 변환 기반. 실제 Claude/TUI/handoff/stream-json 미실행·미구현(M3b.2).
- **ToolTrace 모델**(`src/tools/toolTrace.ts` 신규): 6 이벤트(tool_requested/permission_requested/tool_succeeded/tool_failed/tool_denied/session_end) + 필수 필드(version/timestamp/source/profileId/sessionId/callId/event/status/toolName/server/durationMs/resultBytes/sanitizedInput/inputTruncated/error/reason/denialMode/sessionEndReason). `normalizeHook`(6 Hook 정규화) + `toRunEvent` 매핑(tool_start/tool_end/tool_denied; permission_requested·session_end→없음). **RunEvent reporter 실시간 emit 안 함**.
- **collector**(`src/tools/hookCollector.ts` 신규): stdin payload→정규화→JSONL. PreToolUse deny→tool_denied+exit2, PreToolUse audit 기록 실패→exit2(차단), 사후 Hook 실패→exit1(경고), 정상 stdout 미사용. env 계약 `HARNESS_TOOL_TRACE_PATH/PROFILE_ID/SECRET_REFS(이름 JSON)/MAP(exact)`.
- **settings**(`src/tools/hookSettings.ts` 신규): 6 Hook 정확 등록 + deny matcher 선택. argv/env에 secret **이름만**.
- **trace.ts 강화**: `sanitizeValue` — 민감 key(authorization/cookie/token/key/secret/password/credential) 재귀 마스킹 + secret 값/credential 패턴(URL query 포함). 병렬 append 라인 원자성 주석.
- **규칙**: transcript_path·raw tool_response 미저장(byte 수만), 입력/오류 크기 상한, MCP server는 exact tool map으로만 판정(추측 금지), secretRefs 실제 환경값 redaction.
- **승인 의미(한계 명시)**: PermissionRequest는 permission_requested만, PermissionDenied는 auto-mode denial만. PermissionRequest 공식 payload에는 correlation ID(tool_use_id)가 없어 callId=null·synthetic ID 미생성, `permissionOutcomeObservable:false`로 수동 승인/거부 관측 불가 명시. SessionEnd는 종료 사실만 기록(unresolved·승인 결과 추측 금지). 타입·테스트·문서 반영.
- **테스트**(+24): 각 Hook 정규화, 민감 key/secret/URL query/중첩 배열 redaction, 크기 상한, malformed/oversized stdin, deny exit2, 승인 오판 금지, PermissionDenied auto 의미, 병렬 collector append 유효성, settings 6 Hook·secret 평문 부재, 기존 trace/RunEvent 회귀 없음.
- **P0/P1 하드닝**: collector fail-closed(`parseConfig` 엄격 검증·JSON fallback 금지, PreToolUse/PermissionRequest 실패 exit2·사후 exit1, 전 경로 catch, stack/raw env/secret 미출력), payload 계약 검증(hook_event_name 일치·session_id 필수, PermissionRequest=tool_name+tool_input 필수·tool_use_id 없음, tool hook=tool_use_id 필수, deny는 PreToolUse만), **SessionEnd는 종료 사실만 기록**(공식 payload에 correlation ID 부재로 unresolved·승인 결과 추측 금지), UTF-8 byte 상한(멀티바이트 경계 보존)·재귀 depth 상한, settings `nodePath/collectorPath` shell-safe quoting + `denyMatchers[]` dedupe.
- 검증: exec 75 + core 131 + acceptance 63 전부 통과.
- **남은 M3b.2**: handoff command/spawn, settings 파일 write·claude 실행, 실제 Claude Hook 이름 대응 실측. 대화형은 `stdio:inherit`+Hooks만(stream-json은 M3a preflight 전용, 대화형 미사용). `toRunEvent`는 post-session/테스트용(실시간 emit 없음).

## 2026-07-19 (V3 M3a — live acceptance 실측 PASS)

수동 live runner(`scripts/m3a-live-preflight.mjs`, `HARNESS_LIVE_M3A=1` 필수)로 실제 Claude 1회 실측.
- **환경**: Claude Code **2.1.215**. headless preflight(`claude -p --output-format stream-json --strict-mcp-config ...`), interactive 미실행.
- **결과 (PASS, exit 0)**:
  - `system/init` expected server `connected`.
  - 도구 `mcp__expected__read_thing` **정확 일치**(누락·추가·중복 없음).
  - 임시 service cwd의 ambient `.mcp.json` canary 서버/도구 **미기동**(strict-mcp-config 격리 확인, canary pid-file 부재).
  - sentinel(전용 env + cwd 경로)·config·반환/저장 snapshot **redaction 통과**(cwd `svc-***`, 평문 노출 0).
  - expected fixture 5초 내 종료, fixture·임시 디렉터리 **잔존 없음**.
- **범위**: 이 결과는 **Claude Code 2.1.215 실측**이며, CLI 버전 변경 시 재검증 필요(플래그·`system/init` 스키마·strict 격리 동작이 버전 의존).
- runner/fixture는 수동 live acceptance 전용(CI·자동 파이프라인 비대상). flaky 완화로 offline preflight 테스트 기본 timeout 1500→5000ms(hard-timeout 전용 700ms 유지).
- 다음: **M3b 계획 검토**.

## 2026-07-19 (V3 M3a — live 전 보안 보완)

실제 claude 미실행. M3a offline 위에 보안 5건 강화.
- **npx 고정 버전 검증**: npx 실행 package는 정확한 `pkg@X.Y.Z`(scoped 포함)만 허용. `package`/`@next`/`@^`/`@~`/`@*`/`@1`/`@1.2` → `unpinned_npx`, `@latest` → `latest_forbidden`(유지). 절대경로 npx 동일 적용. 일반 node/local executable엔 pin 규칙 미적용.
- **config 검증 강화**: 중복 파생 `mcp__server__tool` 거부(dedupe 금지, `duplicate_tool`), transport는 stdio/http만(`bad_transport`), 혼합(stdio+url / http+command) 거부(`mixed_transport`), secretRefs 실제 값이 command/args/url에 있으면 기록 전 거부(`secret_in_config`, 값 미노출), credential 형태 URL query/arg 거부(`credential_in_config`).
- **preflight env 격리**: `process.env` 전체 전달 폐지 → allowlist(PATH/HOME/USER/SHELL/TMPDIR/LANG 등) + `profile.secretRefs` 선언분만 + `MCP_CONNECTION_NONBLOCKING=0`·`ENABLE_TOOL_SEARCH=false` 강제. 스텁 통신은 production allowlist와 분리된 명시적 `testEnv` seam으로만. 미선언 token/key/secret/password 형태 변수 미전달 테스트 추가.
- **snapshot redaction 정합**: 반환 `PreflightSuccess.snapshot`도 redacted(저장 파일과 동일). 실패 시 tools-snapshot.json 미생성 테스트 추가.
- **타입 정합성**: init을 직접 만드는 exec 테스트 fixture 9곳에 `mcpServers: []` 추가.
- 검증: exec 75 + core 94(+20) + acceptance 63 전부 통과.

## 2026-07-19 (V3 M3a — Headless MCP preflight, offline)

실제 claude 미실행, stub 기반 offline acceptance까지. M3b(Hook/TUI)·M3c(shadcn) 미구현.
- **system/init 파서 확장**: `types.ts`에 `McpServerStatus{name,status,connected}` + init 이벤트에 `mcpServers` 추가. `streamParser.ts`가 `mcp_servers` 정규화(connected는 status==="connected"만; pending/failed/needs-auth는 false). 기존 exec/mockExecProvider init에 `mcpServers:[]` 보강. raw는 SessionEvent에만, snapshot 미저장.
- **MCP config 생성**(`src/providers/claudeCodeMcpAdapter.ts` 신규): profile MCP binding·servers 검증 → `buildMcpConfig`/`writeMcpConfig`. binding server가 servers에 없음/중복 거부, stdio=command 필수·http=HTTPS url 필수, `@latest` 거부, 참조된 서버만 포함, 각 서버 `alwaysLoad:true`, secret 값 미기록, runtime에 mcp-config.json + SHA-256. `.gitignore`에 `projects/*/outputs/runtime/`.
- **Headless preflight**(`src/tools/preflight.ts` 신규): `HARNESS_CLAUDE_BIN` 호출시점 읽기. argv `-p/--output-format stream-json/--verbose/--no-session-persistence/--strict-mcp-config/--mcp-config/--tools ""/--permission-mode plan`, cwd=서비스경로, env `MCP_CONNECTION_NONBLOCKING=0`·`ENABLE_TOOL_SEARCH=false`, hard timeout, TUI 미실행. init 수집 후 의도적 종료(실패 오판 안 함).
- **Snapshot 검증**(fail-closed): expected 서버명 정확 비교 + 전부 connected, binding 파생 mcp 도구명 정확 비교. 누락·추가(canary)·중복 → typed `PreflightError`. 성공 시 tools-snapshot.json에 `profileId/cwd/timestamp/configHash/servers(status)/정렬 tools`만 저장, 오류·snapshot redaction. 실패 시 성공 result 미반환.
- **테스트**(+23): streamParser mcpServers 정규화, adapter 검증 9, preflight offline 13(exact 성공·canary server/tool·missing/duplicate tool·pending/failed/needs-auth·no-init/malformed/non-zero/timeout·argv strict/config/tools-empty/plan·@latest·snapshot secret redaction). 기존 stream parser 테스트 회귀 없음.
- 검증: exec 75 + core 74 + acceptance 63 전부 통과. M2.1 MCP fail-closed 유지(preflight는 별도 경로).
- **live 전 남음**: 실제 claude 구독 호출로 argv·`system/init`·strict 격리·canary 실측, alwaysLoad/env 강제의 실제 동작 확인.

## 2026-07-19 (V3 M2.1 — P0 보완: 정책 전달 배선 + secret redaction + MCP fail-closed)

M3 이전 선행 보완 3건. M3a/b/c·MCP config 생성·stream-json·Hook·shadcn 미구현.
- **정책 실제 전달**: `ProviderExecContext{claudeArgs, redactNames}`(`provider.ts`). runWorkflow가 compile된 policy를 보존 → runAgent → `provider.generate(input.execContext)`. claudeCodeProvider가 `execContext.claudeArgs`를 실제 spawn argv에 병합. mock/anthropic 무시, 미지정 시 argv·경로 완전 불변(회귀 테스트).
- **MCP fail-closed**: `hasMcpBinding(profile)`(`profiles.ts`). runWorkflow가 MCP binding profile을 run_start·run_state 이전에 거부(M3 preflight/snapshot 이후 사용). loader/compile은 거부 안 함(M3가 로드 가능). 테스트용 `toolProfilesPath` seam 추가.
- **secret redaction**: invalid secretRef 오류가 값 대신 index만 출력(`redact.ts`). secret 값은 execContext로 전달 안 함 — 이름(redactNames)만 넘기고 claudeCodeProvider가 내부에서 `collectSecretValues` 조회. spawn/non-zero 오류의 stderr/stdout을 `redactSecrets` 통과(이름 없어도 Authorization/token/password 패턴 적용). `HARNESS_CLAUDE_BIN`/timeout 호출 시점 읽기로 전환(스텁 테스트 가능).
- **JSONL writer**: `createJsonlWriter(path, {redact, redactValues})` — record의 모든 문자열 재귀 sanitize 후 stringify, 원본 record 불변. 기존 호출 호환(기본 raw). M3 ToolTrace 스키마·Hook 미배선.
- **테스트**(+11): 실제 spawn argv 포함/미지정 회귀(스텁), 오류 redaction, invalid secretRef sentinel 부재, JSONL 중첩·배열 redaction+원본 불변, MCP run-level 거부(loader/compile 성공), golden snapshot 유지.
- 검증: exec 74 + core 52 + acceptance 63 전부 통과.

## 2026-07-17 (V3 M2 — Capability/ToolProfile 정책 계층)

types+loader+compile+fail-fast+redaction+`--bare` argv. 실 MCP/shadcn/Tavily/stream-json/Hooks/Research Adapter 미구현.
- **Capability 3계층**(`src/tools/capabilities.ts`): active(7)/reserved/deny. `repo_write_direct` 제거 → reserved(`local_workspace_write`,`pull_request_create`) / deny(`remote_repository_write`,`pull_request_merge`,`production_deploy`,`billing_live`,`design_write`) 분리.
- **ToolBinding 4종**: builtin{tools[]}/internal_adapter{adapter,operations[]}/mcp{server,tools[]}/cli{command,operations?}. profile만 보고 실행 주체 판별.
- **ToolProfile + loader**(`src/tools/profiles.ts`): `bindings` 필드 추가. `exposedTools`는 입력이 아니라 compile이 bindings에서 파생(builtin ∪ mcp__server__tool). 수동 구조+시맨틱 validator(신규 런타임 의존성 0). deny/reserved/unknown capability·binding 누락·orphan·preapproved⊄exposed·exposed∩denied·secretRef 값형태 → 로드 거부.
- **compileToolProfile**: profile→CLI 플래그(exposed내장=`--tools`, preapproved=`--allowedTools`, denied=`--disallowedTools`, permissionMode=`--permission-mode`, bare=`--strict-mcp-config`)/생성 mcp-config/내부 어댑터·Hook 정책/redact 목록 4버킷. 인자 조건부 deny=PreToolUse Hook(산출만).
- **Binding 기반 fail-fast**(`assertPolicyExecutable`): builtin→provider 내장도구, mcp→provider MCP, internal_adapter→Adapter Registry(`src/tools/adapters.ts`, M2 빈 목록), cli→실행 환경. `runWorkflow` 최상단(run_start·run_state 이전)에서 `--tool-profile` 지정 시 검증. `assertProviderSupports` 폐기.
- **ProviderCapabilities**(`src/providers/capabilities.ts`): mock/claude-code/anthropic 능력 테이블.
- **secret**: `src/tools/redact.ts` — secretRef 이름 형식 검증 + Authorization/key= 패턴 redaction.
- **Planning `--bare`**: `claudeCodeProvider.buildClaudeArgs` 추출(정책 args 병합, 기본 동작 보존). 일반 문서=`--tools ""`, 로컬읽기=`--tools "Read,Glob,Grep"`+`--permission-mode plan`, strict empty fallback=`--mcp-config <path>`. argv 생성·검증까지(snapshot fallback 판정은 M3).
- **registry**: `registry/tool_profiles.json`에 `planning-none`, `planning-local-readonly`만. Tavily/shadcn은 실행기 붙는 M3·M4까지 미등록. `schemas/tool_profile.schema.json`(계약 문서, 런타임 미실행). `package.json.files`에 `schemas` 추가.
- **테스트**: `tests/fixtures/tool-profiles/`(배포 제외) + `src/tools/{capabilities,redact,profiles}.test.ts`, `src/providers/claudeCodeBare.test.ts`, `src/core/toolProfile.test.ts`(run fail-fast + **golden snapshot 회귀**: 가변 메타 제거 후 비교).
- **M1 영향 없음**: RunEvent/step_timings/trace 골격·RunState 무변경. profile 미지정 시 전 경로 no-op → mock 출력 불변(golden 확인).
- 검증: exec 74 + core 37 + acceptance 63 전부 통과.
- **다음 M3**: handoff + shadcn read + stream-json 파싱(tool 이벤트 실 방출·trace 배선) + mcp-config write·claude 전달 + `system/init` snapshot 격리 실측.

## 2026-07-17 (V3 M1 — 진행 이벤트 모델 + tool 이벤트 골격 + JSONL trace 골격)

F2(진행 가시성) + MCP M1(tool 이벤트 타입/trace 골격). 실 MCP/ToolProfile/stream-json/Hooks/Tavily/shadcn 미구현.
- **RunEvent/ProgressReporter 이벤트 모델**(`src/core/progress.ts` 신규): run_start/step_start/step_end/gate_jump/run_end + tool_start/tool_end/tool_denied(타입 골격, 방출 없음) + note{level}. 기존 `start/note/stop` 인터페이스를 이벤트 모델로 교체.
- **runWorkflow 배선**: 모든 top-level step(agent/critic/revise/spawn/gate/approval)에 step_start/step_end. index 1-based, total=top-level step 수. critique 내부는 kind(critic/revise)+round로 구분. 실제 jump일 때만 gate_jump. run_start에 resumeFrom. **run_start→…→run_end를 try/finally로 감싸 예외에도 step_end{ok:false}+run_end{failed}+렌더러 정리 보장.**
- **step_timings 저장**(RunState 신규 필드): agent_id/kind/started_at/elapsed_ms/ok. resume 시 완료 step 타이밍 보존, 재실행 없음.
- **렌더러 재작성**(`src/commands/progress.ts`): 이벤트 소비형. 현 CLI 출력 계약 보존(TTY 스피너/비-TTY 라인/✓ 라인 동일). gate/approval은 스피너 미가동(stdin 충돌 방지, F2.2).
- **범용 JSONL writer 골격**(`src/tools/trace.ts` 신규): ToolTrace 스키마 미고정·runWorkflow 미배선(M3+). 임의 레코드 append/read만.
- **테스트**: `src/core/progress.test.ts`(이벤트 순서·critique·gate jump·실패/resume·TTY/non-TTY 렌더러 계약) + `src/tools/trace.test.ts`(JSONL 왕복). `test:core` 스크립트 추가(HARNESS_WORKSPACE 격리).
- 검증: exec 74 + core 8 + acceptance 63 = **전부 통과**. 기존 mock 출력 계약 회귀 없음.
- **미구현(다음)**: M2 Capability/Profile 기반, M3 handoff+shadcn read+stream-json 배선(tool 이벤트 실 방출·trace 배선은 여기서).

## 2026-07-17 (V3 M0 — 문서 동기화 + provider 하드코딩 수정)

V3 착수 전 문서-코드 불일치 해소. 계획 승인 후 최소 수정.
- **taskPrompt provider 버그 수정**: `taskPrompt.ts:70` 하드코딩 `provider: mock` → `state?.provider ?? "미실행"`. mock/claude-code/미실행 3케이스 실측 확인.
- **CLI 버전 단일 원본화**: `cli.ts` `--version` `0.1.0` → `package.json` 런타임 읽기(`import.meta.url` 기준). dev·dist 동일, 드리프트 구조상 불가 → 별도 일치 테스트 불필요. 설명도 현 범위로 갱신. `--version`=2.6.0 확인.
- **CLAUDE.md 교정**: v1 단정 문구 → 현행 범위(문서 자동화 + exec/mission, 승인·권한 게이트 내 실행). `읽지 말 것`에 활성 V3 2문서 예외 추가. V3_KICKOFF_SUPERSEDED 참조 경로 정정.
- **파일 이동**: `docs/backlog/V3_KICKOFF_SUPERSEDED.md` → `docs/archive/`(과거 기록, 구현 근거 아님).
- **V3 HANDOFF 문서 각주**: v2.4 전제 → v2.6 구조 동일 각주 추가.
- 검증: `npm test` → acceptance 63/63 + exec 74/74 전부 통과. 테스트 완화·삭제 없음.
- **남은 불일치(후속)**: ① README v1/v2.6 범위 서술 낡음 ② V3 두 문서가 이미 구현된 exec/mission 실행 계층 미참조 ③ package.json.files는 M2에서 registry/schemas 추가 시 갱신.
- M1(V3 F2 + tool 이벤트 골격) 착수 가능. 별도 승인 대기.

## 2026-07-09 (디자인 레이어 킥오프 — P1~P5)

Phase 0 탐색 보고 → 승인(4개 결정: 별도 design 에이전트 / DESIGN.md에 tokens 펀치+추출 / node·tsx 린트 / {approval}+design_gate) 후 Phase별 커밋.
- **P1 에이전트별 헤더 스키마**: `validateAgentOutput(md, extra[])`, `AgentDef.required_headers`, pm=PRD·tech_lead=Tech Spec 등록 + 프롬프트 명시. mock에서 누락→재생성 루프 발동 확인.
- **P2 design 에이전트 신규**: `agents/design_agent.md`(DESIGN.md 9헤더 + 3계층 tokens 규칙), registry 등록(token_output). 산출 md의 ```json→docs/tokens.json 추출(`extractTokensJson`). 카운트 7→8.
- **P3 워크플로우 통합 + 디자인 게이트**: mvp-planning·full-predev에 design + {approval}(UX→Design→[승인]→Tech). `ApprovalDef.tokens_path`, `RunState.design_gate{status,tokens_hash}`(승인 시 sha256). mock e2e로 흐름·기록 확인.
- **P4 task-prompt 디자인 규칙**: DESIGN.md+tokens.json 존재 시 토큰 기반 구현 규칙 섹션 주입(부재 시 무영향).
- **P5 토큰 린트**: `scripts/token-lint.mjs`(node) — raw hex·primitive 직접참조·tokens 계층/참조/순환 정적 검사, ignore 예외, exit 0/1. acceptance Test 11 추가.
- 검증: acceptance **63/63**(신규 6), exec 74/74. README 갱신.
- **미완(§7)**: 실 provider e2e 1회(실제 DESIGN.md/tokens.json 산출+token-lint 통과 확인) — 토큰 비용 있어 사용자 승인 대기. 파이프라인 기계 검증은 mock으로 완료.

## 2026-07-09 (v4 후속 — StatusBoard, 나머지는 검증 후 보류)

- **필요성 검증 먼저**: 남은 v4 4개(Mailbox/tell/SPLIT/StatusBoard)를 냉정히 평가 → one-shot(Model A)엔 mid-session 상호작용이 없고 hub-spoke 설계가 세션 간 통신을 최소화하므로 Mailbox/tell/SPLIT은 근거 없는 선투자로 판단 → **보류(필드 관측 후)**. StatusBoard만 관측성 실통증(병렬 로그 뒤섞임)이라 착수.
- **statusBoard.ts**: 세션당 한 줄 상태판(코딩/게이트/리뷰/병합/완료/보류/실패), TTY 제자리 갱신·비TTY 전이 로그. ProgressReporter 일반화.
- **onPhase 훅**: SessionRunner에 단계 전이 훅 추가(coding/gate/review/merging/done) → 병렬·순차 미션에 threading → 미션 CLI가 StatusBoard로 렌더.
- 테스트: exec 단위 **74/74**(StatusBoard 3 추가) + acceptance 57/57. 실토큰 스모크는 생략(표시 계층, 병렬 실행은 기검증).
- 실행 계층 상태: v3·v3.5·v4(병렬 코어+상태판) 완료. Mailbox/tell/SPLIT만 필드 관측 후 판단.

## 2026-07-09 (실행 계층 v4 — 병행 오케스트레이션)

- **mergeCoordinator.ts**: 직렬 안전 병합(ARCH §2) — 브랜치마다 base 머지→L1 재게이트→ff 푸시, 충돌/게이트실패는 그 항목만 보류. 성공 시 worktree 정리.
- **parallelMission.ts**: `runParallelMission` — 의존 없는 태스크를 웨이브로 묶어 concurrency 한도 내 **병렬 실행**(runPool), 각자 worktree/ownership 격리, merge:false·keepWorktree로 브랜치에 커밋만 → 웨이브 끝나면 코디네이터가 직렬 병합 → 다음 웨이브. 강등/rate limit 대기 재사용.
- **harness mission --parallel [--concurrency N]**.
- **실세션 2 코더 동시 스모크 PASS**: 독립 유틸 2개(strutil/numutil) 동시 구현→리뷰→둘 다 develop 병합(최대 동시 세션 2 확인).
- **버그 2건 수정(스모크·flaky 테스트가 잡음)**: ① STATUS.md(세션 내부 통신, ARCH §3.3)가 병렬 병합 시 add/add 충돌 → 공용 git exclude로 커밋·병합·diff에서 제외. ② 동시 `git worktree add`가 .git 락 경합으로 flaky → worktree 생성/제거를 뮤텍스로 직렬화(세션 작업은 병렬 유지).
- 테스트: exec 단위 **71/71**(mergeCoordinator 2·parallelMission 3 추가, 3회 반복 안정) + acceptance 57/57.
- 남은 v4: Mailbox·tell·SPLIT·StatusBoard 고도화(병렬 코어는 완성). 설계 미결 Q4·Q5는 필드 튜닝.

## 2026-07-09 (실행 계층 §9-7·§9-8 — v3.5 미션 모드 완성)

- **modelPolicy.ts**: 강등 사다리 B(전부 Opus)/C(난이도 라우팅)/A(구현 Sonnet), 리뷰·계획은 Opus 고정. shouldDegrade(누적 대기 임계).
- **mission.ts**: runMission — 브리프 태스크 루프(dep 순서, 사전승인=autoApprove, 코더→L1→L3→develop 자동 병합), rate_limit_event 기반 auto 강등, rate limit 체크포인트(다음 태스크 직전 resetsAt까지 대기), MISSION_REPORT 렌더. turn 예산 가드는 SessionRunner 리뷰 루프에 추가.
- **briefGenerator.ts**: 목표→태스크 분해(플래너 Opus, JSON 파싱, maxTasks 가드).
- **harness mission --goal**: 브리프 생성→승인(유일 게이트)→자율 실행→outputs/MISSION_REPORT.md.
- **실세션 미션 e2e PASS**: 목표 분해(1태스크)→코더(math.js+math.test.js+package.json)→L3 리뷰(Critical0)→develop 병합, 실제 rate_limit로 B→C 강등 실증. **버그 수정**: 미션 기본 sessionId가 비-UUID라 코더 세션 실패(no_changes)→randomUUID로. 마지막 태스크 뒤 불필요 대기→다음 태스크 직전으로 이월.
- 테스트: exec 단위 **66/66**(modelPolicy 4·mission 5·briefGenerator 6 추가) + acceptance 57/57.
- 남은 설계 판단: DESIGN_QUESTIONS Q4(병합 전략)·Q5(rate limit 의미론) — 필드 튜닝.
- **→ 실행 계층 v3(대화형)+v3.5(미션 모드) 구현 완료.** 남은 §9 항목 없음(v4 병행은 별도 tier).

## 2026-07-09 (실행 계층 §9-6 — L3 리뷰어 + revise 루프)

- **reviewer.ts**: 신선 컨텍스트 L3 리뷰어(Opus 고정, plan 모드 읽기전용, --fork 금지). diff+SPEC+계약 인라인 → `### Critical` 스키마(red_team과 동일) → extractCriticalRisks 재사용.
- **SessionRunner 통합**: L1 게이트·커밋·diff 후 리뷰 루프 — Critical이면 코더에 --resume revise 주입 → 재게이트·재리뷰(max 2R) → 소진 시 review_deferred(병합 차단). `finalize()`/`consumeTurn()` 헬퍼로 재사용. SessionOutcome.reviews 기록.
- **harness exec --review [--review-rounds n]**.
- **실세션 e2e PASS**: 코더가 sum.js+sum.test.js 생성 → plan 모드 리뷰어 정상 판정(Critical 0) → develop 병합. plan 모드 리뷰어가 파싱 가능한 판정 텍스트를 냄을 실검증.
- 테스트: exec 단위 **51/51**(reviewer 3 + review 루프 3경로: 통과/revise후통과/라운드소진) + acceptance 57/57.
- 다음: §9-7 미션 모드(브리프·사전승인·defer·강등·turn 예산) → §9-8(자동 병합·rate limit 재개·MISSION_REPORT).

## 2026-07-09 (실행 계층 §9-5 — v3 대화형 단일 실행 완주)

- **§9-5 독립 조각**: `promptCompiler.ts`(SessionSpec→착수 프롬프트, 하이브리드) + `diffPreview.ts`(base 대비 변경 수집·요약) + `approvalQueue.ts`(승인 직렬화 FIFO + approve/reject/defer). SessionSpec에 task/inputs/contractPaths/dod 추가.
- **§9-5 통합**: `sessionRunner.ts`(worktree→권한컴파일→프롬프트→세션실행→L1게이트→자기브랜치 커밋→diff→승인→base 병합) + `harness exec` CLI(--task/--role/--base/--yes/--no-merge 등, stdin 승인 y/d/N, 이벤트 마일스톤 출력).
- **실제 세션 e2e 스모크 PASS** (임시 repo, 구독 토큰): 진짜 claude 세션이 hello.txt 생성 → 게이트 통과 → develop 병합, `develop:hello.txt="harness\n"` 검증. → **권한 컴파일러 `--settings` 실 CLI 수용 확인**(§9-3 미검증 항목 해소).
- settings는 worktree 밖(repoRoot/.harness/sessions)에 써서 세션 diff 미오염(테스트가 잡은 버그 수정).
- 테스트: exec 단위 **45/45**(promptCompiler·diff·queue·SessionRunner 오케스트레이션 4경로 mock+실git) + acceptance 57/57.
- 다음: §9-6 Opus 리뷰어 세션(L3) + revise 루프.

## 2026-07-09 (실행 계층 §9-3·§9-4 + ARCH v0.3 결정 반영)

- **ARCH v0.3 확정 반영**(페이블): Q1=Model A(one-shot+resume, B기각), Q2=하이브리드 프롬프트, Q3=그레이스1턴→DEFERRED. claudeCliProvider 잠정 딱지 제거, DESIGN_QUESTIONS 해소 마킹.
- **§9-3 권한 컴파일러**: `registry/permission_policy.json`(PERMISSION_POLICY §7 기계본) + `permissionCompiler.ts`(SessionSpec+정책→allow/ask/deny 규칙 + Claude Code settings + T3 hookDenyPatterns + materializeSettings). claudeCliProvider `--settings` 연결. SessionSpec에 ownership/forbidden/settingsPath 추가.
- **§9-4 worktree + L1 게이트**: `worktree.ts`(세션당 git worktree/브랜치 생성·제거·조회, develop 기준) + `machineGate.ts`(typecheck/lint/test/build 탐지·실행, 없으면 skip) + `runProcess.ts`(버퍼링 헬퍼). `.harness/` gitignore.
- 테스트: exec 단위 **29/29**(파서/mock/권한/worktree(실git 임시레포)/게이트) + acceptance 57/57. `npm test`=exec+acceptance. dist 재빌드(테스트·fixture 제외).
- 다음: §9-5 대화형 게이트(ApprovalQueue)+diff 미리보기+tell+PromptCompiler → v3 acceptance.

## 2026-07-08 (실행 계층 구현 착수 — §9-1·§9-2)

- 역할 분담 확정: **구현은 이 세션, 설계는 Fable 세션.** 설계 필요 지점은 `docs/reference/EXECUTION_DESIGN_QUESTIONS.md`에 정리만.
- **§9-1 CLI 실측**(`EXECUTION_CLI_RECON.md`): claude 2.1.204 플래그 매칭 — stream-json/resume/session-id/permission-mode(acceptEdits)/allowedTools/append-system-prompt/model/fallback-model/add-dir/agents 전부 존재. 어긋난 전제: `--max-turns` 부재 → 오케스트레이터 이벤트 카운팅. print+stream-json은 `--verbose` 필수.
- **stream-json 스키마 프로브**(승인 후 실호출 1회, $0.06): 이벤트 타입별 필드 박제. rate_limit_event(resetsAt/rateLimitType) 실존 → 강등·체크포인트 실데이터 구동. hook_response로 T3 거부 실시간 관측. 구독에서도 total_cost_usd/modelUsage 채워짐.
- **§9-2 ExecutionProvider 골격**(`src/exec/`): types(SessionEvent 정규화·SessionSpec·ExecutionProvider) + streamParser(NDJSON→이벤트, 청크 버퍼링) + eventQueue(async 스트림) + mockExecProvider(무과금 재생) + claudeCliProvider(Model A 잠정, --resume 체이닝). 단위 테스트 10/10(`npm run test:exec`, 실측 fixture 기반). `npm test`=exec 10 + acceptance 57. build/dist 정리(테스트·fixture 제외).
- **설계 미결**: 세션 수명 모델 A(one-shot+resume) vs B(지속형 stdin) = DESIGN_QUESTIONS Q1(블로킹). initialPrompt 조립(Q2), turn 예산 초과 동작(Q3).

## 2026-07-08 (진행 표시 UX + 실행 계층 설계 핸드오프)

- **진행 표시자(ProgressReporter) 추가.** run 중 각 agent LLM 호출이 침묵하던 문제 해결. TTY면 한 줄 스피너(`⠹ [2/5] research 실행 중… 0:42`) + 경과시간 제자리 갱신, 비TTY(파이프/로그)면 `▶ 시작` 줄만 폴백. 완료 라인에 `[i/N]` 카운터 + 경과시간(`[2/5] ✓ research → ... (42s)`).
  - core는 순수 유지: `runWorkflow.ts`에 `ProgressReporter` 인터페이스 + `reporter?` 주입, 스피너 구현은 CLI 계층(`src/commands/progress.ts`). 외부 패키지 0. 재생성 경고는 `reporter.note`로 스피너 훼손 없이 출력.
  - mock `npm test` 57/57 유지, tsc 통과, dist 재빌드.
- **실행 계층 설계 브리핑 문서 작성** (`docs/reference/EXECUTION_LAYER_DESIGN_BRIEF.md`). 창업자 비전("문서→자동 Claude Code 실행→병행/다중 라이브 세션→라이브 분화, 큰 이슈만 예/아니요")과 현재 v2.6.0(앞쪽 절반=문서 생성만) 갭 정리 + 재사용 뼈대(승인게이트/fanout/claude-code provider/ProgressReporter) + 설계 세션이 답할 질문. **설계 자체는 별도 Fable 모드 세션에서 진행 예정.**

## 2026-07-06

- 레포 구조 정리, registry JSON 생성, spec 불일치 수정
- git init + 원격(agrade1) 연결 + 초기 커밋/푸시 (아이디어 문서 IDEA_*.md는 .gitignore 제외)
- [1] scaffold: package.json/tsconfig/src/cli.ts, 최소 의존성(commander/tsx/typescript) 설치, 5개 명령 뼈대 + tsc 빌드 통과
- [2] registry 로드: src/core/paths.ts(REPO_ROOT), src/core/registry.ts(agent/workflow 로더 + 타입 + find 헬퍼)
- [3] harness list: src/commands/list.ts, acceptance Test 2 통과 (7 agents / common prompt 존재 / 4 workflows)
- [4] harness init: src/core/project.ts + src/commands/init.ts, 필수 docs 6개 + outputs 생성, 기존 파일 보호, acceptance Test 1 통과
- [5] mock provider + runAgent: src/providers/{provider,mockProvider}.ts + src/core/runAgent.ts, 스키마 필수 4헤더 출력·prompt 누락 throw 검증
- [6][6-1] runWorkflow + validator + saveArtifact: src/core/{runWorkflow,validate,saveArtifact}.ts + src/commands/run.ts. acceptance Test 3 전 조건 통과(순서/저장/run_state/failed_agent 중단/필수헤더 경고)
- [7] harness summary: src/core/summary.ts + src/commands/summary.ts. run_state+docs 읽어 CONTEXT_SUMMARY 갱신, 다음 작업 도출. acceptance Test 4 통과
- [8] harness task-prompt: src/core/taskPrompt.ts + src/commands/taskPrompt.ts. Context/Task/Include/Exclude/Rules/Done Criteria + 안전 규칙(설치/배포/DB) 포함. acceptance Test 5 통과
- [9] 통합 검증: scripts/acceptance.sh (npm test) — Test 1~5 자동 검증 30 checks all pass. README 사용법/테스트 섹션 추가. **v1 완료.**

## 2026-07-06 (v2 착수)

- v1 재검증: npm test 30/30 통과, 5개 명령 라이브 데모 정상 확인
- provider 전략 C안 확정 (구독기반 B안 지금 / API A안 나중) — 설계 문서 docs/reference/PROVIDER_ARCHITECTURE_V2.md 작성, V2_KICKOFF 링크
- [v2-1] Provider 인터페이스 async화 + token usage 필드 신설:
  - provider.ts: `generate()` 동기 string → `Promise<AgentResult>`, TokenUsage/AgentResult 타입 추가
  - mockProvider.ts: async화, usage 0 반환 (테스트/오프라인 기반 유지)
  - runAgent.ts / runWorkflow.ts: async 전파, run_state에 `provider` + `usage`(per_agent 합계) 기록
  - providers/index.ts: provider 셀렉터(getProvider), 현재 mock만 등록
  - cli.ts/run.ts: `run --provider <id>` 플래그(기본 mock), async action
  - 회귀 검증: acceptance 30/30 그대로 통과. run_state 새 필드 라이브 확인.
- [v2-2] claude-code provider(B안) 구현 — 실제 LLM 첫 연동:
  - claudeCodeProvider.ts: `claude -p --output-format json` 에 프롬프트를 stdin으로 위임, JSON `.result`/`.usage` 파싱, 코드펜스 제거. 환경변수(HARNESS_CLAUDE_BIN/MODEL/TIMEOUT_MS).
  - AgentRunInput에 `ideaContent` 추가, runAgent가 docs/00_IDEA.md 로드해 전달 (실제 LLM이 검토할 아이디어).
  - buildPrompt: common+agent 프롬프트 + 아이디어 + 컨텍스트 + AGENT_OUTPUT_SCHEMA 출력형식 지시.
  - providers/index.ts에 claude-code 등록.
  - **버그 수정**: extractMainJudgment가 불릿만 뽑아 실제 LLM의 문단형 Main Judgment를 놓쳐 handoff 요약이 비었음 → 첫 비어있지 않은 줄(불릿/문단 both) 반환하도록 수정.
  - 검증: `claude -p` 스모크(stdin+JSON shape 확인) → dev-preflight(3 agent) end-to-end 실행 성공(경고 0, usage 집계 in 9399/out 12798, ~3.5분). 실제 출력 스키마 준수 확인. acceptance 30/30 유지.
- [v2-3] 스키마 검증 재생성 루프 (V2_KICKOFF 2번, "가장 쉬운 첫 루프"):
  - runWorkflow: 각 step에서 validateAgentOutput 실패 시 누락 헤더를 retryFeedback으로 넘겨 maxRegenerations회(기본 1)까지 재생성. 재생성 후에도 실패면 경고+저장(기존 동작).
  - AgentRunInput.retryFeedback / RunAgentArgs.retryFeedback 추가, claudeCodeProvider가 프롬프트에 "재작성 지시" 블록으로 반영. mock은 항상 유효 → 미발동.
  - run_state에 regenerations[{agent_id, attempts, resolved}] 라운드 기록. usage는 재생성 포함 전 시도 합산.
  - CLI `--max-regen <n>` 플래그, run 출력에 재생성 요약.
  - 검증: flaky provider(1차 Risks 누락→재생성 시 포함)로 루프 결정적 테스트 — 재생성 1회 후 resolved:true, usage 합산 확인. mock acceptance 30/30 유지. README v2 섹션 추가.
- [v2-4] Red Team 비평 루프 (V2_KICKOFF 3번) — 워크플로우 아키텍처 확장:
  - workflows.json steps를 `(string | {critique_loop})[]` union으로 확장. registry에 CritiqueLoopDef/WorkflowStep/isCritiqueLoop 추가.
  - runWorkflow 전면 재작성: 재생성 로직을 runStepWithRegen 헬퍼로 추출, priorFindings를 Map(upsert, 순서유지)로. 비평 루프 실행부 추가.
  - 루프: critic 실행 → extractCriticalRisks로 Critical 추출 → 있으면 target에 revisionRequest로 되먹여 revise → 재검토. Critical 소멸 또는 max_rounds까지. run_state.critique_rounds 기록.
  - AgentRunInput.revisionRequest 추가, claudeCodeProvider가 "비평 반영 수정 지시" 블록으로 반영.
  - mvp-planning에 루프 내장(tech_lead⟲red_team×2) — 워크플로우 4개 유지(acceptance 무영향). list가 `↻[critic⟲target×N]` 렌더링.
  - 검증: mock(Critical 0→라운드1 해소) + stub provider(Critical 발견→revise→라운드2 해소) 두 경로 결정적 확인. completed_steps 중복제거, usage 재실행분 집계. acceptance 30/30 유지.
- [v2-6] CEO 게이트 분기 (V2_KICKOFF 4번):
  - registry에 GateDef/isGate 추가, WorkflowStep union에 `{gate}` 확장.
  - validate.extractDecision: Main Judgment + Decisions 섹션만 검색(문서 전체 검색은 Input Summary 역할설명 boilerplate 오탐 → 버그 발견·수정).
  - runWorkflow: gate 분기 추가. decider 판정이 on 키와 맞으면 해당 agent step으로 i 되돌림. gateBudget(step별 max_jumps)로 무한루프 방지. lastMarkdown 맵으로 판정 원문 보관. run_state.gate_jumps 기록.
  - full-predev에 게이트 내장(founder_ceo→{축소:pm,검증:research}×1). list `⤴[decider?분기×N]` 렌더링, run 요약에 게이트 표시.
  - 검증: mock(판정 미매칭→진행) + stub(축소→pm 되돌림→재실행→진행) 두 경로 + max_jumps 준수 확인. acceptance 30/30.
- [v2-5] anthropic provider (A안):
  - @anthropic-ai/sdk 설치(v0.110). anthropicProvider.ts: messages.create(system+user), usage 파싱. ANTHROPIC_API_KEY 없으면 명확한 에러(claude-code 안내). 기본 모델 claude-opus-4-8(HARNESS_ANTHROPIC_MODEL로 변경).
  - promptParts.ts로 프롬프트 빌더 공유(claude-code/anthropic 중복 제거) — claude-code buildPrompt 리팩터.
  - index.ts에 anthropic 등록. 기본 provider는 계속 mock.
  - 검증: 키 없을 때 failed_agent 경로로 깔끔히 실패(유료호출 X). 공유 빌더 구조 결정적 확인. **실제 유료 API 호출은 미검증**(사용자가 키 세팅 후).
- [실전 검증] mvp-planning을 claude-code로 실제 실행(카페 재고앱 아이디어): 비평 루프가 실제로 작동 확인 — red_team이 Critical 2건("입력 동기 부재", "감 대비 우위 미검증") 발견 → tech_lead가 반영해 수정("코드 쓰지 말고 검증부터") → red_team 재검토 여전히 2건 → max_rounds 소진 종료(무한루프 방지 정상). 9분41초, in 22K/out 33K. 루프가 출력을 유의미하게 개선함 확인.
- **v2 완료.** provider 3종 + 루프 3종 완비, 실전 검증. develop→main 병합 + v2.0.0 태그.

## 2026-07-07 (v2.1 — 라이브러리화)

- [v2.1-A] 하네스를 설치형 라이브러리로: 경로를 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(=CWD, 사용자 데이터)로 분리.
  - paths.ts: fromRoot → fromPackage(자산) + fromWorkspace(projects, CWD 기준, HARNESS_WORKSPACE 오버라이드).
  - registry/runAgent(프롬프트)=fromPackage, project(projects)=fromWorkspace로 전환.
  - package.json: version 2.1.0, files=[dist,agents,registry,README], engines node>=18, prepublishOnly=build, repository.
  - 효과: 서비스 레포마다 `npm install github:...` 후 `npx harness init`하면 그 레포에 projects/ 생성. 하네스 레포에 서비스 안 쌓임.
  - 검증: 하네스 레포 밖 임시 디렉토리에서 실행 → 자산은 패키지 로드, projects는 CWD 생성, 하네스 레포 미오염 확인. npm pack --dry-run으로 배포 파일 검증. acceptance 30/30 유지(개발 CWD=레포루트라 동일).
  - publish는 안 함(사용자 결정). install-ready까지.
- [B-②] 동적 분화(fanout) 추가:
  - registry: FanoutDef/isFanout, WorkflowStep union에 `{fanout}` 확장.
  - validate.extractSpawnDeclarations: `SPAWN id=.. | name=.. | focus=..` 파싱(id 정규화, 중복 제거).
  - 메인 루프: string step 다음이 fanout(planner=this)면 spawnRequest 주입 → planner 출력에 SPAWN 블록 유도. AgentRunInput.spawnRequest + provider 반영.
  - fanout step: planner 출력의 SPAWN 선언 파싱(max_agents 상한) → run_state.spawned_agents 기록. **기본은 계획만(사람 승인 게이트)**, `--allow-spawn` 시 하위 에이전트 런타임 생성·실행.
  - 하위 에이전트: 런타임 AgentDef + 생성 브리프(agentPromptText 오버라이드, runAgent가 prompt_path 파일 대신 사용) → outputs/spawned/<id>.md. 레포 영구등록 안 함.
  - dev-preflight에 fanout 내장(tech_lead→spawn×4). list `⑂[planner→spawn×N]`, run 요약 표시.
  - 검증: stub으로 계획만(executed:false) + --allow-spawn(실제 실행, outputs/spawned 생성) 두 모드 확인. acceptance 30/30 유지.
- **v2.2.0 태그** (동적 분화). develop→main 병합 + Release.
- [B-③] task-prompt를 멀티에이전트 실행 스펙으로 확장:
  - run_state.spawned_agents가 있으면 task-prompt에 "## 병렬 실행 (Claude Code subagents)" 섹션 추가 — FE/BE별 담당범위·계획문서(outputs/spawned/*.md)·산출범위 + API_CONTRACT 기준 통합 + 승인 게이트("자동 실행 금지").
  - Include에 spawned 계획문서 자동 포함. spawned 없으면 기존 단일 task-prompt 그대로(acceptance 무영향).
  - **경계 유지**: 하네스는 병렬 실행 "스펙을 생성"만. 실제 병렬 코딩은 Claude Code subagent가 사람 승인 후 수행(하네스가 코드 실행 안 함).
  - 검증: stub fanout(--allow-spawn) → task-prompt에 병렬 섹션·통합·Include 반영 확인. acceptance 30/30 유지.
- 다음(선택): 실전(claude-code) dev-preflight로 분화·병렬스펙 품질 체감, 또는 v2.3.0 태그.
- **v2.3.0 태그** (B-③ 멀티에이전트 task-prompt). develop→main 병합.

## 2026-07-07 (Obsidian 연동 — V2_KICKOFF 5번)

- [Obsidian] workflow 실행 결과를 Obsidian vault로 export:
  - src/core/obsidianExport.ts: `exportToVault({vault, state})` — run_state 기반으로 vault에 노트 사본 생성. 원본 프로젝트 파일은 읽기만(비파괴).
  - 각 완료 agent 출력 → `<vault>/<project>/<agent_id>.md`: YAML frontmatter(project/workflow/agent/role/provider/date/tags) + 원문 + "## 연결"(이전/다음/인덱스 `[[wikilink]]`).
  - run 인덱스 노트(MOC) `<workflow>_run.md`: 실행 순서대로 `[[wikilink]]` 나열 + 실행 메타(provider/토큰/비평루프/게이트/분화). tags에 moc 추가 → 그래프뷰 허브.
  - 분화된 하위 에이전트(spawn_*) 출력도 함께 export. safeName으로 노트명 안전화, YAML 값 이스케이프.
  - CLI `run --vault <path>` 플래그 + `HARNESS_VAULT` 환경변수. 미지정 시 export 안 함(기존 동작 무영향). export 실패해도 실행 결과 저장은 보존(경고만).
  - 검증: acceptance에 Test 6 추가(인덱스/agent 노트 생성, frontmatter, wikilink 양방향) → 35/35 통과. e2e로 vault 트리·노트 내용 확인.

## 2026-07-07 (v3 킥오프 → v2.5 안정화 Phase 0)

- **V3_KICKOFF.md(Fable 5 작성) 기반 착수.** v3 착수 조건(아이디어 2개 검증) 미충족 판정 → 버전 승격 원칙대로 Phase 0(v2.5 안정화: v2에서 보류했던 안전장치)을 v3 선결로 먼저 구현. 각 항목 단위 커밋(develop).
- **[v2.5 0-1] run --resume.** RunState에 status/failed_reason/resume_from/loop_state 추가(기존 필드 유지 → 하위호환). `--resume` 시 완료 step은 저장 산출물에서 findings만 복원(재실행 X), 중단 지점부터 완주. 완료 실행 재개는 덮어쓰기 방지(FAILURE_RECOVERY). loadRunState() export, summary는 실패 시 --resume 안내. 검증용 HARNESS_FAIL_AT 훅. acceptance Test 7.
- **[v2.5 0-2] token budget.** `run --max-tokens <n>` / `HARNESS_MAX_TOKENS`(기본 무제한). step 경계 누적(input+output) 검사 → 초과 시 status=failed, failed_reason="token_budget_exceeded", resume_from=다음 step → --resume 재개. 80% 도달 stderr 경고. 예산 중단도 exit 1. 검증용 HARNESS_MOCK_TOKENS 훅. acceptance Test 8.
- **[v2.5 0-3] approval gate.** WorkflowStep에 `{approval:{message,show}}` 타입 + isApproval. 승인 게이트: show 문서 표시 후 stdin y/N, 거부 시 user_rejected로 중단(--resume 재개), `--yes` 비대화 전체 승인. dev-preflight 마지막에 "개발 착수 승인" 1곳 내장(나머지 지점은 v3 executor 책임). list에 ✔[승인게이트]. acceptance Test 9.
- **[v2.5 0-4] Red Team 편향 분리.** AgentRunInput.contextMode(full|conclusion_only). critique_loop critic은 target 결론만 격리 검토(전체 findings 체인 anchoring 방지 — priorFindings를 target 결론만으로 제한 + 프롬프트 격리 문구). 일반 step은 full 유지. acceptance Test 10.
- 검증: mock `npm test` → **57/57 통과**.
- **남음(0-5, 사용자 액션)**: ① anthropic provider 유료 1회 실검증(ANTHROPIC_API_KEY + --max-tokens 상한), ② v2.5.0 태그(develop→main). 이후 Phase 1 도그푸딩(실제 아이디어 2개 full-predev 검증).

## 2026-07-08 (v2.5.0 릴리스 + Phase 1 도그푸딩)

- **v2.5.0 릴리스**: develop push → main 병합(--no-ff "Merge develop: v2.5 안정화 Phase 0") → v2.5.0 태그 + push. acceptance 57/57.
- **Phase 1 도그푸딩(claude-code 실제 LLM)**:
  - 아이디어 A(증적엔진)·B(폐쇄망) full-predev → **CEO 게이트 두 분기 실발화**(A 축소→pm, B 검증→research), max_jumps 가드 작동, 스키마 경고 0.
  - A dev-preflight(--allow-spawn --yes) → tech_lead 하위 3개 SPAWN 실제 실행 + approval gate 통과 + task-prompt 병렬 handoff 생성.
  - 하네스 self-review(mvp-planning) → critique_loop 2R 되먹임 + 0-4 편향분리(conclusion_only) 실전 검증. **red_team이 "결론만 받았다" 명시.**
  - 관찰·결론은 `docs/backlog/V3_FIELD_NOTES.md`. 아이디어 원문/결과는 gitignore된 projects/dogfood-*.
- **self-review 판정**: 하네스가 자신을 검토해 "v3 착수 조건(개발 착수 1건) 미충족 → 지금 v3.0 코딩 시작 말라"고 결론. 다음 코딩은 하네스가 아니라 실제 서비스 아이디어 쪽에서 나와야 함.

## 2026-07-08 (실사용 + v2.6.0 — ux_ui 디자인 레퍼런스 확장)

- **실사용 개발 착수(v3 게이트 충족)**: 별도 private 레포 `audit-evidence-engine`에 하네스 설치 → 아이디어 A full-predev(claude-code) + F idea-validation → task-prompt → 실제 코드 착수(`collect_evidence.sh`, 판정 경계 준수). "개발 착수 1건" 게이트 충족.
- **public 설치 지원**: dist를 레포에 커밋(.gitignore에서 제거) + build에 `chmod +x dist/cli.js` → `npm install github:agrade1/solo-founder-harness`가 빌드/스크립트 없이 동작. prepare 제거(소비자 경고 제거). README "사용 가이드" 섹션 추가. v2.5.1.
- **[v2.6.0] ux_ui 디자인 레퍼런스 확장**: ux_ui 에이전트가 레퍼런스 리서치 방향(Pinterest/Dribbble/Mobbin/경쟁사·유사서비스 + 검색 키워드) + 비주얼 방향 + 디자인 실행 handoff를 산출하도록 프롬프트 확장(§4·§5·§12-B·§14·§15, v1.1). task-prompt는 03_UX_FLOW 존재 시 "디자인 실행(화면 시안)" 섹션 자동 추가 — Claude Code에서 레퍼런스 검색 + Claude 아티팩트 시안 생성. **경계 유지**: ux_ui는 픽셀을 직접 렌더링하지 않고 방향·지시만, 실제 시안은 Claude Code. MVP-lean 원칙 유지. acceptance 57/57.
