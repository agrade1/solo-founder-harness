# DECISIONS.md

## 2026-07-22 (V3 M3c-2 — actual live read semantics acceptance PASS)

- **M3c-2를 offline+actual live 완료로 확정하되, 5개를 노출 승인으로 승격하지 않는다.** 실제 shadcn MCP에서 읽기 후보 5개를 고정 인자·정확 순서로 1회 호출(exit 0), 5회 모두 serviceCwd unchanged, 금지 2개 미호출, 전 결과 text-only·budget 이내를 실측했다. 그러나 이는 **read semantics 검증 후보**의 통과일 뿐 노출·권한 부여 근거로 확정하지 않는다.
- **증거를 관측된 범위로만 기록한다.** runner 출력에 없는 `resultChars`/`resultBytes`·protocolVersion/serverInfo 정확값은 추측하지 않는다. M3c-2는 "허용 protocol negotiation + non-empty serverInfo 계약 통과"로만 기록하고, `2025-11-25`/`shadcn 1.0.0`은 M3c-1 실측값으로 구분한다. 단일 실행의 무변경을 모든 원격 부작용 부재로 확대 해석하지 않는다.
- **다음은 M3c-3 계획 검토(구현 미착수).** 권한 등급 매핑·도구/인자 필터링·result-size enforcement를 이번 semantics 근거 위에서 설계·검토하고, 그 다음에야 registry profile 등록·handoff 연결로 진행한다. 이번 단계에서는 profile/registry/handoff/enforcement 어느 것도 구현하지 않았다.

## 2026-07-22 (V3 M3c-2 — read semantics probe P0/P1 보완)

- **고정 호출 계획은 export하지 않고 deep-freeze한다.** 실행에 쓰는 호출 목록·금지 목록·protocol allowlist는 non-exported 내부 상수 + runtime deep-freeze. 외부(runner/test)는 매번 deep clone getter만 본다. TypeScript `readonly`만 믿지 않고 런타임 변조 불가를 테스트로 강제. 시작 시 독립 contract(이름·순서·arguments canonical hash·중복 부재)와 exact 비교하고, M3c-1의 가변 export가 아니라 내부 exact set으로 검증한다.
- **budget은 전체 결과 크기로 판정한다.** text block 길이만이 아니라 CallToolResult 전체(content+structuredContent+isError) canonical serialization의 `resultChars`로 `withinProposedBudget`를 정한다. structuredContent/image/resource가 커도 budget에 반영된다. 여전히 측정만(자르지 않음), enforcement 없음.
- **파일시스템 무변경은 root·symlink·TOCTOU까지 방어한다.** root type/mode 포함, baseline symlink는 spawn 전 차단, 파일은 `O_NOFOLLOW` fd로 fstat/read해 snapshot 중 symlink 교체를 막고, 파일별·전체 read 상한을 둔다.
- **모든 실패 경로도 child close 확인 후에만 reject하고, close 전에는 임시 HOME/cache를 지우지 않는다.** cleanup 실패는 `cleanup_failed`로 표면화한다(임시 자원 leak를 숨기지 않음). 잔존 가능성은 fail-closed.
- **5개는 노출 승인이 아니라 검증 후보다(불변).** 이 offline 하드닝 이후에도 권한 분류·profile 등록·handoff 연결·result-size enforcement는 하지 않는다. 실제 5회 호출(승인 후)로 read-only·크기 근거를 확인한 뒤 별도 단계에서 진행한다.

## 2026-07-21 (V3 M3c-2 — controlled read semantics probe scaffold, offline)

- **읽기 후보 5개만, 고정 인자로, 코드 상수로 호출한다.** `get_project_registries`·`list_items_in_registries`·`search_items_in_registries`·`view_items_in_registries`·`get_item_examples_from_registries`. `get_add_command_for_items`·`get_audit_checklist`는 **호출·노출 후보에서 제외**하고 tools/call 생성 경로를 두지 않는다. package/command/args/tool/arguments 외부 주입 seam 없음.
- **"실제로 read-only인가"를 파일시스템 무변경으로 실측한다.** serviceCwd 전체를 호출 전/후 재귀 snapshot(경로·타입·mode·size·SHA-256)해 생성·수정·삭제·symlink가 하나라도 생기면 즉시 fail-closed. runtime/cache/home은 serviceCwd 밖 임시 경로로 분리해 "정상적 캐시 쓰기"와 "serviceCwd 변조"를 구분한다.
- **외부 결과는 untrusted data다 — 저장·출력·실행하지 않는다.** artifact에는 원문 대신 파생 지표(hash/count/type/elapsed/bytes/unchanged/budget)만 남기고 `externalDataUntrusted:true`로 표식한다. content 문자열을 model/Claude에 전달하거나 그 안의 지시를 실행하지 않는다.
- **budget은 이번 단계에서 측정만 한다.** 8,000 chars 초과를 자르거나 통과로 숨기지 않고 `withinProposedBudget:false`로 기록한다. result-size **enforcement는 아직 하지 않는다**(측정 근거를 모은 뒤 별도 단계).
- **5개는 "노출 승인"이 아니라 검증 후보다.** 이번 semantics 측정(승인 후 actual 5회)으로 read-only·결과 크기 근거를 확인한 뒤에만 권한 등급 매핑·registry profile 등록·handoff 연결·result budget enforcement로 진행한다. 이번 offline 단계에서는 그 어느 것도 하지 않았다.

## 2026-07-21 (V3 M3c-1 — actual live schema probe PASS)

- **M3c-1은 offline+actual live 완료로 확정하되, schema를 권한 근거로 승격하지 않는다.** 실제 shadcn MCP(protocolVersion 2025-11-25, serverInfo shadcn 1.0.0)에서 7개 도구 schema를 1회 실측(runner exit 0). **annotations/outputSchema는 전 도구에 없음** — read/write hint가 서버에서 제공되지 않았다.
- **description은 서버 제공 untrusted 정보다.** 이름과 마찬가지로 description·inputSchema 필드명만으로 read/write를 분류하지 않는다. 권한 분류는 실제 동작(semantics)을 통제된 방식으로 확인한 뒤에만 한다(M3a "플래그=격리 금지"의 연장).
- **버전 종속 실측.** shadcn@4.13.1 · protocolVersion 2025-11-25 조합의 스냅샷이며 버전 변경 시 재-probe로 재확인한다.
- **다음은 M3c-2 controlled read semantics 검증 계획.** 승인·격리 하에서 각 도구의 read-only 성격·결과 크기를 통제 확인한 근거로만 권한 등급 매핑·registry profile 등록·handoff 연결·result-size enforcement로 진행한다. 이번 단계에서는 profile 등록·handoff 연결·MCP 도구 호출·registry 변경을 하지 않았다.

## 2026-07-21 (V3 M3c-1 — schema probe P0 보완: 보안 경계·공식 계약·lifecycle)

- **실행 명령 우회 seam을 코드에서 완전히 제거한다.** `HARNESS_SHADCN_NPX_BIN` 지원 삭제 — `runShadcnSchemaProbe`는 항상 `npx --yes shadcn@4.13.1 mcp`만 실행한다. 테스트는 임시 PATH에 `npx` 이름 fixture를 두는 방식으로 격리(문서의 "주입 seam 없음" 주장과 코드 일치). runner import는 export 위치(`shadcnPilot.js`의 `checkComponentsJson`)와 정확히 일치시키고 offline smoke로 재발을 막는다.
- **schema object key는 마스킹 대상이 아니라 fail-closed 대상이다.** value는 scrub하지만 key가 secret/credential 형태면 이름을 바꿔 잘못된 schema를 저장하지 않고 `secret_in_schema_key`로 실패한다(원 key 미노출).
- **공식 MCP 계약을 근거로 검증한다.** protocolVersion은 stable `2025-11-25`를 요청하고 allowlist 내 이전 revision negotiation을 인정한다("특정 버전이 최신"이라는 문서 단정은 제거). initialize의 capabilities(.tools)·serverInfo(name/version)를 검증하고, Tool.description은 optional·title 수집·inputSchema/outputSchema root `type:"object"` 강제. **annotations는 untrusted hint** — 형식만 검증하고 권한 판정 근거로 쓰지 않는다.
- **성공은 child close 확인 이후에만 확정한다.** 수집 후 stdin을 닫고 bounded wait로 close를 기다리며(grace 후 SIGKILL), close 확인 전에는 result 반환·snapshot 저장을 하지 않는다. 미종료·잔존 가능성은 typed fail-closed. stdout byte 상한은 raw Buffer로 계산하고 StringDecoder로 멀티바이트 경계를 보존한다.
- **tools/call 부재는 로그 추측이 아니라 고정 operationSummary로 증명한다.** 결과에 `{initialize,initialized,toolsListPages,toolCalls:0}`를 반환하고 runner가 검사한다. snapshot에는 raw JSON-RPC payload를 저장하지 않으며 tools/call 생성 경로는 계속 없다.

## 2026-07-21 (V3 M3c-1 — tools/list schema discovery scaffold, offline)

- **schema probe는 shadcn 전용의 좁은 stdio JSON-RPC 경로로 구현한다.** 범용 MCP client를 만들지 않는다. `initialize → notifications/initialized → tools/list`까지만 허용하고 **tools/call 코드 경로 자체를 두지 않는다**(도구 실행 불가가 구조적으로 보장). MCP protocolVersion은 공식 stable spec 상수(`2025-06-18`)로 요청하고 허용 버전 집합 내에서만 negotiation을 인정한다.
- **실행 명령은 우회 불가로 고정한다.** `npx --yes shadcn@4.13.1 mcp`를 `shadcnDiscoveryProfile()`+`buildMcpConfig`로 pin 검증해 얻고, 외부에서 package/command/args를 주입하는 seam을 두지 않는다. 테스트는 launcher 실행 파일(`HARNESS_SHADCN_NPX_BIN`)만 교체하며 pinned args는 불변(M3c-0 HARNESS_CLAUDE_BIN과 동형).
- **직접 서버는 bare 도구명을 반환한다 — host가 namespacing한다.** claude 경유(M3c-0)는 `mcp__shadcn__*`를, 직접 stdio는 bare 이름을 준다. probe가 `mcp__<server>__`를 붙여 M3c-0 확정 7개와 정확 비교(누락/추가/중복/pagination 루프/상한 fail-closed).
- **schema 산출물은 raw protocol이 아니라 추출 schema만 저장한다.** `mcp-schema-discovery.json`(mode:`schema-discovery`·usableForHandoff:false)은 JSON-RPC envelope를 담지 않고 name/description/inputSchema(+outputSchema/annotations)만 담으며, 깊이·크기 상한·deep-scrub·wx·0600으로 보호한다. 타입은 PreflightSuccess/discovery와 분리해 승인 근거 오용을 막는다.
- **이름·schema를 권한으로 해석하지 않는다.** description·annotations를 봐도 read/write·browse/search/install/add로 분류하지 않는다. 권한 등급 매핑·registry profile 등록·handoff 연결·result-size enforcement는 **미착수**이며, 실제 schema 실측(runner 승인 실행) 이후 별도 단계(M3c-2+)에서 근거를 갖춰 진행한다.

## 2026-07-21 (V3 M3c-0 — 실제 live discovery 1회 실행, discovery offline+live 완료)

- **discovery는 offline+live 완료로 확정하되, 전체 M3c는 미완료로 둔다.** 실제 Claude Code 2.1.216에서 `shadcn@4.13.1` MCP를 strict 격리로 1회 discovery(exit 0/OK) → server `shadcn` connected + 도구 7개 실측. 격리·권한·redaction·cleanup·잔존 프로세스 검사 통과.
- **발견된 도구명을 권한으로 해석하지 않는다.** `get_*`/`list_*`/`search_*`/`view_*`/`get_add_command_*` 같은 이름은 read/write 성격의 근거가 아니다. `tools/list`의 inputSchema·실제 동작(semantics)을 실측하기 전까지 browse/search/install/add 등으로 매핑하거나 permissionMode를 부여하지 않는다. (M3a "플래그=격리 금지" 원칙의 연장 — "이름=권한 금지".)
- **버전 종속 실측(2.1.216)이며 도구 셋은 shadcn 버전에 종속된다.** shadcn@4.13.1·CLI 2.1.216 조합의 스냅샷이다. 버전 변경 시 재-discovery로 재확인한다.
- **다음은 M3c-1 `tools/list` schema·semantics 검증 계획.** 도구별 inputSchema·read/write 성격을 확정한 뒤에야 권한 등급 매핑·registry profile 등록·handoff 연결로 진행한다. 이번 단계에서는 profile 등록·handoff 연결·MCP 도구 호출을 하지 않았다.

## 2026-07-21 (V3 M3c-0 — offline hardening: 보안 경계는 핵심 API)

- **보안 경계는 runner가 아니라 핵심 API(`runShadcnDiscovery`)에 둔다.** 표준 registry 검사·package 고정·빈 도구 거부를 API가 강제하고, runner의 사전 검사는 보조로만 둔다(Codex가 API 직접 호출로 custom registry·빈 도구·foreign pin package를 통과시킨 재현을 근거로 승격). registry 검사는 config/runtime/spawn보다 **먼저** 실행해 실패 시 부작용(spawn·산출물) 0.
- **discovery package는 우회 불가로 고정한다.** `RunShadcnDiscoveryOpts.package`·`shadcnDiscoveryProfile(pkg)` 인자를 제거하고 항상 `shadcn@4.13.1`을 쓴다. 다른 exact-pin package도 주입할 수 없다(generic npx pin 검증은 adapter 계층에 유지).
- **빈 discovery는 실패다.** system/init에 shadcn MCP 도구가 0개면 `no_tools`로 fail-closed(성공은 1~64개). "연결됐지만 도구 없음"을 성공 스냅샷으로 저장하지 않는다.
- **오류·반환은 전 경로 scrub.** typed 오류를 그대로 rethrow하지 않고 code 보존 + message scrub으로 정규화한다(도구명/서버/stderr에 섞인 credential·sentinel 평문 노출 재현 차단). 성공 snapshot의 외부 문자열도 scrub하고 반환==저장(deepEqual)을 보장한다. `redactNames`는 scrub 전용이며 그 값을 discovery child env로 전달하지 않는다.
- **파일/스트림은 TOCTOU·무한 증가에 대비한다.** components.json은 `O_NOFOLLOW` fd로 열어 같은 fd로 fstat/read(경로 재오픈 없음), 64KiB+1 초과 미판독. stdout 1MiB·stderr 64KiB 상한으로 무개행 stdout·거대 stderr에 의한 메모리 폭증을 막는다. 강제 env(MCP 격리 변수)는 testEnv가 덮어쓸 수 없다.
- **snapshot 기록은 exclusive-create로 부분 성공을 남기지 않는다.** wx 충돌·기록 실패도 typed+redacted `persist` 오류로 반환하고 기존 파일/symlink를 덮어쓰지 않는다.
- **여전히 M3c 완료가 아니다.** 실제 도구명·profile 등록·handoff 연결·result-size enforcement는 미확정. live discovery는 별도 승인 후 수동 실행.

## 2026-07-20 (V3 M3c-0 — shadcn discovery scaffold, offline)

- **M3c는 "도구명 발견 기반"부터 offline로만 착수한다.** 실제 shadcn MCP 도구명을 모르는 상태에서 profile을 먼저 등록하거나 browse/search/install/add를 expected 도구로 추측하지 않는다. discovery 산출물로 실측한 뒤에 profile·handoff를 붙인다. **M3c 완료로 문서화하지 않는다**(discovery scaffold offline 완료까지).
- **discovery는 runPreflight와 타입·API로 분리한다.** runPreflight의 exact-profile 검증(정확 서버·도구 일치)을 완화하지 않는다. discovery는 도구명이 미지이므로 별도 `runShadcnDiscovery`로 "shadcn 단일 서버·shadcn prefix 도구만" 수집한다. 산출물은 `mcp-discovery.json`(mode:"discovery"·usableForHandoff:false, `ShadcnDiscoveryResult{discovery:true}`)로 `PreflightSuccess{ok:true}`와 섞이지 않게 하여 handoff/preflight 승인 근거로 오용될 수 없게 한다.
- **표준 registry만 허용, 나머지는 fail-closed.** components.json이 custom/private/third-party registry(항목 있음·plain object 아님)를 선언하면 거부. malformed·symlink·비일반 파일·64KiB 초과도 거부. 오류에 파일 내용·credential을 담지 않고 .env·환경 secret을 읽지 않는다.
- **shadcn 실행은 고정 pin(shadcn@4.13.1)만.** `@latest`/무버전/범위는 기존 npx pin 규칙(compileServer)으로 거부. discovery도 이 경로를 재사용한다.
- **live discovery는 수동 opt-in 전용.** `HARNESS_LIVE_M3C_DISCOVERY=1` 없이는 거부(Claude/npx 미호출), npm test/CI 비대상. 실제 실행 시 package download·네트워크·구독 사용량이 발생하므로 자동화하지 않는다. 이번 세션에서 실행하지 않았다.

## 2026-07-20 (V3 M3b.2 — actual live acceptance 완료(PASS))

- **M3b.2를 offline + actual live 완료로 확정한다.** 실제 Claude Code 2.1.215에서 live runner가 exit 0/PASS. 검증 항목: exact Hook 6종, empty MCP snapshot(servers=[]/tools=[])·config({}), planning contextRoot 접근(00_IDEA/06_CEO_DECISION Read 성공·serviceCwd docs 미생성), Read 성공/실패 callId correlation, Bash 승인(permission_requested callId=null + tool_requested/succeeded 동일 callId, sentinel 비출력), Write 수동 거부(requested+permission·marker 부재, denied 미합성), SessionEnd 1건, ambient MCP/Hook canary 미기동, trace redaction·권한·원문 미저장, run_state 불변, argv `-p`/stream-json 없음.
- **격리·Hook 계약 통과는 이 CLI 버전(2.1.215) 실측이다.** M3a 원칙 계승 — CLI 버전 변경 시 재검증한다("플래그=격리/계약" 금지). runner는 재현 가능한 수동 acceptance 자산으로 유지(`HARNESS_LIVE_M3B2=1`, npm test/CI 비대상).
- **앞선 실패 시도는 역사 기록으로 남긴다.** 1차 argv P0(무효), 2차 P0-1 planning 경로·P0-2 sentinel 출력. 삭제하지 않는다(재발 방지 근거).
- **다음은 M3c(shadcn read) 파일럿 계획 검토.** 구현 착수가 아니라 계획·acceptance 설계부터. 활성 설계 문서 기준 유지.

## 2026-07-20 (V3 M3b.2 — 두 번째 live P0 2건: planning 경로·sentinel 출력)

- **두 번째 live도 전체 PASS로 기록하지 않는다.** argv `--` 꼬리는 통과했으나 planning context 경로 단절(P0-1)과 sentinel TUI 평문 출력(P0-2)이 드러났다. 상태는 **M3b.2 live 재검증 대기**.
- **planning contextRoot ↔ serviceCwd를 명시적으로 분리한다(P0-1).** task prompt의 `Include`는 `docs/*.md` 상대경로인데 대화형 cwd는 serviceCwd다. handoff는 `contextRoot=projectPaths(project).root`를 argv `--add-dir`로 열고, initialPrompt에 "Include의 docs/…는 contextRoot 절대경로, serviceCwd 아래 docs 생성 금지, WORKLOG 대상=contextRoot/docs/WORKLOG.md" 계약을 명시한다. 승인 preview에도 두 경로를 별도 표시한다. `--disallowedTools mcp__* -- <initialPrompt>` 꼬리는 유지.
- **live 검증용 fake sentinel은 값을 출력하지 않는 방식으로만 다룬다(P0-2).** Bash 검증을 `printf '%s' "$TOKEN"`(값 출력) → `node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'`(존재만 확인)로 바꾼다. 실제 sentinel 값은 terminal/settings/config/snapshot/trace/outcome 어디에도 출력하지 않는다. 이번에 출력된 것은 runner가 심은 fake sentinel로 **실제 credential이 아니다**. collector redaction 단위 테스트는 유지.
- **경로 계약도 회귀 테스트로 고정한다.** `--add-dir`=contextRoot, prompt의 절대 contextRoot·WORKLOG 경로, serviceCwd에 docs 미생성을 core 단위 테스트와 runner 사후 검증 양쪽에서 강제한다(실제 Claude 없이도 구조 회귀 포착).

## 2026-07-20 (V3 M3b.2 — 첫 live 시도 무효(argv P0))

- **첫 live acceptance 시도는 무효로 확정한다.** Claude Code 2.1.215에서 대화형 argv `--disallowedTools mcp__* <initialPrompt>`가 `--disallowedTools`(가변 인자) 값으로 프롬프트를 소비해 `Permission deny rule "..." matches no known tool` 경고가 폭주했다. 세션이 acceptance 절차를 받지 못했으므로 **Hook 검증은 수행되지 않았고 PASS로 기록하지 않는다.**
- **대화형 argv는 옵션 종료 구분자 `--`로 프롬프트를 격리한다.** 꼬리를 `--disallowedTools`, `mcp__*`, `--`, `initialPrompt`로 고정한다. 가변 옵션 뒤 positional은 항상 `--` 뒤에 둔다(향후 옵션 추가 시에도 이 규칙 유지). 대화형 TUI·stdio inherit·`-p`/stream-json 미사용은 불변.
- **argv 계약은 회귀 테스트로 고정한다.** 프롬프트가 deny 값 영역에 들어가지 않음을 core 단위 테스트와 runner 사후 검증 양쪽에서 강제한다. 실제 Claude 없이도 argv 구조 회귀를 잡는다("플래그 존재=정상" 금지, 실측 P0 방지).
- **상태는 "M3b.2 live acceptance 재실행 대기"로 유지한다.** 수정은 offline 검증까지만. 실제 Hook 검증은 사람이 runner를 재실행해야 성립한다.

## 2026-07-19 (V3 M3b.2 — Interactive handoff, offline)

- **handoff는 대화형 TUI를 "여는" 것까지만.** `claude <initialPrompt>` + `stdio:"inherit"`. 코드 수정 권한은 Claude Code 자체 permission이 게이트한다. `-p`/stream-json/stdout 파싱은 대화형에 쓰지 않는다(그건 M3a headless preflight 전용).
- **spawn 전 fail-closed preflight 필수.** 빈 MCP config(`{mcpServers:{}}`) + `--strict-mcp-config`로 헤드리스 preflight를 돌려 ambient MCP 서버/도구가 하나라도 보이면 차단하고 spawn하지 않는다. "플래그=격리"가 아니라 snapshot 실측으로만 판정(M3a 원칙 계승). expected 서버/도구는 모두 빈 배열.
- **allow-empty는 별도 명시 경로.** profile 기반 `buildMcpConfig`의 `no_mcp_binding` 기본 거부는 유지하고, handoff용 빈 config는 `buildEmptyMcpConfig`/`writeEmptyMcpConfig`로 분리한다.
- **격리는 CLI 인자로만, managed policy 우회 없음.** `--setting-sources ""`(user/project/local settings·Hook 격리), `--mcp-config`(빈), `--settings`(런타임 hook settings), `--permission-mode default`, `--tools default`, `--disallowedTools mcp__*`, env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- **Hook settings는 공식 exec form.** shell 문자열 조합 대신 `command`=node 실행 파일 + `args`=[collectorPath, hookKind]. shell 파싱/이스케이프 경유가 없고 argv가 collector parseArgs와 정확히 일치한다. collector는 배포 가능한 `dist/tools/hookCollector.js` 절대경로.
- **run_state.handoff는 실제 spawn된 경우에만.** print/reject/preflight 실패/spawn 실패/non-TTY/missing binary에서는 기록하지 않는다. 대화형 종료코드는 기록하지 않고 completed 상태도 바꾸지 않는다.
- **비-TTY·바이너리 부재는 실패가 아니라 폴백.** 비-TTY는 대화형 세션을 열지 않고(--yes와 조합돼도 백그라운드 TUI 금지), 바이너리 부재는 설치 안내 + 재진입 명령. `--print`는 실행·preflight·상태 변경 없이 재진입 명령(`harness handoff ... --yes`)만 출력하며, 실제 실행 시 preflight를 다시 거친다.
- **runtime 산출물은 최소 권한·gitignore.** `outputs/runtime/`(기존)·`outputs/tool-trace/`(추가) 커밋 금지. mcp-config/hook-settings는 dir 0700/file 0600. raw Hook payload·transcript는 저장하지 않는다.
- **[P0] collector는 배포 산출물 절대경로만.** `PACKAGE_ROOT/dist/tools/hookCollector.js`(dev tsx·prod 동일). import.meta.url 상대 계산은 dev에서 존재하지 않는 src/*.js를 가리키므로 쓰지 않는다. spawn/preflight 전 존재·일반 파일 검증, 없으면 `setup_failed`.
- **[P0] 산출물 파일은 최소 권한 + exclusive-create.** ToolTrace JSONL은 spawn 전 빈 0600 파일로 사전 생성하고 collector가 append(모드 불변). hook-settings/mcp-config/tools-snapshot 0600, dir 0700. 기존 파일·symlink는 `wx`로 fail-closed(조용한 덮어쓰기·symlink 공격 방지). 기본 handoff id는 randomUUID 포함(충돌·예측 방지).
- **[P1] redaction refs는 env 이름에서 파생, 값은 절대 기록 안 함.** `process.env`에서 이름이 secret 형태(TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL/AUTH)이고 값이 있는 항목의 **이름만** refs로 파생 → `HARNESS_TOOL_SECRET_REFS`(이름) + collector가 값 마스킹. preflight `redactNames`는 오류 scrub 전용이며 그 secret 값을 preflight child env로 전달하지 않는다. spawn/setup/preflight 오류·로그·outcome은 `redactSecrets` 통과. raw process.env·secret 값 자체는 출력하지 않는다.
- **[P1] `--setting-sources ""`가 서비스 레포 CLAUDE.md를 로드하지 않으므로 프롬프트로 보완.** initialPrompt에 "서비스 레포 AGENTS.md·CLAUDE.md 존재 시 먼저 읽고 준수" 명시. managed policy 우회는 계속 금지.
- **M3b.2는 offline 기반 완료.** 다음은 M3c가 아니라 **M3b.2 actual Claude Hook live acceptance**(수동): `--setting-sources ""` 실제 수용, exec-form Hook 6종 실제 등록, 6 payload(PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/PermissionDenied/SessionEnd), trace redaction·0600, TUI 유지·stream-json 미사용. **M3c(shadcn read)는 live 통과 후.**

## 2026-07-19 (V3 M3b.1 — HookTrace 기반, offline)

- **Hook은 관측만, 승인 결과를 유추하지 않는다.** PermissionRequest→요청 사실만, PermissionDenied→auto-mode denial만. **PermissionRequest 공식 payload에는 correlation ID(tool_use_id)가 없다** → callId=null이며 synthetic ID를 만들지 않는다. Hook만으로 수동 승인/거부 결과를 정확히 연결할 수 없음을 `permissionOutcomeObservable:false`로 명시하고 denied로 추측 금지(타입·테스트·문서에 한계 명시).
- **MCP server는 전달된 exact tool map으로만 판정.** 이름(`mcp__srv__t`)에서 추측하지 않는다(미매핑→null).
- **원문 미저장 원칙.** transcript_path·raw tool_response는 기록하지 않고 tool_response는 byte 수만. 입력/오류는 크기 상한 절삭.
- **secret은 이름만 설정·argv에.** 값은 collector가 hook 실행 시점 process.env에서 조회해 redaction. 민감 key는 값 통째 마스킹.
- **collector 종료코드로 실행 게이팅.** PreToolUse audit/deny 실패·거부는 exit 2(차단), 사후 Hook 실패는 exit 1(경고, 원 실행 왜곡 금지), 정상은 stdout 미사용(Claude Hook JSON 해석 비간섭).
- **RunEvent 매핑(`toRunEvent`)은 post-session/테스트용.** TUI 중 실시간 emit하지 않는다.
- **대화형은 `stdio:inherit` + Hooks만.** stream-json 파싱은 M3a headless preflight 전용이며 대화형 세션에 쓰지 않는다(설계 정정).
- **collector fail-closed 강화(P0/P1).** env는 엄격 검증(JSON fallback 금지), payload 계약(hook_event_name/session_id/tool 필드·deny=PreToolUse 전용) 위반은 blocking Hook에서 exit 2. 오류에 stack/env/secret 미출력.
- **SessionEnd는 종료 사실만 기록.** 승인 결과나 unresolved permission 목록을 추측·계산하지 않는다(공식 payload에 correlation ID가 없어 수동 승인/거부를 정확히 연결할 수 없기 때문).
- **크기·깊이는 UTF-8 byte·재귀 depth 상한으로 실제 강제.** 병렬 append 라인이 작게 유지되어 원자성 확보.

## 2026-07-19 (V3 M3a — live acceptance)

- **live acceptance는 수동 전용, 명시 opt-in.** `scripts/m3a-live-preflight.mjs`는 `HARNESS_LIVE_M3A=1` 없이는 거부하고 npm test/CI에서 실행하지 않는다. 실제 Claude를 호출하므로 자동 파이프라인에 편입하지 않음.
- **격리 통과는 CLI 버전에 종속.** 2026-07-19 실측(Claude Code 2.1.215)에서 strict-mcp-config가 ambient canary를 차단함을 확인했으나, 이는 해당 버전의 실측이다. CLI 버전 변경 시 flag/`system/init`/격리 동작을 재검증한다("플래그 존재=격리" 금지 원칙 유지).
- **live runner/fixture를 저장소에 커밋한다.** 재현 가능한 수동 acceptance 자산으로 유지(이전의 "커밋 금지"는 검토 단계 한정이었음). 단 production MCP 구현이 아니라 canary acceptance 더블임을 헤더에 명시.

## 2026-07-19 (V3 M3a — live 전 보안 보완)

- **npx만 정확 고정 버전 강제.** 임의 dist-tag(`@latest`/`@next`)·범위(`@^`/`@~`/`@*`)·무버전을 npx에서 거부(재현성·공급망). node/local executable엔 미적용(오탐 방지).
- **preflight child env는 allowlist + 선언 secret만.** `process.env` 전체 전달은 미선언 토큰/키 유출 경로 — 폐지. 테스트용 env 주입은 production allowlist와 섞지 않는 명시적 `testEnv` seam으로 분리(프로덕션 경로 오염 방지).
- **반환 snapshot도 redacted, 저장본과 동일.** 호출자가 받는 객체와 파일이 달라 redaction이 우회되는 구멍 제거. 실패 시 성공 snapshot 미생성(fail-closed 일관).
- **중복 파생 도구는 조용히 dedupe하지 않고 거부.** 노출 표면 착오를 감추지 않기 위함. transport 혼합·credential 형태·secret 실값 포함도 기록 전 거부.

## 2026-07-19 (V3 M3a — Headless MCP preflight)

- **격리는 snapshot 실측으로만 판정.** `--strict-mcp-config`/`--mcp-config` 플래그 존재를 격리로 신뢰하지 않고, `system/init`의 실제 mcp_servers·tools를 기대치와 정확 비교(canary 자동 실패). 실패 시 typed error로 fail-closed — 성공 result를 절대 반환하지 않음.
- **preflight는 M2.1 fail-closed와 별도 경로.** runWorkflow의 MCP profile 거부는 유지하고, preflight는 M3에서 MCP를 여는 유일한 검증 관문으로 독립 배선. (해제는 preflight 통과가 전제.)
- **config는 참조된 서버만·secret 값 미기록.** binding이 참조하는 서버만 mcp-config에 포함, `@latest` 금지, secret은 이름만(값은 config·snapshot·error에 redaction). runtime 산출물은 gitignore.
- **init 수집 후 의도적 종료는 실패가 아니다.** headless preflight는 init만 필요하므로 수집 즉시 kill하고, 그 종료 코드를 성공/실패 판정에 쓰지 않음(오판 방지). timeout·비정상 종료(무 init)만 실패.
- **파서는 exec/streamParser 재사용.** 신규 파서를 만들지 않고 init 이벤트에 mcpServers 정규화만 추가(connected는 "connected"만).

## 2026-07-19 (V3 M2.1 — P0 보완)

- **secret 값은 provider context로 전달하지 않는다.** execContext에는 이름(redactNames)만 담고, 값은 claude-code provider가 내부에서 `collectSecretValues(process.env)`로 조회 → redaction 표면 축소.
- **MCP profile은 loader/compile이 아니라 run 경로에서 fail-closed.** per-tool 강제(M3 snapshot) 없이 실행하면 exposedTools가 거짓 강제가 되므로 run_start 이전 거부. 단 loader/compile은 성공시켜 M3가 동일 profile을 로드·검증할 수 있게 한다.
- **claude 실행 파일/타임아웃을 호출 시점에 읽는다.** 모듈 로드 시 고정 → 스텁 주입 불가였음. 동작 중립적 변경으로 실제 spawn argv 테스트 가능.
- **`toolProfilesPath` seam 추가.** registry에 MCP profile을 넣지 않고도 run-level 거부를 테스트하기 위한 최소 override(테스트/M3 겸용).

## 2026-07-17 (V3 M2 — Capability/ToolProfile 정책 계층)

- **`exposedTools`는 입력이 아니라 compile이 bindings에서 파생.** 노출 도구를 손으로 나열하지 않고 builtin/mcp binding에서 계산 → binding tools ⊆ exposed가 구조적으로 보장. preapproved/denied만 명시 입력.
- **`repo_write_direct` 폐기, 쓰기 권한을 세분화.** reserved(local_workspace_write, pull_request_create) vs deny(remote_repository_write, pull_request_merge, ...). "로컬 쓰기/PR 생성"과 "원격 쓰기/머지"의 위험도가 달라 계층을 분리.
- **fail-fast는 capability 이름이 아니라 compiled policy의 binding 실행 주체로 검증.** builtin→provider, mcp→provider MCP, internal_adapter→Adapter Registry, cli→실행 환경. `assertProviderSupports(ids)` 폐기 — 이름만 보면 "어떻게 실행되는가"를 놓친다.
- **JSON Schema는 런타임 미실행.** 신규 의존성(ajv 등) 추가 없이 수동 structural+semantic validator 사용. `schemas/*.json`은 계약 문서 + 향후 정식 validator용.
- **`--bare`는 argv 생성·검증까지만(M2).** planning 격리 = `--strict-mcp-config` + 내장도구 제한(`--tools`). snapshot 기반 회귀 판정·strict empty fallback 자동 강등은 실제 claude 실행이 필요하므로 M3.
- **회귀는 byte 동일 대신 golden snapshot.** 가변 메타데이터(project/타임스탬프/elapsed_ms) 제거 후 정규화 비교 + 시맨틱 assertion.
- **registry에는 실행 가능한 profile만.** planning-none/planning-local-readonly만 등록. Tavily/shadcn 등은 실행기(어댑터/MCP 배선)가 붙는 M3·M4까지 미등록 — 등록 즉시 fail-fast로 걸릴 profile을 배포하지 않음.

## 2026-07-17 (V3 M1 — 진행 이벤트 모델)

- **기존 `ProgressReporter`(start/note/stop)를 이벤트 모델(emit(RunEvent))로 교체.** 병존 대신 교체 — 두 진행 시스템은 부채. 렌더러가 이벤트 소비자가 되고 CLI 출력 계약은 보존.
- **run_end는 try/finally로 항상 방출.** "정상 완료 직전에만" 방출하는 구조 금지 — provider/step 예외에도 step_end{ok:false}+run_end{failed}+렌더러 정리가 보장돼야 함.
- **note 이벤트에 level(info|warn) 포함.** 기존 재생성 경고 라인을 손실 없이 보존.
- **gate/approval은 스피너 미가동.** approval은 stdin(승인 프롬프트)을 기다려 \r 스피너와 충돌 — 이벤트는 방출하되 렌더러가 안 그림 (F2.2).
- **`src/tools/trace.ts`는 M1에서 범용 JSONL writer로만.** ToolTrace 공통 스키마 고정·runWorkflow 배선은 M3(실제 tool 이벤트 방출 시점)로. 골격을 특정 스키마에 조기 결박하지 않음.
- **step_timings resume 복원은 기존 배열(gate_jumps 등)과 동일하게 완료분 보존.** 완료 step 재실행/중복 기록 없음.

## 2026-07-17 (V3 M0 — 문서 동기화)

- **CLI 버전은 package.json 단일 원본.** `cli.ts`가 런타임에 `../package.json`을 읽어 버전 드리프트를 구조적으로 제거. 하드코딩·별도 일치 테스트 불필요.
- **V3 활성 구현 기준은 두 문서로 한정.** `V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` + `V3_MCP_CAPABILITY_TOOL_PROFILES.md`. `V3_KICKOFF_SUPERSEDED.md`는 archive로 이동(과거 계획, 구현 근거 아님). backlog 문서는 사용자가 V3 작업을 명시 요청할 때만 활성 2문서를 읽는다.
- **M0 범위 엄수.** M1+ Capability/Profile/MCP/handoff/report 코드는 이번 세션에서 구현하지 않음. exec/mission ↔ V3 문서 괴리는 후속 항목으로만 기록(관계없는 리팩터링 금지).

## 2026-07-08 (실행 계층 방향)

- **실행 계층(문서→자동 실행→병행/다중 라이브 세션)은 v3+ 로 분리, 설계 먼저.** 창업자 비전은 ROADMAP v3 "실행 연결 실험"보다 넓음(병행/다중 세션 오케스트레이션). 바로 구현하지 않고 별도 Fable 모드 세션에서 아키텍처 설계 → `docs/reference/EXECUTION_LAYER_DESIGN_BRIEF.md`가 그 핸드오프. 설계 확정본은 `EXECUTION_LAYER_ARCH.md`(예정) + ROADMAP v3/v4 갱신.
- **진행 표시(ProgressReporter)는 UX 개선으로 즉시 반영.** 실행 계층 설계와 독립적이고, 다중 세션 상태판의 첫 조각도 됨. core/CLI 분리 원칙 유지(core는 TTY 무지).

## 2026-07-06

- agent prompt 파일명에서 버전 접미사 제거 (버전은 파일 내부 헤더로 관리)
- harness init 생성 docs = 6개 (00_IDEA, TASKS, DECISIONS, CONTEXT_SUMMARY, WORKLOG, API_CONTRACT), HANDOFF.md v1 제외
- 01~06 번호 문서는 workflow 실행 시 생성
- 구버전 가이드(solo_founder_harness_dev_guide)와 COMBINED_CORE_PROMPTS.md는 레포에서 제외
- v1 완료 기준 = acceptance test 1~5 전부 통과

## 2026-07-06 (2차)

- run_state.json v1 필수 필드 확정 (workflow_id, project, completed_steps, failed_agent, warnings, started_at, finished_at). resume은 v2
- 결과 저장 시 필수 섹션 헤더 검증(경고 수준) v1 포함
- v2/v3 로드맵은 docs/reference/ROADMAP.md — v1 개발 중 로드 금지
- v2 최우선 결정 = provider 전략 (API 직접 vs Claude Code subagent) → backlog/PROVIDER_STRATEGY_TODO.md
- 개발은 Opus 모델로 진행, 운영 규칙은 prompts/opus_optimization_guide.md
- IMPLEMENTATION_PLAYBOOK.md 추가: 세션 5개 기준 단계별 진행 순서 (사람용, Claude 기본 로드 제외)

## 2026-07-06 (v2 provider 결정)

- **provider 전략 = C안 확정**: 인터페이스에 mock/claude-code(B안,구독)/anthropic(A안,API) 3종, 플래그 교체. 지금은 claude-code로 운영, A안은 사용자가 종량과금 원할 때 추가.
- 이유: Claude.ai/ChatGPT 구독은 API 접근 미포함(별개 청구). 사용자는 기존 구독으로 추가비용 0 원함 → B안 우선.
- Provider.generate() 동기→비동기 + token usage 필드 신설(A안 예산상한 대비). mock은 계속 유지(acceptance 기반).
- 상세 설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md

## 2026-07-06 (v2 루프 아키텍처)

- workflow `steps`를 선형 `string[]`에서 `(string | {critique_loop})[]` union으로 확장 (V2_KICKOFF "steps→loop 확장"). CEO 게이트도 이 union에 `{gate}` 추가로 얹을 예정.
- Red Team 비평 루프는 **기존 mvp-planning에 내장**(새 워크플로우 추가 X) — acceptance Test 2의 "Workflows (4)" 개수 유지 위해. idea-validation 등 나머지는 선형 유지.
- 비평 루프 종료 조건 = critic 출력의 "### Critical" 리스크 소멸 OR max_rounds 소진. 무한루프 방지로 max_rounds 필수.
- priorFindings를 Map(upsert)로 변경 — 루프에서 agent 재실행 시 handoff 요약 중복/누적 방지, 순서 유지.
- 재생성 로직(v2-3)을 runStepWithRegen 헬퍼로 추출해 선형/루프 양쪽에서 재사용.
- CEO 게이트를 union에 `{gate}`로 추가(V2_KICKOFF 4번). full-predev에 내장(축소→pm, 검증→research), max_jumps로 무한루프 방지.
- 판정 추출(extractDecision)은 Main Judgment + Decisions 섹션만 검색 — 문서 전체 검색은 Input Summary의 역할설명("진행/축소/검증...")을 오탐하므로 금지.
- anthropic provider(A안): 프롬프트 빌더를 promptParts.ts로 claude-code와 공유(중복/drift 방지). 기본 모델 opus-4-8, 기본 provider는 mock 유지. 실제 유료 호출은 사용자 키 세팅 후 검증.

## 2026-07-07 (라이브러리화 방향)

- 하네스 배포 모델 = **설치형 라이브러리**로 전환 (사용자 의도: 하네스 하나에 서비스 쌓지 말고 서비스 레포마다 설치). 경로를 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(CWD, 데이터)로 분리.
- projects/<name> 구조와 --project 플래그는 **유지**(최소 변경, acceptance 보존). "레포=단일 프로젝트"로 --project 없애는 건 별도 결정으로 보류.
- npm publish는 하지 않음 — install-ready(git/로컬 설치)까지. 실제 배포는 사용자 결정.
- 사용자 원래 기획 = 에이전트 분리(FE/BE 전문화). 3층으로 분해: ①정적 전문화 에이전트 추가 ②동적 분리 게이트 ③Claude Code 병렬 실행 연동(v3). 실제 병렬 코딩은 하네스가 아니라 Claude Code 영역(하네스는 기획문서+task-prompt 생성기). 상세: [[v2-provider-decision]] 다음 방향.

## 2026-07-07 (동적 분화 B-② 구현)

- 동적 분화 = `{fanout}` step. planner가 SPAWN 형식으로 하위 에이전트 선언 → fanout이 파싱해 런타임 생성·실행.
- **하위 에이전트는 레포에 영구 등록하지 않음** — 런타임 AgentDef + 생성 브리프(agentPromptText)로 per-run 생성. private/read-only 패키지와 충돌 회피, "동적"의 본질에 부합.
- **사람 승인 게이트 유지**(ROADMAP 원칙): 기본은 계획만 기록(executed:false), `--allow-spawn` 있을 때만 실제 실행. 자동 무단 생성 안 함.
- ①정적 전문 에이전트 추가는 보류 — 동적 분화로 갈음. 실제 병렬 코딩(B-③)은 여전히 Claude Code 영역(v3).

## 2026-07-07 (B-③ 멀티에이전트 task-prompt)

- B-③ = task-prompt를 멀티에이전트 실행 스펙으로 확장. spawned_agents 있으면 FE/BE별 병렬 subagent 지시문 생성.
- **경계 결정**: 하네스는 실행 "스펙 생성"까지만. 실제 병렬 코딩은 Claude Code subagent가 **사람 승인 후** 수행. 하네스가 직접 코드 실행/세션 자동 spawn 안 함 (v1부터의 "코드 자동 실행 금지" + ROADMAP "사람 승인 게이트" 유지). Claude Code는 병렬 subagent 능력 이미 있음 → 하네스는 구조화된 handoff만 제공.
- 하네스→Claude Code 실행 자동 트리거는 신중히(보류). 승인 게이트 없이는 안 함.

## 2026-07-07 (Obsidian 연동)

- Obsidian 연동 = **run_state 기반 read-only export**. 원본 projects/ 파일은 건드리지 않고 vault에 사본(frontmatter+wikilink 부여) 생성 → 안전(비파괴), 재실행 시 vault만 갱신.
- **opt-in**: `--vault` 또는 `HARNESS_VAULT` 있을 때만 동작. 기본 파이프라인/acceptance 무영향. export 실패는 경고로만 처리(실행 결과 저장 우선).
- 노트 구조 = agent별 노트 + run 인덱스(MOC). wikilink는 실행 순서(completed_steps) 기반 이전/다음/인덱스 + MOC의 순서 링크. frontmatter tags(harness/workflow/project/moc)로 그래프뷰 군집화. → V2_KICKOFF "양방향 링크·그래프뷰" 충족.
- vault를 실행 트리거로 삼지 않음 — 어디까지나 결과 아카이빙/지식그래프 용도.

## 2026-07-07 (v2 범위 정합성 정리)

- **배경**: "v2 스펙"이 두 벌이었다 — ①ROADMAP.md의 v2 목록(v1 때 적어둔 희망 목록) vs ②V2_KICKOFF.md(실제 착수 계획: provider 전략 + 루프 3종 + Obsidian). **실제 개발은 V2_KICKOFF를 따랐다.** 스코프 락 원칙("backlog → 다음 버전 스펙 → 구현 순서로만 이동")상 V2_KICKOFF로 승격되지 않은 ROADMAP 항목은 미구현으로 남았다. 버그/누락이 아니라 승격 게이트 미통과.
- **결정**: 아래 ROADMAP v2 항목들을 지금 구현하지 않고 **명시적으로 보류**한다(문서에 상태 표기, ROADMAP "v2 포함" 범례 ✅/⚠️/⏸).
  - `token budget 상한/중단` — 예산 상한이 실제로 필요한 종량 API(anthropic) 경로가 아직 미사용/미검증. mock=무료, claude-code=구독(회당 과금 없음) → 필요 미발생. **anthropic 실사용 시작 시 재검토.**
  - `run --resume` — mock 즉시, claude-code ~10분 수준. 중간 실패 재개 실익이 아직 작음.
  - `step 사이 승인 게이트` — 코드가 실제로 산출물을 생성하는 유일 지점(분화)은 `--allow-spawn`으로 이미 승인 게이트 존재. 일반 step은 결과를 사람이 사후 검토 → 매 스텝 승인은 마찰만 큼.
  - `schema validation 강화(내용 길이/형식)` — 주 실패모드(섹션 누락)는 재생성 루프가 처리. 내용 품질 검증은 기준이 애매하고 ROI 낮음.
  - `prompt CHANGELOG` — 파일 내부 버전 헤더는 v1부터 존재. 별도 CHANGELOG는 필요 미발생.
- **사실상 달성(다르게 구현)**: Red Team 편향 분리 — handoff(priorFindings)가 각 agent의 결론(Main Judgment 한 줄, extractMainJudgment)만 전달하고 전체 추론 문서는 안 넘김. red_team 포함 모든 하류 agent가 결론만 봄. red_team 전용 로직은 아니지만 편향 분리 목적은 충족.
- **provider는 초과 달성**: ROADMAP은 "실제 provider 1개"였으나 3종(mock/claude-code/anthropic) 구현.
- 이 정리는 코드 변경 없음(문서 정합성만). 보류 항목은 실전 필요 발생 시 v2.5/v3 스펙으로 승격해 구현.

## 2026-07-07 (v3 킥오프 — 보류했던 안전장치를 v2.5 Phase 0로 재승격)

- **결정 반전**: 바로 위 "v2 범위 정합성 정리"에서 보류(⏸)했던 `run --resume` / `token budget` / `approval gate`를, V3_KICKOFF.md(Fable 5)가 v3 반자동 실행(`harness execute`)의 **선결 안전장치**로 재평가 → v2.5 Phase 0(0-1~0-3)으로 재승격해 구현했다.
- **사유**: v3-1(task prompt → Claude Code 반자동 실행)은 파일을 실제로 바꾸는 executor다. 그 전에 (a)실패 재개(resume), (b)토큰 상한(budget), (c)실행 직전 사람 승인(approval)이 없으면 안전하지 않다. v2 때는 "종량 API 미사용 + 매 스텝 승인 마찰"이라 보류가 타당했지만, **v3 실행 연결을 목표로 잡는 순간 이 셋은 선결 조건이 된다.** 보류 사유가 사라진 것 — 스코프 확장이 아니라 목표 변경에 따른 재평가.
- **Red Team 편향 분리(0-4) 강화**: v2에서 "사실상 달성(결론만 handoff)"으로 봤으나, critic이 **전체 findings 체인**을 보면 앞선 에이전트 합의에 anchoring된다. → critic 호출 시 target 결론만으로 격리(`contextMode=conclusion_only`, priorFindings 제한)해 명시적으로 강화. 일반 step은 full 유지.
- **스코프 락 유지**: V3_KICKOFF에 없는 기능은 추가하지 않았다(HARNESS_FAIL_AT/HARNESS_MOCK_TOKENS는 문서가 명시한 "강제 실패 stub" 검증 방식). 0-5 이후 Phase 1(도그푸딩)로 넘어가며, **실제 아이디어 2개 검증 전까지 v3 신규 기능(execute/report/security baseline) 미착수.**
- 검증: mock acceptance 57/57. anthropic 유료 실검증과 v2.5.0 태그는 사용자 액션으로 남김.

## 2026-07-08 (Phase 1 도그푸딩 결론 — v3.0 코딩 진입 보류)

- **v2.5.0 릴리스 완료** (develop→main, 태그+push).
- **Phase 1 도그푸딩 결과**: 하네스 핵심 파이프라인(게이트 두 분기·critique_loop·편향분리·분화+allow-spawn·승인게이트·토큰계측)이 실제 LLM에서 설계대로 작동함을 확인. 스키마 경고 0. 남은 이슈는 기능 결함이 아니라 **관측성**(진행률·되돌림 가시성·판정근거 기록).
- **결정: Phase 2(v3.0 코딩) 진입을 보류한다.** 근거 = 하네스 self-review(mvp-planning)의 red_team Critical: "v3 착수 조건은 '아이디어 2개 검증 + **개발 착수 1건**'인데 개발 착수 0건. 조건 미충족 상태로 v3 기능을 구현하면 하네스가 자기 진입 게이트를 어기는 첫 사례가 된다."
  - founder_ceo도 동일 판정: v3 첫 작업은 코드가 아니라 "실제 아이디어 1개를 기존 task-prompt로 개발 착수까지 손으로 완주"해 게이트를 채우는 것.
  - execute: 안전경계 시나리오("승인 게이트 이후 실패 시 롤백 주체")가 서지 않으면 만들지 않음. 현재 plan-only도 보류.
  - report: 관측성 통증이 실사용에서 수치로 확인된 뒤 최소형(스냅샷 표, 신규 의존성 0)으로만.
- **의미**: 도그푸딩이 "다음 코딩을 미루라"는 결론을 냈다는 것 자체가 하네스가 제 역할(순서 틀린 착수 차단)을 한 증거. 다음 코딩은 하네스가 아니라 실제 서비스 아이디어에서 나와야 함. 하네스는 v2.5.0으로 "충분히 좋다".

## 2026-07-08 (public 설치 + ux_ui 디자인 레퍼런스 확장)

- **dist 커밋으로 전환**: github 설치가 빌드 없이 동작하도록 `dist/`를 레포에 커밋(.gitignore 제거). 최신 npm이 install 스크립트(prepare)를 기본 차단하므로 prepare 빌드에 의존하지 않고 산출물을 직접 커밋하는 게 더 견고. build에 `chmod +x dist/cli.js` 추가(tsc가 644로 만들어 bin permission denied 발생하던 버그 해소). 소스 수정 시 `npm run build` 후 dist 커밋 필수.
- **ux_ui 역할 경계 = "디자인 방향 지시자", 픽셀 렌더러 아님**: headless `claude -p`는 웹검색·렌더링 불가하므로, ux_ui는 레퍼런스 소스·검색 키워드·비주얼 방향만 산출하고 실제 레퍼런스 수집(WebSearch)·화면 시안(Claude 아티팩트)은 다음 단계 Claude Code에서 수행. 기존 "아트 디렉터 아니다/최소 화면" 철학과 충돌 없이 확장(MVP-lean: 레퍼런스는 명확성·속도용, 과설계 금지).
- **task-prompt 디자인 실행 섹션**: 03_UX_FLOW.md 존재 시에만 조건부 추가 → idea-validation 등 UX 없는 워크플로우/acceptance 무영향.
