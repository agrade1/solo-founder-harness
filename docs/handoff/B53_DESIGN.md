# B-53 설계 — 2단계 이후 연속 실패가 단계를 벽돌로 만든다

> 작성 2026-09-01. 구현 세션이 네트워크 중단·watchdog으로 두 번 끊겨 설계 문서를 못 썼다.
> **구현은 완주했고**(코드 주석에 논증이 남아 있다), 이 문서는 오케스트레이터가 그 구현과
> **직접 수행한 검증**을 근거로 사후 작성했다. 그 사실을 숨기지 않는다.

## 1. 실측한 현행

`src/commands/pipeline.ts`의 실패 분기가 매 실패마다 `last_failure.written`을 **통째로 덮었다**:

```ts
written: digestArtifacts(root, result.savedFiles, { skipMissing: true }),
```

`savedFiles`는 **그 attempt가 쓴 것만** 담는다. 그래서 두 경로로 정보가 사라진다:

- **ⓐ 게이트 실패**: agent가 하나도 안 돌아 `savedFiles`가 비고 `written`이 `[]`가 된다.
- **ⓑ resume**: 완료 step을 재실행하지 않으므로, 앞 attempt가 덮은 경로는 뒤 attempt의 `savedFiles`에 없다.

어느 쪽이든 다음 `next`의 사전 검증이 그 경로를 `[approved(앞 단계)]`로만 판정해
`pipeline_artifact_drift`로 거부한다.

**2026-09-01 live 실측(`_t_stages` 2단계)**: 2단계 `pm`이 1단계 승인 산출물 `docs/02_PRD.md`를
다시 쓴 뒤(`B-47`), 두 번째 실패(`ceo_decision_verify`)에서 `written`이 **0건**이 됐고 다음 resume이
`02_PRD.md`에서 drift로 막혔다.

**탈출구가 하나도 없다**(구현 세션 실측): `awaiting_run`에서 `restart`는 `pipeline_active`로,
`reject`는 `pipeline_no_pending`으로 거부된다.

## 2. 두 안과 선택

- **A. `savedFiles`가 비면 덮지 않는다** — 가장 작지만 **ⓑ를 못 고친다**(뒤 attempt가 *다른* 파일을
  쓰면 앞 파일이 여전히 사라진다).
- **B. 이 단계의 attempt들에 걸쳐 누적한다**(경로 합집합 · 새 digest가 이긴다) — **채택**.
  ⓐ·ⓑ를 모두 고친다.

## 3. 설계 (구현된 것)

```ts
const carry = state.last_failure?.stage === stage.id ? state.last_failure.written : [];
const merged = new Map(carry.map((w) => [w.path, w]));
for (const w of digestArtifacts(root, result.savedFiles, { skipMissing: true })) merged.set(w.path, w);
// ...
written: [...merged.values()],
```

`pipeline status`의 문구도 "직전 실패가 덮은" → "이 단계에서 덮인"으로 정정했다(누적이므로 옛 문구가 거짓).

## 4. `B-52`가 왜 안 깨지는가 (이 슬라이스의 핵심 제약)

`B-52`는 resume drift 예외를 **교체**로 바꿔(`accept = w ? [w] : [approved]`) 앞 단계 승인 바이트를
2단계 판정으로 재생하는 것을 막는다. 합집합이 그것을 되돌리지 않는 이유:

- 이번 attempt가 **쓴** 경로는 새 digest가 앞 것을 덮으므로(`merged.set`), 그 경로의 정본은 여전히
  **가장 최근에 그 경로를 쓴 attempt의 바이트 하나**다.
- 늘어나는 것은 **"이번 attempt가 안 건드린, 앞 attempt가 쓴 경로"** 뿐이고 그 정본도 하나다.
- **합집합 어디에도 앞 단계 승인 바이트는 들어오지 않는다** — `digestArtifacts(result.savedFiles)`는
  **이 단계가 실제로 쓴 바이트**만 담는다.

기존 `[B-52]` 재생 거부 테스트가 그대로 green이다(오케스트레이터 확인).

## 5. 2단계 이후 복구 경로 — 남는 것과 없는 것

| 경로 | 이 수정 후 |
|---|---|
| 무편집 resume(연속 실패 후) | **작동한다** (이 수정의 목적) |
| 사람이 `06_CEO_DECISION.md`의 `## Decision`을 고쳐 재개 | **여전히 막힌다** — 그 파일은 1단계 승인 산출물이면서 2단계가 다시 쓴 파일이라 편집 바이트가 승인·written 어느 쪽과도 안 맞는다. **`B-52`가 의도대로 작동하는 것이지 이 수정의 결함이 아니다.** |
| `restart` | `awaiting_run`에서 거부 |
| `reject` | pending이 없어 거부 |

즉 **`B-50`의 사람 검증 복구 레버는 1단계에서만 성립한다.** 이 슬라이스는 그것을 바꾸지 않는다.

## 6. 테스트 · mutation (오케스트레이터가 직접 수행)

신규 2건 — ⓐ 2연속 실패 후 3번째 resume이 drift로 막히지 않는다(재생은 여전히 거부) ·
ⓑ 서로 다른 파일을 쓴 2연속 실패에서 앞 attempt의 재작성을 잃지 않는다.

| mutation | 결과 |
|---|---|
| M1 누적 제거(매번 덮어쓰기 = 수정 전 동작) | **RED ×2** (신규 2건) |
| M2 단계 리셋 조건 제거 | **처음부터 GREEN** |

**M2는 도달 불가능한 방어 코드다.** 구현자가 주석에서 이것을 미리 예측했고, 오케스트레이터가
근거를 확인했다: 승인·폐기·restart가 `last_failure`를 null로 내리고(`pipeline.ts:127,661,802` ·
`core/pipeline.ts:458`), `replayProblem`이 checkpoint 단계 순서 불일치를 막는다
(`core/pipeline.ts:296-302`). **불변식이 다른 파일에 있어 이 파일의 조건은 이중 방어이며 테스트로
도달할 수 없다.** 가드는 유지한다(파일 간 방어 심층화).

## 7. 검증

typecheck 0 · `test:core` **677**(675 → +2) · `test:exec` 649 · acceptance 272.

## 8. 남는 위험 · 이번에 닫지 않는 것

- **`B-47`은 그대로다** — 2단계 `pm`이 1단계 승인 산출물을 다시 쓰는 것 자체는 바뀌지 않았다.
  이 수정은 그 뒤에 오는 **연속 실패의 벽돌화**만 막는다.
- **2단계 이후 사람 판정 교체 경로는 없다**(§5) — `B-52`의 의도다. 필요해지면 "단계 소유 판정 문서"
  같은 별도 축이 필요하다.
- `written`이 이제 단계 내내 자라므로 `pipeline_state.json`이 조금 커진다. 단계 승인·폐기·restart에서
  null로 내려가므로 무한 성장은 아니다. **크기 실측은 하지 않았다.**
- 설계 문서가 구현 **후**에 쓰였다 — 설계가 구현을 이끈 것이 아니라 구현을 기록한 것이다.
