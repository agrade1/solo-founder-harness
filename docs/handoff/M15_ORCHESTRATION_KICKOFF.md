# M15 KICKOFF — 오케스트레이션 세션 인계 (이 문서 하나로 착수 가능하게)

> 작성 2026-09-01. 직전 인계문서 `M14_ORCHESTRATION_KICKOFF.md`를 대체한다 —
> 그 문서의 §3 언어 규약과 §4 함정 22개는 **그대로 유효**하고 여기 §5가 승계·확장한다.
> **이 문서의 수치는 작성 시점 스냅샷이다.** 착수 전에 §7 명령으로 실측하라. **문서보다 실측이 정본이다.**

## 0. 30초 요약

M14가 남긴 한 줄: **`'검증'` 게이트 교착을 닫았더니(`B-50`) 그 수정 자체에 A급 구멍 둘이 있었다.**
전수 수색 워크플로가 **후보 26건 중 19건을 적대적 검증으로 확인**했고, 그중 **A급 4건**이
`docs/handoff/M15_DEFECT_SWEEP_REPORT.md`에 실측 시퀀스와 함께 있다.

**이번 세션의 1순위는 새 기능이 아니라 `A-1`·`A-2`다** — 직전 세션이 출하한 잠금에 뚫린 구멍이고,
그중 하나는 **하네스 자신의 복구 안내가 우회 경로를 지시**한다.

작업 방식은 M14와 동일: 계획은 **Fable 설계 세션 → Codex 계획 리뷰(영어) → Opus 구현(격리 worktree)**,
비평은 **Codex**(`gpt-5.6-sol` / 값싼 검증은 `gpt-5.5`), finding은 **실물 검증 후에만** 리비전 발행.

## 1. 지금 서 있는 지반

| 항목 | 값 |
|---|---|
| main | `56367b1` (M14b PR #110~#112 머지 완료) |
| **미커밋 8개** | `B-53` 수정 + `B-50/live` 수정 + 판정 ⓛ·ⓜ·ⓝ + `B-54` 등재 + CONTEXT_SUMMARY (§6 참조) |
| suite | typecheck 0 · `test:exec` **649** · `test:core` **677** · acceptance **272** |
| 대장 | A **0** · B **14** · C **102** · id **118** (자기 검증 실측) |
| M14에서 closed | `B-49` `B-46` `B-50` `B-52` `B-53` `C-125` `C-140` |
| live 표본 | **7 run · `'진행'` 판정 0회 · 4단계 완주 0회** |

### live 7 run 전적 (전부 claude-code + 실제 Tavily)

| project | 상태 | 게이트 판정 열 |
|---|---|---|
| `subcut` | killed | 검증 → **폐기** |
| `shiftpay` | killed | **폐기** |
| `commrep` | failed(소진) | 검증 → 검증 |
| `claimrep` | failed(소진) | 검증 → 검증 → 검증 |
| `sellercs` | failed(소진) | 검증 → 검증 |
| `nuga` | failed(**verify**) | 검증 ×4 — Codex 독립 판정도 `검증` |
| `_t_stages` | failed(**verify**) | 축소 → 검증 → 검증 (계측 전용 복사본) |

**`'진행'`이 7 run 중 0회다.** 다만 `nuga` CEO가 **폐기를 명시적으로 거부**하고 월 30만 원 목표를
정당하다고 인정했으므로, "기준이 도달 불가"보다 **"아이디어가 실제로 약했다"** 쪽으로 기운다. 미확정.

## 2. 작업 순서 (중요도순)

### 2.0 최우선 — `A-1`·`A-2`: 직전 세션이 출하한 잠금의 구멍

둘 다 `docs/handoff/M15_DEFECT_SWEEP_REPORT.md`에 **실측 재현 시퀀스**가 있다. 오케스트레이터가
코드로 재확인했다.

**`A-1` — 검증 잠금이 게이트 없는 workflow 한 번으로 지워진다.**
`ceoVerifyGateStatus`(`src/core/runWorkflow.ts:496-501`)의 판정 근거가 **`run_state`의 현재
`failed_reason` 한 필드뿐**이다. `run_state`는 새 run이 통째로 교체하므로, `harness run dev-preflight`
한 번이면(그 workflow엔 게이트도 `founder_ceo`도 없다) 잠금이 사라지고 `task-prompt`가 열린다.
`B-40`이 kill 잠금에서 **똑같은 공격**을 `kill_history` carry-forward로 막았는데 검증 잠금은 그걸 못 받았다.
**최소 수정**: transient한 `failed_reason` 대신 **decider 문서의 `## Decision` 토큰**을 본다
(`extractCeoDecision`이 `src/core/validate.ts`에 이미 있다).

**`A-2` — `'보류'`가 개발 표면을 열고, 하네스 자신의 안내가 사람을 그리로 보낸다.**
가드가 `ceo_decision_verify`만 막는다(`taskPrompt.ts:51`·`planDag.ts:151`). `'보류'`는
`ceo_decision_hold`로 끝나 **막히지 않는다.** 그런데 **M14가 쓴 복구 안내가 `'보류'`를 결론 판정의
하나로 권한다**(`run.ts:143`·`pipeline.ts:580`). 안내를 따르면 우회로 간다.
**최소 수정**: `A-1`과 같은 함수. **개발 표면을 여는 판정은 `'진행'` 하나여야 한다.**

### 2.1 그 다음 — 나머지 A급 둘 (파이프라인 실사용 전 필수)

- **`A-3`** kill 후 `pipeline restart`가 2단계 이상에서 **프로젝트를 영구 벽돌**로 만든다.
  `restartPipeline`이 `pipeline_state.json`만 rename하고 `run_state`(killed)를 손대지 않아, 이후
  모든 명령이 거부된다. **지금 레포에 killed 프로젝트가 둘 있다(`subcut`·`shiftpay`) — 거기서
  `pipeline restart`를 치지 마라.**
- **`A-4`** 2단계 이상 실행 중 **Ctrl-C/크래시** → 승인 바이트가 영수증 없이 덮여 영구 drift.
  `B-53`의 누적 `written`은 **영수증이 존재할 때만** 작동하므로 이 경로를 못 덮는다.
  **live 계측을 시작하는 순간 노출된다.**

### 2.2 그 다음 — B급 (전부 "live 3·4단계 계측 전"이 트리거)

보고서 PART 1의 B-1~B-8. 특히 **계측 전에 반드시**:
- **`B-1`** `token_budget_exceeded` 안내의 `--resume`이 소진 사용량을 복원해 **무한 재차단**
  (`C-138`과 같은 결함이 예산 하나 옆에 살아 있다). **계측에 `--max-tokens`를 쓸 거면 먼저 닫아라.**
- **`B-5`** `tokens.json` 추출이 "`## 디자인 토큰` 아래"가 아니라 **문서 전체의 첫 ```json 펜스**를
  가져간다. mock은 펜스를 1개만 내므로 **오프라인으로는 절대 안 잡히고 첫 live mvp-planning에서 터진다.**
- `B-2`(앞 단계 리서치 영수증을 자기 것으로 증언) · `B-3`(상한 검사가 **유료 호출 이후**라 resume마다
  크레딧 1회를 사서 버린다) · `B-6`(summary가 손상 state를 "미실행"으로 접는다) · `B-7`(`handoff`가
  run_state를 비원자적으로 덮는다 — `C-135`의 tmp+rename이 형제 writer에 미적용).

### 2.3 기존 열린 대장

`B-51`(**아이디어 문서로 게이트 심사 범위를 축소할 수 있다 — 실증됨**) · `B-54`(drift 안내가 제시하는
탈출구 둘 다 막혀 있다 — 거짓 안내 4번째) · `B-47` · `B-48`(트리거 도래) · `B-44`/`B-43` · `C-123`.

## 3. live 3·4단계 계측 — 코드로 확정한 방안

**7 run 동안 3·4단계는 한 번도 안 돌았다.** 보고서 PART 2가 코드 근거(F1~F9)와 함께 방안을 냈다.
핵심 사실 셋:

- **F2** `dev-preflight`에는 **게이트도 `founder_ceo`도 없다** → 날조할 사업 판정이 애초에 없다.
- **F3** `dev-handoff`는 workflow가 아니라 `task_prompt` 단계 → **모델 호출 0회**.
- **F8** `pipeline next`에 `--allow-spawn`이 없다 → **파이프라인 경로로는 fanout을 영원히 계측 못 한다.**

**권장 순서**: `P1`(단독 `harness run dev-preflight --allow-spawn`, 새 프로젝트, 최대 7 호출,
**판정 날조 0**) → `P2`(`task-prompt`, 무료) → `P4`(mock 파이프라인으로 상태기 층) →
`P3`(1단계 live가 필요할 때) → **A/B 수정 후** `P5`(전체 재실행).

**하지 말 것**(전부 코드로 확인됨):
- `subcut`·`shiftpay`에서 `pipeline restart` — `A-3`으로 영구 벽돌
- `awaiting_run` 프로젝트에서 직접 `harness run` — `pipeline_run_reserved` exit 2
- live 실행 중 Ctrl-C — 2단계 이상이면 `A-4`로 복구 불가
- 검증 정지 프로젝트에서 다른 workflow 실행 — `A-1`로 잠금이 지워진다

**`P5`를 열 때의 정직한 레버 하나**: `registry/workflows.json`의 `max_jumps`를 1 → 2로 올리는 것은
**판정이 아니라 되돌림 예산** 변경이라 `B-52`와 무관하고 CEO의 정직한 판정을 바꾸지 않는다.
`gate_jump_budget_exhausted`가 7 run 중 3회를 차지한 실측과 맞물린다. 레지스트리 변경이므로 승인 필요.

## 4. 절대 하지 말 것 (이 세션이 실제로 저지른 것)

**아이디어 문서에 판정 기준을 써 넣지 마라.** M14 오케스트레이터가 `00_IDEA.md`에
*"무료 대체재는 폐기 사유가 아니다 · 차별점을 요구하지 말 것"* 을 넣었더니 `chief_of_staff`가
지불의향·경쟁·차별점을 **"판정 대상에서 제외"** 하라고 하류에 전파했고 research·red_team이 수용했다
(Codex 사실검증 A급 = `B-51`). run을 중단시켜 거짓 영수증은 안 생겼다.

**경계**: 제약 제시("월 30만 원이면 성공으로 본다")는 정당하고, 결론 지시("이 리스크는 무시하라")는
조작이다. 사용자 선호를 전달할 때는 **"이 절은 CEO의 판정 기준을 대체하지 않는다 · 어느 결론도
선택할 수 있다"** 를 먼저 적어라(`projects/nuga/docs/00_IDEA.md`가 교정본이다).

## 5. 비싸게 배운 함정 (M14 22개 + 이번 셋)

M14 §4의 22개는 그대로 유효하다. 추가:

23. **권한에 막힌 Bash 호출 안의 heredoc은 파일도 안 만든다.** 다음 명령이 `"$(cat …)"`로 빈 문자열을
    넘겨 **Codex가 빈 프롬프트를 받고 "무엇을 도와드릴까요?"라고 답했다.** exit 0이라 조용히 실패한다.
    **프롬프트 파일은 만들고 크기를 확인한 뒤 넘겨라.**
24. **긴 작업의 산출물을 마지막에 한 번에 쓰면 중단 시 전부 잃는다.** 이번 세션에 설계 세션이 두 번
    끊겼고(네트워크 · watchdog) 두 번 다 문서가 0바이트였다. **서브에이전트에게 "확정된 절부터
    파일에 쓰고 이어 붙여라"를 지시하라.** 끊긴 agent는 `SendMessage`로 **맥락 그대로 재개**된다.
25. **안내는 읽지 말고 따라가 봐라.** `B-54`는 drift 메시지가 권한 두 탈출구를 **실제로 실행해 봤더니**
    둘 다 막혀 있어서 찾았다. 읽기만 했으면 그럴듯해 보였다. 거짓 안내가 이 레포에서만 **네 번째**다.

## 6. 미커밋 8개 — 먼저 정리하고 시작하라

```
src/core/runWorkflow.ts       B-50/live 수정 ('검증'은 매핑 유무 무관하게 사람 차례)
src/core/runWorkflow.test.ts  신규 1 + 형태 추적 2건 갱신 (커버리지 4종 → 5종)
src/commands/pipeline.ts      B-53 수정 (last_failure.written 단계 내 누적)
src/commands/pipeline.test.ts B-53 신규 2건
dist/ 2개                     재빌드
docs/backlog/...ROADMAP.md    판정 ⓛ·ⓜ·ⓝ · B-53 closed · B-54 신규
docs/CONTEXT_SUMMARY.md       갱신
```

**전부 검증 통과 상태다**(typecheck 0 · core 677 · exec 649 · acceptance 272). PR로 올리고
시작하는 것을 권한다. `docs/handoff/B53_DESIGN.md`·`M15_DEFECT_SWEEP_REPORT.md`도 함께.

**주의**: `B53_DESIGN.md`는 **구현 후에 오케스트레이터가 사후 작성**했다(구현 세션이 두 번 끊겼다).
설계가 구현을 이끈 것이 아니라 기록한 것이고, 문서 머리말에 그렇게 적혀 있다.

## 7. 착수 명령

```bash
git -C <repo> log --oneline -1
git status --short | grep -v '^??'                # 미커밋 8개 확인
npm run typecheck && npm run test:core            # 677 기대
awk '/^#### 현행 열린 항목 — \*\*정본\*\*/,/^#### 열린 유예 항목 \(2026-07-26/' \
  docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md \
  | grep -oE '^\| `[BC]-[0-9]+`|^C-[0-9]+|[[:space:]]C-[0-9]+' | tr -d '|` ' | sort -u | wc -l
sed -n '1,40p' docs/CONTEXT_SUMMARY.md
sed -n '1,60p' docs/handoff/M15_DEFECT_SWEEP_REPORT.md   # A급 4건이 맨 앞
codex exec -s read-only -m gpt-5.5 "OK만 답해라" < /dev/null   # stdin 닫기 필수
ls -la .env && grep -c 'TAVILY_API_KEY=.\+' .env
```

## 8. 이번 세션에 증명하지 못한 것 (정직하게)

- **live 3·4단계 0회** — §3의 `P1`이 가장 싼 길이다.
- **`'진행'` 판정 0/7** — 가설 ⓐ(아이디어가 약했다) vs ⓑ(기준 도달 불가)를 아직 못 갈랐다.
- **`B-53`은 앞으로만 작동한다** — 이미 벽돌이 된 `_t_stages`는 못 살린다.
- **`nuga`의 결정적 검증(액션 ①)은 사람만 할 수 있다** — 실제 단톡방 재공유율·실제 송금.
  Codex도 못 했고 지어내지 않았다. `projects/nuga/docs/07_HUMAN_VERIFICATION.md` 참조.
- **워크플로 19건 중 오케스트레이터가 직접 재확인한 것은 `A-1`·`A-2` 둘뿐**이다. 나머지 17건은
  **적대적 검증은 거쳤으나 오케스트레이터 재검은 없다** — 리비전 발행 전에 실물 확인하라.
