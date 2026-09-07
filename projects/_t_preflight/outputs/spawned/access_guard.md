# Agent Output

## Metadata

- agent_id: spawn_access_guard
- agent_name: Access Guard Agent
- workflow_id: dev-preflight
- project: _t_preflight
- created_at: 2026-09-03T04:42:14.515Z
- provider: claude-code
- input_sources: docs/00_IDEA.md, 이전 agent 결과

## Input Summary

상위 tech_lead 계획에서 내 범위는 두 개다: ① 색인 allowlist 기본 거부(Decision 3, Critical 리스크 1), ② 프록시 SSO 헤더 검증 + `ADMIN_USERS` 게이트(Decision 5, High 리스크 1, 구현 순서 5단계). 형제 에이전트 셋 중 access 관련 접점은 indexer(어떤 경로를 읽는가)와 search_api(`POST /admin/reindex` 호출자 판정)이다. web_ui는 내 범위와 겹치지 않는다.

계획이 이미 못을 박아둔 것: 문서별 ACL 없음, 본문 반환 엔드포인트 없음, 사용자 테이블 없음, 관리자 판정은 환경변수 allowlist. 나는 이 결정들을 뒤집지 않고, **각각이 실제로 닫히는 지점**을 코드 수준으로 지정한다.

## Main Judgment

**두 게이트 모두 구현 가능하고 코드량은 100줄 미만이지만, 착수 전에 세 가지를 고쳐야 한다 — ① allowlist를 "`sources` 테이블에 등록된 경로"가 아니라 색인기가 읽는 별도 설정 파일(`sources.json`)로 두고 그 파일이 없으면 색인기가 실행 자체를 거부할 것, ② `X-Auth-User` 검증을 "헤더 존재 확인"이 아니라 "신뢰 경로로 들어왔음 + 헤더 형식 검증" 2단계로 할 것, ③ 프록시 없이 뜨는 것을 코드가 물리적으로 막을 것(`TRUST_PROXY_HEADER=1` 미설정 시 서버가 부팅을 거부).** ①은 DB를 관리자 권한 경계로 쓰는 실수를 막고, ②③은 tech_lead가 High로 분류한 "SSO 전제 붕괴"를 문서 경고에서 실행 불가 상태로 바꾼다.

## Key Findings

- **`sources` 테이블은 allowlist가 될 수 없다.** tech_lead 데이터 모델은 `sources.visibility`를 `company_wide` 고정으로 두었는데, 컬럼이 상수라면 그건 권한 판정이 아니라 장식이다. 더 중요한 문제는 쓰기 주체다 — `sources`는 색인기가 upsert하는 테이블이므로, 색인 대상 결정을 거기 두면 "색인기가 자기 권한 범위를 자기가 쓴다". 권한 입력은 색인기가 **읽기만 하는** 파일이어야 한다.
- **allowlist의 위험은 경로 지정이 아니라 경로 확장이다.** `/mnt/wiki/public`을 등록해도 그 아래 심볼릭 링크 하나가 `/mnt/hr`을 가리키면 인사 문서가 색인된다. `..` 정규화만으로는 안 잡힌다 — 링크는 정규화 후에도 allowlist 안에 있다. 실제 파일 경로(`realpath`)로 확인하는 게 필수이고, 이건 한 줄이다.
- **`X-Auth-User` 부재 시 401은 위조를 막지 못한다.** 프록시가 그 헤더를 **덮어쓰지** 않으면(또는 앱이 프록시 아닌 경로로도 접근 가능하면) 누구든 `curl -H 'X-Auth-User: ceo@company.com'`으로 관리자가 된다. 헤더 검증 코드는 위조를 못 막고, 막는 건 "프록시만 앱에 도달할 수 있다"는 네트워크 구성이다. 코드가 할 수 있는 일은 **그 구성 없이는 안 뜨게 하는 것**뿐이다.
- **`ADMIN_USERS` 비교는 문자열 비교 함정이 있다.** SSO가 주는 식별자의 대소문자·도메인 표기가 환경변수와 다르면 관리자가 자기 엔드포인트에서 403을 받고, 반대로 느슨하게 비교하면 `ceo@company.com.attacker.io` 같은 값이 통과할 수 있다. 정확히 일치 + 소문자 정규화 + 공백 trim 세 줄로 끝난다. 부분 일치·정규식·`startsWith`는 쓰지 않는다.
- **`ADMIN_USERS`가 비어 있을 때가 사고 지점이다.** 빈 문자열을 split하면 `['']`이 되고, 헤더가 빈 값으로 들어오면 통과한다. 빈 allowlist는 "전원 허용"이 아니라 "전원 거부"여야 하며, 이건 `.filter(Boolean)` 하나로 닫힌다.
- **내 게이트 둘은 실패 방향이 다르다.** allowlist 실패는 조용하다(문서가 새 나가고 아무 로그도 안 남는다). SSO 게이트 실패는 시끄럽다(관리자가 403을 받고 즉시 신고한다). 그래서 allowlist 쪽에만 검증 장치가 필요하다 — 색인기가 시작할 때 "이번에 색인할 루트 목록"을 stdout에 그대로 찍는 것. 관리자가 야간 로그 첫 줄만 봐도 범위 확장을 발견한다.

## Decisions

1. **allowlist는 `sources.json` 파일 하나다.** 색인기가 시작 시 읽고, 파일이 없거나 파싱 실패면 **색인 없이 종료(exit 1)**. 항목은 `{ "kind": "pdf_dir" | "wiki", "root_path": "...", "link_prefix": "..." }`. `sources` DB 테이블은 색인 결과 기록용으로만 남기고 권한 판정에 쓰지 않는다. `visibility` 컬럼은 삭제한다 — 상수 컬럼은 나중에 누군가 "여기 값 바꾸면 권한이 바뀌겠지"라고 오해할 함정이다.
2. **경로 판정은 `realpath` 후 경계 비교 한 함수로 통일한다.** 색인기가 파일 하나를 열기 직전마다 통과시킨다.
   ```ts
   // 권한 경계는 여기 한 곳뿐이다. 우회로를 만들지 말고 이 함수를 통과시켜라.
   // realpath 필수 — 심볼릭 링크는 경로 정규화 후에도 allowlist 안에 있다(링크가 /mnt/hr을 가리켜도).
   // 기각안: 문자열 startsWith만 — /pub 이 /public 을 통과시킨다. path.relative 로 경계를 본다.
   function isAllowed(filePath: string, allowedRoots: string[]): boolean {
     const real = fs.realpathSync(filePath);
     return allowedRoots.some(root => {
       const rel = path.relative(fs.realpathSync(root), real);
       return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
     });
   }
   ```
   기각: 커넥터별 자체 경로 검사. 검사가 두 곳에 있으면 한 곳은 반드시 낡는다.
3. **색인기는 매 실행 첫 줄에 색인 루트 목록과 항목 수를 stdout에 찍는다.** `INDEX SCOPE: 2 roots — /mnt/wiki/public, /srv/pdf/shared`. 범위 확장의 유일한 사후 탐지 수단이고 한 줄이다. 대시보드·알림은 만들지 않는다.
4. **API 서버는 `TRUST_PROXY_HEADER=1` 없이는 부팅을 거부한다(exit 1, stderr에 이유).** 이걸 켜는 행위가 "이 앱 앞에 인증 프록시가 있고, 그 프록시가 `X-Auth-User`를 덮어쓴다"는 운영자 서명이다. 로컬 개발(구현 순서 2~3단계)은 이 변수 없이 돌리므로, 그때는 인증 미들웨어 자체가 로드되지 않고 `127.0.0.1`에만 바인드한다. 기각: 기본값 켜짐 — 실수로 프록시 없이 배포하는 경로를 열어둔다.
5. **`X-Auth-User` 검증은 형식까지 본다.** 부재·빈 값·공백만·200자 초과·개행 포함(헤더 인젝션)·값 여러 개(배열로 들어온 경우) 전부 401. 통과값은 trim + 소문자로 정규화해 요청 컨텍스트에 싣는다. **DB에 저장하지 않는다**(tech_lead 결정: 사용자 테이블 없음, `search_log`에 식별자 없음 — 유지).
6. **`ADMIN_USERS` 게이트는 정확 일치 집합 비교다.**
   ```ts
   // 빈 allowlist = 전원 거부. .filter(Boolean) 없으면 [''] 이 되어 빈 헤더가 통과한다.
   const ADMINS = new Set(
     (process.env.ADMIN_USERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
   );
   const isAdmin = (user: string) => ADMINS.has(user);  // 정확 일치만. startsWith/정규식 금지.
   ```
   기각: DB 관리자 테이블 — 권한 상승 경로가 SQL 하나로 줄어든다. 환경변수는 배포 권한 없이는 못 바꾼다.
7. **`/healthz`는 인증 뒤에 둔다.** 문서 총 개수와 마지막 색인 시각은 사내 정보고, 프록시 뒤에 두는 비용이 0이다. 프록시 헬스체크가 필요하면 그건 TCP 연결 확인으로 충분하다.
8. **감사 로그는 관리자 액션 한 줄만.** `ADMIN reindex by <user> at <ts> — accepted|forbidden`. 검색 질의에는 사용자를 남기지 않는다(§5 유지). 기각: 전체 요청 감사 로그 — 사내 검색 이용 내역 자체가 민감하고, MVP에 그걸 보관할 이유가 없다.

## Assumptions

- 리버스 프록시가 클라이언트발 `X-Auth-User`를 **제거하거나 덮어쓴다**. 프록시가 헤더를 추가만 하고 기존 값을 통과시키면(설정 실수로 흔하다) 위조가 그대로 뚫린다. 확인 방법은 배포 후 `curl -H 'X-Auth-User: someone@x.com'`을 **프록시를 통해** 던져 401 또는 자기 계정으로 나오는지 보는 것 한 번뿐이다. 이 확인 없이 순서 5단계를 끝났다고 하지 않는다.
- 앱 포트가 사내망에서 직접 접근 불가하다(프록시만 도달). `TRUST_PROXY_HEADER=1`은 이 사실을 코드에 알려주는 신호일 뿐 강제하지 못한다 — 강제는 방화벽/바인드 주소가 한다. 그래서 프로덕션 바인드는 프록시가 붙는 인터페이스로만 한다.
- SSO가 주는 사용자 식별자가 요청마다 안정적이다(이메일 또는 계정명 고정). 세션마다 바뀌는 불투명 ID라면 `ADMIN_USERS`에 적을 값이 없어 게이트 설계를 다시 해야 한다.
- allowlist 경로에 대한 관리자 합의가 **문서로** 존재한다. tech_lead Handoff Notes대로 이건 조직 결정이고, 내 코드는 그 결정을 집행할 뿐 대신 정하지 않는다. `sources.json`이 없으면 색인기가 안 도는 설계가 이 합의를 강제하는 유일한 수단이다.
- 색인 대상 파일시스템에 심볼릭 링크가 있을 수 있다(사내 공유 폴더에서 흔하다). 없다고 가정하지 않는다.

## Risks

### Critical

- **프록시가 `X-Auth-User`를 덮어쓰지 않는 구성** — 이 경우 내 코드의 모든 인증·관리자 판정이 무의미해진다. 아무나 `ADMIN_USERS`에 있는 계정명을 헤더에 넣어 `POST /admin/reindex`를 호출할 수 있고, 재색인은 파일시스템을 읽는 동작이라 피해가 색인 범위 전체에 닿는다. 코드로 막을 수 없다 — 완화는 `TRUST_PROXY_HEADER` 부팅 게이트(운영자가 명시적으로 서명)와 배포 후 `curl` 위조 시험 1회뿐이다. **이 시험을 통과하지 못하면 배포를 되돌린다.**
- **allowlist 우회로 인한 미승인 문서 색인** — 심볼릭 링크, allowlist 루트 아래에 나중에 추가된 하위 폴더, `sources.json`을 코드 검토 없이 수정하는 경로 셋 다 같은 결과를 낸다. 첫 번째는 `realpath`로 닫힌다. 두 번째는 **닫히지 않는다** — 허용된 루트는 그 아래 미래 파일까지 허용하는 것이 정의다. 세 번째는 `sources.json`을 레포에 커밋해 git 이력으로 남기는 것으로만 완화된다. 유출은 롤백 불가(tech_lead 지적대로 본 사람의 기억은 되돌릴 수 없다).

### High

- **`TRUST_PROXY_HEADER=1`이 개발 편의로 켜진 뒤 그대로 남는 경우** — 로컬에서 한 번 켜고 커밋하면 게이트가 무력화되고, 그 사실이 눈에 보이지 않는다. 완화: 이 변수를 `.env.example`에 넣지 않고 systemd 유닛 파일에만 둔다. 코드 어디에도 기본값 `1`을 쓰지 않는다.
- **관리자 계정 식별자 불일치로 인한 우회 시도** — 관리자가 403을 받으면 게이트를 느슨하게 고치려는 압력이 생긴다(`toLowerCase` 넘어 `includes`로). 완화: 403 응답 시 서버 로그에 **받은 정규화 값**을 남긴다(`ADMIN denied: got 'CEO@Company.com' normalized 'ceo@company.com'`). 값이 보이면 환경변수를 고치게 되고, 비교 로직을 건드리지 않는다.

### Medium

- **`realpath` 실패로 인한 색인 누락** — 깨진 심볼릭 링크나 권한 없는 경로에서 예외가 난다. 기본 거부가 맞는 방향이지만, 파일 하나가 색인기 전체를 죽이면 야간 색인이 통째로 실패한다. 완화: `isAllowed`를 try/catch로 감싸 실패는 **거부 + 경고 로그**로 처리하고 다음 파일로 넘어간다(indexer 에이전트의 추출 실패 로깅과 같은 처리 방식).
- **`/healthz`를 인증 뒤에 둔 결과 외부 모니터링이 못 봄** — 색인 중단 무인지(tech_lead Medium 리스크)가 더 나빠질 수 있다. 완화: 프록시 레벨에서 이 경로만 통과시키는 예외를 만들지 **않고**, 관리자가 브라우저로 확인하는 것으로 둔다. 자동 모니터링이 실제로 필요해지면 그때 인증 없는 최소 응답(`{"ok":true}`, 개수 없음)을 별도 경로로 뺀다.
- **`sources.json` 파싱 성공 + 내용이 빈 배열** — 색인기가 정상 종료하지만 아무것도 색인하지 않고, `/healthz`의 `documents: 0`을 볼 사람이 없으면 조용히 빈 검색이 된다. 완화: 빈 배열도 exit 1로 처리한다(Decision 1의 "없으면 거부"와 같은 취급).

### Low

- **`ADMIN_USERS`에 오타로 존재하지 않는 계정만 든 경우** — 관리자 엔드포인트가 아무에게도 열리지 않는다. 실패 방향이 안전하고, 서버 시작 시 관리자 수를 로그에 찍으면(`ADMIN gate: 1 account(s)`) 바로 보인다.
- **헤더 이름 대소문자** — HTTP 헤더는 대소문자 무관이고 Node는 소문자로 정규화하지만, 프레임워크 없이 직접 다루면 실수할 수 있다. `req.headers['x-auth-user']`로 고정한다.

## Recommended Next Actions

1. **인프라 담당에게 프록시가 클라이언트발 `X-Auth-User`를 제거·덮어쓰는지 확인한다.** "SSO 있다"가 아니라 "이 헤더를 덮어쓴다"가 확인해야 할 명제다. 답이 "아니다" 또는 "모른다"면 tech_lead Assumption대로 OIDC 도입으로 순서 5단계 견적을 다시 잡는다 — 헤더 검증 코드는 이 답이 "그렇다"일 때만 의미가 있다.
2. **`sources.json`을 관리자 합의 결과대로 작성해 레포에 커밋한다.** 애매한 경로는 넣지 않는다. 이 파일이 없으면 색인기가 안 돌게 만드는 것이 Decision 1이므로, 이 커밋이 순서 1단계의 실제 시작점이다.
3. **`isAllowed` 함수와 그 테스트를 먼저 쓴다.** 케이스 5개: 루트 내부 파일 허용 / 루트 밖 파일 거부 / `..` 탈출 거부 / 루트 밖을 가리키는 심볼릭 링크 거부 / `/pub` 루트가 `/public` 파일을 거부(경계 오판). 색인기 코드보다 이게 먼저다 — 나중에 붙이면 이미 색인된 문서를 지우는 문제가 된다.

## Next Agent

(없음 — 이 workflow의 마지막 단계)

## Artifacts To Update

outputs/spawned/access_guard.md

## Handoff Notes

- **indexer 에이전트에게**: 파일을 여는 모든 지점이 `isAllowed`를 통과해야 한다. 커넥터마다 자체 경로 검사를 만들지 말 것(Decision 2). 그리고 `sources` DB 테이블을 색인 대상 결정에 쓰지 말 것 — 색인 루트는 `sources.json`에서만 온다. indexer가 제안한 단일 트랜잭션 방식(search_api의 수정안 포함)은 내 범위와 충돌하지 않는다: 트랜잭션 안에 들어가는 것이 `isAllowed`를 통과한 파일뿐이면 된다.
- **search_api 에이전트에게**: `POST /admin/reindex`의 판정은 `isAdmin(req.user)` 한 줄이고 그 앞에 인증 미들웨어가 이미 401을 처리한다. 엔드포인트 안에서 헤더를 다시 읽지 말 것. 403 응답 본문은 계약대로 `{"error":"forbidden"}` 고정 — 관리자 여부를 응답으로 흘리지 않는다(정보 노출 대신 로그에 남긴다, High 리스크 완화).
- **의도적으로 만들지 않은 것**: 문서별 ACL, 사용자·역할 테이블, 세션, 로그아웃, 토큰 갱신, 권한 관리 UI, 전체 요청 감사 로그, `sources.json` 편집 API, 인증 없는 `/healthz`. 도입 트리거는 각각 §Decisions와 §Risks에 적었다. 특히 **`sources.json` 편집 API를 만들면 안 된다** — 그 순간 색인 범위 변경이 배포 권한에서 HTTP 요청으로 내려온다.
- **가장 위험한 미검증 가정 하나만 고르면**: 프록시가 클라이언트발 `X-Auth-User`를 덮어쓴다는 것. 이게 틀리면 내가 쓴 인증·관리자 코드 전부가 장식이 되고, 그 사실이 코드만 봐서는 드러나지 않는다. 그래서 배포 후 `curl` 위조 시험 1회를 순서 5단계의 완료 조건에 넣었다 — 이건 문서 권고가 아니라 통과/실패 게이트다.
- 이 문서는 계측용 프로젝트 `_t_preflight`의 산출물이며, 사업 판단 근거로 사용하지 않는다.