# Agent Output

## Metadata

- agent_id: spawn_search_api
- agent_name: Search API Agent
- workflow_id: dev-preflight
- project: _t_preflight
- created_at: 2026-09-03T04:34:06.401Z
- provider: claude-code
- input_sources: docs/00_IDEA.md, 이전 agent 결과

## 스키마와 조회 SQL (이 에이전트의 산출물)

```sql
PRAGMA journal_mode = WAL;    -- 재색인 트랜잭션이 도는 동안에도 검색은 이전 스냅샷을 읽는다
PRAGMA busy_timeout = 5000;   -- search_log 쓰기가 재색인 쓰기 락에 부딪힐 때 대기
PRAGMA synchronous = NORMAL;

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, body,
  content='documents', content_rowid='id',
  tokenize='trigram'
  -- detail·columnsize 기본값을 바꾸지 말 것: snippet()은 detail=full, bm25()는 columnsize=1을 요구한다
);

CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body)
    VALUES('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body)
    VALUES('delete', old.id, old.title, old.body);
  INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
```

조회 (파라미터 바인딩만, 문자열 결합 없음):

```sql
-- results
SELECT d.id, d.title, d.url, d.updated_at, s.kind AS source,
       snippet(documents_fts, 1, char(1), char(2), '…', 64) AS snip
FROM documents_fts
JOIN documents d ON d.id = documents_fts.rowid
JOIN sources   s ON s.id = d.source_id
WHERE documents_fts MATCH :fts
ORDER BY bm25(documents_fts, 10.0, 1.0)   -- 값이 작을수록(더 음수) 좋은 매치. title 가중 10배
LIMIT :limit OFFSET :offset;

-- total (조인·정렬 없이 최소 형태)
SELECT count(*) FROM documents_fts WHERE documents_fts MATCH :fts;
```

`q` → `:fts` 변환 (앱 코드 6줄):

1. `trim` → **NFC 정규화** → 코드포인트 길이 1~200 검사
2. 공백으로 term 분리, 3코드포인트 미만 term은 버림 (trigram이 색인할 수 없음)
3. 남은 term이 0개면 `400 q_too_short`
4. 각 term을 `"` → `""` 치환 후 큰따옴표로 감싼다 → 공백으로 연결(FTS5 암묵 AND)
   - 이유: 사용자가 친 `AND` `OR` `NEAR` `*` `-` `"` 를 FTS5 질의 문법으로 해석시키지 않는다. 안 감싸면 500이 난다.

스니펫 XSS 처리 순서 (틀리면 사내 문서가 스크립트로 실행된다):

`snippet()`이 `char(1)`/`char(2)` 제어문자를 마커로 삽입 → 앱에서 문자열 전체 HTML 이스케이프 → 이스케이프에 영향받지 않은 제어문자 마커만 `<mark>`/`</mark>`로 치환. 응답의 `snippet` 필드는 **`<mark>` 외 태그가 없음이 보장된 HTML 조각**이며, web_ui는 이 필드에만 `innerHTML`을 쓴다.

## Input Summary

tech_lead 계획에서 내 소유는 FTS5 스키마·트리거, `GET /search`의 스니펫·랭킹·페이지네이션이다. 계약은 이미 고정돼 있다(`q`/`limit`/`offset`, `total` 포함 응답, 스니펫+링크만, 본문 미반환). indexer 에이전트는 "임시 테이블에 전부 쓰고 마지막에 교체"하는 전체 재색인을 결정했고, 이 결정이 external-content FTS5 트리거 설계와 직접 충돌한다 — 아래에서 다룬다. 인증(`X-Auth-User`)과 색인 allowlist는 access_guard 소유이므로 미들웨어 계약만 전제로 두고 재구현하지 않는다. 나는 SQLite를 실행할 수 없는 환경에서 판단했으므로, 버전·성능 관련 진술은 전부 검증 명령과 함께 남긴다.

## Main Judgment

**계약대로 구현 가능하되, 착수 전에 두 가지를 고쳐야 한다 — ① indexer의 "임시 테이블 교체"를 폐기하고 실제 테이블에 단일 트랜잭션으로 쓰게 할 것(SQLite 트랜잭션이 이미 원자성을 주므로 교체 기구는 문제를 두 번 푸는 것이고, external-content FTS5의 트리거·rowid 결합을 깬다), ② 색인·조회 양쪽에서 한국어 텍스트를 NFC 정규화할 것(NFD로 들어간 문서는 trigram에서 영원히 검색되지 않는다).** 이 둘은 코드 몇 줄이지만 지금 정하지 않으면 나중에 "검색 품질 문제"로 오진된다.

## Key Findings

- **임시 테이블 교체는 FTS5와 맞지 않고, 애초에 필요 없다.** `content='documents'`인 FTS5는 이름과 rowid로 원본 테이블에 묶여 있다. `documents_new` → `documents` 이름 바꾸기를 하면 (a) FTS 인덱스는 옛 rowid를 들고 있어 조인이 어긋나고, (b) SQLite 3.25+ 기본 동작에서 `ALTER TABLE ... RENAME`은 트리거의 테이블 참조를 함께 바꿔버려 트리거가 옛 테이블을 따라간다. 결국 매 재색인마다 트리거 재생성 + `'rebuild'`가 필요하다. 반면 `BEGIN IMMEDIATE; DELETE FROM documents; INSERT ×N; COMMIT;`은 **똑같이 원자적이고**(중간에 죽으면 통째로 롤백), 런타임 DDL이 0줄이며, WAL 아래에서 재색인 내내 검색은 이전 스냅샷을 일관되게 읽는다. indexer가 원한 보장("색인이 반쯤 비지 않는다")은 SQLite가 이미 주는 것이다.
- **한국어 2글자 질의는 trigram에서 결과가 0이다.** trigram 토크나이저는 3문자 시퀀스를 만들므로 2코드포인트 질의는 토큰이 하나도 생기지 않는다. 그런데 "회의", "예산", "규정", "인사", "채용", "계약"은 사내 검색에서 가장 흔한 질의 형태다. 조용히 빈 결과를 주면 사용자는 "이 검색은 안 된다"고 결론 내리고 떠난다. → `400 q_too_short`로 명시적으로 알린다.
- **NFC/NFD 불일치가 조용한 전멸을 만든다.** macOS에서 만들어진 PDF·파일명은 한글이 NFD(자모 분해)로 들어오는 경우가 흔하다. trigram은 코드포인트 단위이므로 NFD로 색인된 "회의록"(9 코드포인트)은 NFC 질의 "회의록"(3 코드포인트)과 **절대** 매치되지 않는다. 색인·조회 양쪽 `.normalize('NFC')` 두 줄이 전부지만, 빠지면 원인 추적이 며칠짜리다.
- **`INSERT OR REPLACE`를 쓰면 FTS 인덱스가 조용히 썩는다.** `PRAGMA recursive_triggers`가 꺼져 있으면(기본값) `OR REPLACE`가 지운 행에 대해 DELETE 트리거가 발화하지 않아, 삭제된 문서의 trigram이 인덱스에 남는다. 결과: 존재하지 않는 문서가 검색 결과에 뜨고 조인에서 사라진다. indexer는 `ON CONFLICT(source_id, external_id) DO UPDATE`만 써야 한다.
- **trigram에서 BM25 랭킹은 조정할 대상이 아니다.** "용어"가 3자 shingle이라 희소성 가중이 의미를 거의 잃는다. title 10배 가중 하나만 주고 멈추는 게 맞다. 순서 7단계 실사용 로그 없이 랭킹을 만지는 건 근거 없는 튜닝이다.
- **`snippet()`은 trigram에서 최대 약 66자다.** nToken 상한이 64이고 trigram 토큰 1개 ≈ 1문자(3자 중첩)이므로, 최대치를 줘도 한 줄짜리 스니펫이 나온다. 지금은 그대로 쓰고, 짧아서 못 쓰겠다는 판단이 7단계에서 나오면 앱 코드에서 `indexOf` 기반 ±80자 슬라이스로 갈아탄다(6줄).
- **검색 요청마다 발생하는 `search_log` 쓰기가 재색인 중 실패한다.** 재색인이 쓰기 락을 몇 분~수십 분 잡고 있는 동안 로그 INSERT는 `SQLITE_BUSY`로 죽고, 감싸지 않으면 그 시간 동안 검색 API 전체가 500을 낸다. 로그 쓰기는 try/catch로 삼키고 응답을 막지 않는다.

## Decisions

1. **재색인은 실테이블 단일 트랜잭션.** 임시 테이블 교체·런타임 DDL 없음. 트리거 3개가 FTS 동기화를 전담한다. 탈출구: 전체 삭제+삽입이 야간 창을 넘기면 그때(그리고 그때만) 한 트랜잭션 안에서 `트리거 DROP → 벌크 적재 → 'rebuild' → 트리거 재생성`으로 바꾼다(SQLite는 DDL도 트랜잭션 안에서 돈다).
2. **트리거를 유지한다.** `'rebuild'` 한 줄로 대체할 수 있지만, 트리거가 없으면 재색인 CLI 밖의 어떤 쓰기(수동 수정 한 건 포함)도 인덱스를 조용히 어긋나게 만들고 그 실패는 눈에 보이지 않는다. DDL 12줄로 "어긋날 수 없음"을 사는 거래다.
3. **`journal_mode=WAL`.** 재색인 중 검색 가용성의 유일한 근거다. 대가는 재색인 동안 WAL이 재작성 분량만큼 부풀어 디스크가 일시적으로 약 2배 필요하다는 것 — §Assumptions에 적었다.
4. **질의는 항상 인용 부호로 감싼 phrase term들의 AND.** FTS5 질의 문법을 사용자에게 노출하지 않는다. 고급 문법(`OR`, `NEAR`, 접두 `*`) 미지원.
5. **3코드포인트 미만 term은 버리고, 전부 버려지면 `400 q_too_short`.** 응답 스키마에 새 필드를 추가하지 않고 기존 400 에러 집합에 코드 하나만 늘린다.
6. **랭킹은 `bm25(documents_fts, 10.0, 1.0)` 고정.** 커스텀 스코어링·필드 부스팅·최신순 가중 없음. 도입 트리거는 7단계 실패 질의 로그.
7. **스니펫은 제어문자 마커 → HTML 이스케이프 → 마커 치환 순서로 서버에서 한 번만 만든다.** web_ui가 하이라이트를 재구성하지 않는다(두 곳에서 틀릴 기회를 하나로 줄인다).
8. **`offset` 상한 200.** 초과 시 `400 offset_too_large`. FTS5는 OFFSET을 위해 전체 매치를 정렬해야 하므로 깊은 페이지가 사실상 전수 스캔이다. 사내 검색에서 11페이지를 넘기는 사람은 없다.
9. **`total`은 계약대로 정확값을 반환한다.** 두 번째 `count(*)` 질의 비용을 감수한다. 느리다는 측정이 나오면 그때 `has_more` 불리언으로 바꾼다 — 측정 전에 계약을 바꾸지 않는다.
10. **재색인 끝에 `INSERT INTO documents_fts(documents_fts) VALUES('optimize')` 한 줄.** 벌크 적재 후 세그먼트 병합으로 조회 속도가 붙는다. 복구용 `'rebuild'`·`'integrity-check'`는 CLI 플래그로만 노출하고 HTTP 엔드포인트로 만들지 않는다.

## Assumptions

- 배포 환경의 SQLite가 FTS5와 **trigram 토크나이저**를 포함해 빌드돼 있다. trigram은 비교적 최근에 추가된 토크나이저라 오래된 배포판 SQLite에는 없을 수 있다 — 버전을 기억으로 단정하지 않고 §Next Actions 1번 명령으로 확인한다. 없으면 이 설계의 토크나이저 행 전체를 다시 정해야 한다(unicode61로 내려가면 한국어 부분 일치가 사라진다).
- `documents.id`가 `INTEGER PRIMARY KEY`(rowid 별칭)다. 아니면 `content_rowid='id'`가 성립하지 않는다.
- 텍스트 추출 단계에서 C0 제어문자(`\t`, `\n` 제외)가 제거된다. 제거되지 않으면 본문에 섞인 `char(1)`이 위조된 `<mark>`가 된다 — 스니펫 마커 방식의 유일한 전제이며 indexer 소유다.
- 문서 총량 수만 건·수 GB 텍스트. **trigram 인덱스는 원문 텍스트 대비 2~4배 크기가 나올 수 있다**(문자당 항목 1개 수준). 여기에 WAL 재작성 분량이 더해지므로 디스크는 원문 텍스트의 5~6배를 잡아둔다.
- `X-Auth-User` 검증 미들웨어가 `/search` 핸들러보다 앞에 있고, 없으면 401을 낸다(access_guard 소유). `/search`는 인증을 재구현하지 않는다.
- 색인 대상은 이미 allowlist로 걸러진 "전 직원 열람 가능" 문서뿐이다. 이 전제가 깨지면 `/search`는 조회 시점 필터가 전혀 없으므로 유출 장치가 된다.

## Risks

### Critical

- **조회 시점 권한 필터가 존재하지 않는다.** 설계상 `/search`는 `documents`에 있는 모든 행을 모든 인증 사용자에게 노출한다. 이건 버그가 아니라 결정된 구조이며, 따라서 **allowlist 실패가 곧 유출**이다. 내 계층에서 완화할 수단은 없다 — 본문 미반환으로 폭발 반경을 스니펫 66자로 제한하는 것이 전부다. allowlist 문서 확정 전에 `/search`를 사내망에 붙이면 안 된다.

### High

- **NFC/NFD 불일치로 특정 소스 전체가 검색 불능.** 확률이 낮지 않다(macOS 유래 PDF). 증상은 "일부 문서만 안 나옴"이라 검색 품질 문제로 오진되고, 원인이 인코딩이라는 걸 알아내기 전까지 랭킹을 튜닝하며 시간을 태우게 된다. 완화: 양쪽 NFC 정규화 + 첫 색인 후 알고 있는 한글 문서 3건을 실제로 검색해 확인.
- **indexer의 테이블 교체가 그대로 구현되면 인덱스와 본문이 어긋난 채 배포된다.** 검색은 결과를 돌려주지만 조인에서 행이 사라지거나 옛 문서를 가리킨다. 조용한 실패라 배포 후 며칠 뒤에 발견된다. 완화: 착수 전 indexer와 §Decisions 1을 합의한다. 합의 실패 시 교체 후 `'rebuild'` + 트리거 재생성을 **같은 트랜잭션에서** 강제하고, 재색인 직후 `'integrity-check'`를 CLI가 실행하게 한다.
- **`INSERT OR REPLACE` 사용 시 인덱스 오염.** 위와 같은 종류의 조용한 실패. 완화: `ON CONFLICT DO UPDATE`만 사용, 코드 리뷰 항목으로 고정.

### Medium

- **성능 목표(p95 < 500ms) 미검증.** trigram은 인덱스가 크고, 긴 질의는 trigram AND가 많아져 느려진다. 나는 실측 없이 판단했다. 완화: 첫 실제 재색인 직후 DB 파일 크기와 실제 질의 10개의 응답시간을 기록한다. 이 숫자가 없으면 §Assumptions의 규모 전제도 검증되지 않은 상태다.
- **스니펫 66자가 판단에 부족할 수 있다.** 사용자가 스니펫만으로 "이 문서가 맞는지" 판단하지 못하면 원문 링크를 열어보는 왕복이 늘고 체감 품질이 떨어진다. 완화: 7단계에서 이 항목을 직접 묻고, 필요하면 앱 코드 슬라이스로 교체.
- **재색인 중 `search_log` 쓰기 실패로 검색 API 500.** 완화: 로그 쓰기 try/catch + `busy_timeout`. 로그 유실은 허용한다(품질 신호이지 응답이 아니다).
- **랭킹이 사실상 조정 불가.** trigram + BM25는 "그럭저럭 맞는 순서"까지만 준다. 사용자가 원하는 문서가 3페이지에 있으면 개선 수단이 토크나이저 교체밖에 없고, 그건 전체 재색인과 설계 재검토를 뜻한다.

### Low

- **`search_log`의 질의 문자열 자체가 민감할 수 있다.** 사용자 식별자는 없지만 "○○○ 징계" 같은 질의는 그 자체로 정보다. 완화: 재색인 cron에 90일 초과 로그 삭제 한 줄. 지금 넣는 게 나중에 넣는 것보다 싸다.
- **깊은 페이지네이션 비용.** offset 200 상한으로 이미 닫혀 있다.
- **제어문자 마커 위조.** indexer가 C0을 제거하면 닫힌다. 제거를 확인하기 전까지는 열려 있는 구멍이다.

## Recommended Next Actions

1. **한 줄로 전제를 검증한다.** 배포 대상 환경에서 `sqlite3 :memory: "create virtual table t using fts5(x, tokenize='trigram'); select sqlite_version();"` 를 실행한다. 실패하면 trigram이 없는 것이고, 그 경우 §Decisions 전체가 아니라 토크나이저 선택부터 tech_lead와 다시 정해야 한다. 이 결과가 나오기 전에는 스키마 코드를 쓰지 않는다.
2. **indexer 에이전트와 §Decisions 1(교체 폐기, 단일 트랜잭션)과 `ON CONFLICT DO UPDATE`, NFC 정규화, C0 제거 네 가지를 합의한다.** 전부 각 몇 줄이지만 전부 조용한 실패를 만드는 항목이고, 스키마가 굳은 뒤에 바꾸면 재색인 전체를 다시 돌려야 한다.
3. **스키마 + `GET /search`를 인증 없이 localhost에서만 세우고, 한글 문서 20건으로 2글자·3글자·NFD 질의를 각각 쳐본다.** 이 세 케이스가 통과하면 이 계층은 끝난 것이고, 통과 못 하면 위 리스크가 실제로 터진 것이다.

## Next Agent

(없음 — 이 workflow의 마지막 단계)

## Artifacts To Update

outputs/spawned/search_api.md

## Handoff Notes

- **의도적으로 만들지 않은 것:** 커스텀 스코어링·필드 부스팅·최신순 가중, 검색어 하이라이트의 클라이언트 재구성, 자동완성·오타 교정·동의어, facet/필터(소스별·기간별), 커서 기반 페이지네이션, 결과 캐시, 별도 검색 서비스 계층 추상화. 각각의 도입 트리거는 §Decisions에 붙여뒀다 — 트리거 없이 되살리지 말 것.
- **다른 에이전트에게 넘기는 계약 4줄:** indexer는 (a) 실테이블 단일 트랜잭션, (b) `ON CONFLICT DO UPDATE`(`OR REPLACE` 금지), (c) 저장 전 NFC 정규화, (d) C0 제어문자 제거. web_ui는 `snippet` 필드에만 `innerHTML`을 쓰고 나머지 필드는 전부 `textContent`로 넣는다. access_guard는 `/search` 앞단에서 401을 낸다 — 핸들러는 인증을 보지 않는다.
- **내가 실행으로 확인하지 않은 것:** SQLite 버전·trigram 가용성, 재색인 소요 시간, 인덱스 크기, p95 응답시간, `snippet()`의 실제 한글 출력 길이. 전부 §Next Actions 1·3에서 처음 측정된다. 이 문서의 성능·크기 진술은 전부 미검증 추정이다.
- 이 판단은 계측용 프로젝트 `_t_preflight`의 산출물이며 사업 판단 근거로 쓰지 않는다.