# M12 KICKOFF — 오케스트레이션 세션 인계 (이 문서 하나로 착수 가능하게)

> 작성 2026-08-26. 직전 인계문서 `M11_ORCHESTRATION_KICKOFF.md`를 대체한다(그 문서의 §4 함정 여섯은
> 여전히 유효 — 여기 §4가 승계·확장한다). **이 문서의 수치는 작성 시점 스냅샷이다** — 착수 전에
> §6의 명령으로 실측하라. 문서보다 실측이 정본이다.

## 0. 30초 요약

**작업 방식(사용자 지시 2026-08-25 + 2026-08-26)**: 오케스트레이터 세션(Fable 5)이 명령·취합·docs·
통합·PR·live를 맡고, **구현은 Opus 5 격리 worktree 서브에이전트**가, 개선도 다시 Opus로.
**비평 루프는 Codex로**(2026-08-26 추가 지시): 적대적 리뷰는 `codex exec -s read-only`(이 기계에
로그인돼 있다 · 기본 `gpt-5.6-sol` high), 모델은 사안 무게별 — Fable/Opus 5/Codex 5.5/5.6.
오케스트레이터는 Codex finding을 **실물 검증(triage)** 후 리비전을 발행한다. **사용량 ~85%에
도달하면 작업을 정리하고 새 세션으로 이동**(사용자 지시 2026-08-26).

지반: **A 0 · 강제 잔여 없음.** M10 완료(오케스트레이션 기계) 위에 M11~M12가 얹은 것 —
live가 **실제 산출물을 만들고**(판정 ⑦) 아이디어에서 **DAG 초안을 뽑고**(판정 ⑧) **문서 단계
4종 산출물을 완성했다**(판정 ⑩ · 12–31KB 문서 4건 · 삼중 hash).

## 1. 지금 서 있는 지반 (2026-08-26 작성 시점)

| 항목 | 값 |
|---|---|
| `main` | 판정 ⑫까지(B-40 kill 게이트 · B-41 단계 체크포인트 — 착수 전 `git log`로 실측하라) |
| suite | `test:exec` 649 · `test:core` 580 · acceptance 272 — 전부 green |
| 열린 대장 | A **0** · 등급 B **10** · 등급 C **98** · id **108** |
| 판정 정본 | 로드맵 `M12 진행 판정 ⑫` (새 판정은 그 **위에** 삽입하고 "현행" 문구를 갱신하라) |
| live 실측 | 판정 ⑦(단일 task 산출물) · ⑧(12-task DAG 초안) · ⑨(multi-task 부분) · ⑩(**문서 단계 4종 완성**) · ⑪(kill 게이트 — v1 층이라 mock로 충분 · live 0회) |
| 작업 방식 | 구현 **Opus 5** · 비평 **Codex**(`-m gpt-5.6-sol` 무거운 계약·안전 / `gpt-5.5` 값싼 리뷰). Codex finding은 오케스트레이터가 **실물 검증 후** 리비전 발행 |

**사용자의 목표**: 새 레포에 아이디어 문서를 두면 기획→리서치→검증→디자인→개발까지 도는 하네스.
Opus 5가 개발, Fable(+Codex)이 비평 루프. MVP부터 그 뒤까지.

**파이프라인 현황**: ①아이디어(사람) → ②승인(사람) → ③`plan-dag`+`autopilot`(하네스 · live 증명) →
④`validate-dag`+사람 검토 → ⑤**실행 승인(사람 · 지금 제일 무겁다 — L2b가 이걸 푼다)** →
⑥`autopilot-create`+`autopilot`(하네스 · 단일 task 산출물까지 live 증명).

## 2. 진행 중 / 다음 순서 (사용자 승인된 추천 순서)

1. ~~L2b~~ → 착지(판정 ⑨). ~~C-117~~ → **closed**(판정 ⑩ — 결정 ⓐ 구현·live 검증 · 문서 단계
   4종 산출물 완성 · ⓑ는 `C-122`로 유예).
2. **1순위 = 값싼 CLI slice**: `C-118`(resumeTask CLI — 두 세션 연속 스크립트로 때움) ·
   `C-120`(validate-approval에 audit 배선) · `C-124`(diagnostic을 사람용 렌더러에 노출) 묶음.
3. **명확화된 목표(2026-08-26)의 최소 골격 3개 중 둘이 닫혔다** — ~~`B-40` kill 게이트~~(판정 ⑪) ·
   ~~`B-41` 단계 체크포인트~~(판정 ⑫). **남은 1순위 = `C-126`**(리서치 API + `.env`): 설계 개정 2가
   Codex A 10 + B 4를 반영해 끝났고(`TAVILY_API_KEY` 단일 allowlist · `process.env` 불변경 · tracked
   `.env`면 키 읽기 거부 · self는 키 부재에만 · 1차 미commit 후 최종 1회 · 저장 전 secret redaction ·
   attempt별 evidence snapshot 결박), **B-41 착지본과 재대조(integration gate)가 구현 전 필수**다.
   그 뒤 ② `C-127`(v1 검증 차단) ③ `C-125`(아이디어 개정 루프) ④ `C-123`(consumes 계약) ·
   `B-44`/`B-43`(exec·mission·autopilot 게이트). 이하 옛 항목: ① ~~`B-41`~~: "단계 완료 → 사용자에게
   문서 확인 요청 → 승인 대기 → 다음 단계 자동 준비". 설계 방향(오케스트레이터 확정): v1 안의
   `approval` step을 층간으로 확장 · durable 상태는 `projects/<name>/outputs/pipeline_state.json` ·
   **승인 행위는 별도 명령 호출**(비대화 환경에서도 감사 가능) · killed면 파이프라인 종료 ·
   개발 단계는 `mission`/`exec` 명령을 **준비만** 한다(자동 실행 금지) ② `C-126`(research adapter
   production 배선 + `.env` — `tavilyBackend`/`researchGateway`는 이미 완성형이라 배선만) ③ `C-127`
   (v1 검증 차단) · `C-125`(아이디어 개정 루프) · `C-123`(consumes 계약). 기존 후보(L5b · `C-93` ·
   `B-10`)는 그 뒤.
4. live 재실측 시 workspace·승인 생성기는 **세션 scratchpad에 새로 만든다**(세션 종료 시 소멸 —
   실물 예시는 판정 ⑦·⑧·⑩ 시퀀스와 `scripts/m12-l2b-offline-acceptance.mjs`가 정본).

### 2.1 설계 문서는 세션 scratchpad에 있다 (인계 주의)

`B-41`·`C-126`의 설계 문서는 오케스트레이터 세션의 **scratchpad**(`.../scratchpad/B41_DESIGN.md` ·
`C126_DESIGN.md`)에 있었고 **세션 종료 시 사라진다**. `B-41`은 착지했으므로 결정·근거·기각 대안이
`M12 진행 판정 ⑫`와 코드 주석·커밋에 남아 정본이 옮겨졌다. **`C-126`은 아직 설계 단계다** — 그
설계가 승인되면(Codex integration gate 통과) **`docs/handoff/C126_RESEARCH_ADAPTER_DESIGN.md`로
영구화한 뒤** 구현에 넘긴다. 그 파일이 없고 scratchpad도 없으면, 아래 압축 요약이 남은 전부다:

- `.env`는 workspace 루트 단수 · `harness init`이 0600 템플릿 생성 + `.gitignore` managed block 멱등
  추가 · **이미 추적 중인 `.env`면 키를 읽지 않고 거부**(회전·`git rm --cached` 안내 · history 정리는
  주장하지 않는다) · `git check-ignore`로 부정 규칙(`!.env`)까지 판정.
- 리더는 신규 `src/core/envFile.ts`(의존성 0) · **`TAVILY_API_KEY` 단일 allowlist** ·
  **`process.env`를 변경하지 않는다** · 값은 research config로만 운반해 `createTavilyBackend({apiKey})`에
  전달(자식 프로세스 env에 키가 실리지 않는 것이 테스트 계약).
- fallback: **self는 키 부재에만**. 외부 시도 실패는 **resumable failed**(원인별 사유 코드) —
  "실패해도 계속"은 **사용자 결정 대기**. mode 4종 + bounded `attempts[]` · `external`은 evidence ≥1.
- 배선: 1차 문서 + `RESEARCH_REQUEST`(없으면 `none` 종결자 필수) → gateway → 2차에 **1차 전문+hash**
  전달 → **commit은 최종 1회**(단 usage·warning은 호출마다 기록). **extract는 봉인**(allowlist 정본을
  아무도 갖지 않는다) · search만.
- 결박: **content-addressed raw + 불변 attempt receipt**를 checkpoint manifest에 넣고
  `evidence.jsonl`은 **비권위 인덱스**(append가 drift가 되지 않게).
- 예산(byte 단위): seed 16,384(B-41 계약 불변) · evidence digest 16,384 · 2차의 1차 문서 32,768 ·
  초과는 **자르지 않고 fail closed**.
- 증거 문구: "Tavily **스니펫**", "저장 **응답 바이트** hash" — 웹 원문 검증이 아니다.

## 3. 작업 loop (실측으로 다듬어진 현행)

```
① 슬라이스 정의(오케스트레이터) — 경계·헌법을 프롬프트에 명시. C-116 형식의 mutation 보고 요구
② Agent(model:"opus", isolation:"worktree")로 구현 — 커밋을 남기게 하라
③ 보고 취합 → 비평 2단: ⓐ 오케스트레이터가 핵심 주장 재검 + mutation 최소 1종 독립 재현
   (복원은 정확한 역치환으로만 — git checkout은 다른 변경까지 지운다)
   ⓑ **Codex 적대적 리뷰**(`codex exec -s read-only` · 깨야 할 지점 명시 · A/B/C 요구 — 사용자
   지시 2026-08-26). Codex finding은 **실물 검증 후** 수용한다(판정 ⑩ 첫 적용: A 4건 전부 실물)
④ cherry-pick(커밋이 있으면) 또는 patch(없으면) → typecheck → 신규 acceptance 직접 실행
⑤ npm run build → npm test 전체 1회(배타 · 오케스트레이터만) — 부하 민감이니 live와 겹치지 마라(C-110)
⑥ live 실측(오케스트레이터 직접 · 승인 파일은 scratchpad 생성기로) → 삼중 hash 검증
⑦ docs: 판정 절(증명/미증명 같은 무게) + 정본 대장 갱신 + CONTEXT_SUMMARY 최신 블록
⑧ PR 스택(src / docs / dist 분리 · 1000줄 규칙) → 스택 트리 == 통합 트리 확인 → 순서 머지
   (--delete-branch 금지 · 뒤 PR은 base를 main으로 edit 후 머지)
```

## 4. 비싸게 배운 함정 (M11 여섯 + M11⑥~⑧ 추가분)

M11 킥오프 §4의 여섯(대장 처방 불신·grep 정본·사용자/내 판단 분리·트리거 전 조이지 않기·
mutation red 아니면 결함·미증명은 오케스트레이터가 닫기)은 그대로 유효. 추가:

7. **한 id의 상태는 "가장 늦은 등재 행"이 아니라 "가장 늦은 판정 절"이 정한다.** 리비전 표는 그 날짜의
   스냅샷이다. `B-16` 오진(판정 ⑥)이 이 함정의 실물 — 닫힌 항목을 열린 것으로 편입했다가 되돌렸다.
8. **배송 상태도 주장이다.** 커밋 안 된 작업물을 두고 리뷰를 돌리면 "정정했다"는 주장 자체가 거짓이 된다
   (M11⑤ 리뷰 A-1). 구현 세션에게 커밋을 요구하고, 리뷰 대상 범위를 작업 상태와 맞춰라.
9. **mutation red 보고는 fixture가 그 mutation을 잡을 수 있는지가 선행 조건이다**(`C-116` · 판정 ⑧ ⓒ —
   236B fixture에서 slice(0,2000)은 no-op인데 "RED 4건"으로 보고됐다). 프롬프트에 C-116 형식
   (무엇을 바꿨나 · fixture의 어떤 값이 그 경로를 지나나 · red 단정 이름+메시지 원문)을 요구하라.
10. **사실이 바뀔 때 앞 문장을 안 고치면 문서가 서로를 반박한다** — 이 형태를 M11에서만 다섯 번 잡았다
    (schema 상한 · "codexHome만 선택" · "claudeHome 필수" · "typed write는 바이트를 못 만든다" ×2).
    정정할 때는 낡은 문장을 grep으로 전수 수색하라.

## 5. 대장 정본 읽는 법

`grep -E '\| open \|'`로 **세지 마라**(스냅샷 중복). 정본은 §9.1 **`현행 열린 항목 — 정본`** 절이고
자기 검증 명령이 그 절 안에 있다. 등급 B **10**: `B-10` `B-13` `B-34` `B-35` `B-36` `B-37` `B-39`
`B-42` `B-43` `B-44` — 전부 트리거 미도래(`B-40`·`B-41`은 판정 ⑪·⑫에서 closed). `C-116`은 구현 프롬프트마다
반영(§4-9 · 판정 ⑪까지 mutation 15종이 이 형식으로 red).

**닫힌 id를 정본 절 표에 남기지 마라**: 자기 검증 명령이 그것을 열린 것으로 센다(판정 ⑪에서 실측 —
`B-40` 행이 남아 106이 107로 나왔다). 등재 이력은 판정 절과 git이 갖는다(§4-7).

## 6. 착수 명령

```bash
git -C <repo> log --oneline -1                    # main 확인
awk '/^#### 현행 열린 항목 — \*\*정본\*\*/,/^#### 열린 유예 항목 \(2026-07-26/' \
  docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md \
  | grep -oE '^\| `[BC]-[0-9]+`|^C-[0-9]+|[[:space:]]C-[0-9]+' | tr -d '|` ' | sort -u | wc -l
sed -n '1,40p' docs/CONTEXT_SUMMARY.md            # 최신 블록
grep -n '^##### \*\*M1[12] 진행 판정' docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md | head -1
```

## 7. 서브에이전트 프롬프트 뼈대

M11 킥오프 §7의 뼈대를 그대로 쓰되 세 가지를 더하라:
- **"논리 단위로 커밋을 남겨라"**(§4-8)
- **C-116 형식의 mutation 보고 요구**(§4-9)
- 구현 세션 live 금지 · live는 오케스트레이터가 승인 파일 생성기(scratchpad)로 직접. 승인 파일 실물
  예시는 `scripts/m12-l2a-offline-acceptance.mjs`의 `manifest()`와 판정 ⑦·⑧의 시퀀스가 정본.

## 8. 세션 이동 시 (사용자 지시)

사용량 ~85%에서: ⓐ 진행 중 서브에이전트가 있으면 보고를 받아 통합까지 마치고 ⓑ 이 문서의 §0~§2
수치·상태를 갱신하고 ⓒ CONTEXT_SUMMARY 최신 블록을 갱신한 뒤 ⓓ 커밋·머지하고 새 세션에게
"`docs/handoff/M12_ORCHESTRATION_KICKOFF.md`를 먼저 읽어라"로 넘긴다.
