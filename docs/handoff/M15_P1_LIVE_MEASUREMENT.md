# M15 `P1` — live 3단계 첫 계측 (2026-09-03)

> 인계문서 §3의 `P1`. **8 run 만에 3단계(`dev-preflight`)가 처음 완주했다.**
> 명령: `harness run dev-preflight --project _t_preflight --provider claude-code --allow-spawn --yes`
>
> **왜 이 workflow였나**: `dev-preflight`엔 게이트도 `founder_ceo`도 없다(F2) — **날조할 사업 판정이
> 애초에 없다.** 파이프라인을 건드리지 않아 `B-52`와도 무관하다. 그리고 `pipeline next`에는
> `--allow-spawn`이 없어서(F8) **fanout은 이 단독 경로로만 계측할 수 있다.**
>
> 산출물은 `projects/_t_preflight/`에 커밋했다. **계측 전용이고 사업 근거가 아니다** —
> 아이디어 문서 머리말에도 그렇게 적혀 있고, `chief_of_staff`가 그 사실을 Handoff Notes에 스스로 옮겼다.

## 1. 결과 한 줄

**7 step 전부 통과 · 하위 에이전트 4개 실제 실행 · 재생성 0 · 경고 0 · 19분 2초 · 571,844 토큰.**

| 항목 | 값 |
|---|---|
| status | `completed` (`failed_reason` 없음) |
| 완료 step | `tech_lead → spawn_indexer → spawn_search_api → spawn_web_ui → spawn_access_guard → red_team → chief_of_staff` + `approval` |
| 분화 | **4개 선언 → 4개 실행**(`executed=true`) — 상한 `max_agents=4`와 같은 수라 **조용한 잘림 없음** |
| 저장 파일 | 7개 (`04_TECH_PLAN.md` 17.6KB · spawned 4개 14.4~17.6KB · `chief_of_staff.md` 13.2KB) |
| 재생성 / 경고 | **0 / 0** — live 산출물 7건이 **전부 첫 시도에 헤더 계약을 만족했다** |
| 토큰 | in **499,021** / out **72,823** (합 **571,844**) |
| wall clock | **1,142.2초** (04:29:42Z → 04:48:44Z) |

**이 run이 처음 증명한 것**: SPAWN 선언 파싱 → 하위 에이전트 실제 실행 → 산출물 저장 → 다음 step이
그 판단을 이어받는 전 경로가 live에서 돈다. `--allow-spawn` 없이는 `executed:false` 계획만 남으므로
(F8) 7 run 동안 한 번도 확인되지 않았던 축이다.

## 2. 단계별 실측

| step | kind | 소요 | 입력 토큰 | 출력 토큰 |
|---|---|---:|---:|---:|
| `tech_lead` | agent | 154.0s | 77,087 | 9,596 |
| `spawn_indexer` | spawn | 109.6s | 69,800 | 6,487 |
| `spawn_search_api` | spawn | **282.3s** | 70,006 | **19,422** |
| `spawn_web_ui` | spawn | 205.8s | 70,324 | 12,921 |
| `spawn_access_guard` | spawn | 124.9s | 70,639 | 7,651 |
| `red_team` | agent | 137.6s | 70,535 | 8,347 |
| `chief_of_staff` | agent | 127.9s | 70,630 | 8,399 |
| `approval` | approval | 0.0s | — | — |

## 3. 계측이 드러낸 것 둘 (대장 등재)

### ⓐ fanout이 **직렬**이다 — 이 run의 39%가 순서 때문에 든 시간 (`C-152`)

**step 소요 합 1,142.2초 = wall clock 1,142.2초 (차이 0.0초)** — 겹쳐 도는 구간이 하나도 없다.

하위 에이전트 4개는 `tech_lead`의 계획을 **서로 독립적으로** 나눠 받은 것이고(각자 다른 focus,
서로의 산출물을 입력으로 받지 않는다) 그런데도 한 줄로 선다:

```
spawn 4개 합 722.6초 · 그중 최댓값 282.3초
→ 병렬이었다면 이 구간이 282.3초에 끝난다 (절감 440.3초)
→ run 전체 1,142.2초 → 약 702초 (**-39%**)
```

**지금 고치자는 말이 아니다.** 병렬 실행은 프로세스 회계(`maxProcessesPerRun`)·부분 실패 처리·
영수증 순서와 얽히고, 그 회계에 이미 열린 결함이 있다(`B-10` 계열). **비용을 수치로 남겨 두는 것이
이 항목의 목적**이고, 트리거는 "fanout 단계 시간이 실사용에서 문제가 될 때"다.

### ⓑ 입력 토큰의 **98%가 호출마다 반복되는 고정분** (`C-153`)

| 관측 | 값 |
|---|---|
| 에이전트별 입력 토큰 | 최소 **69,800** · 최대 **77,087** — 편차 **9.5%** |
| 7회 × 최소치 | 488,600 = 총 입력의 **98%** |
| 입력 : 출력 | **6.9 : 1** |

에이전트가 체인 뒤쪽으로 갈수록 입력이 커지지 않는다 — `priorFindings`는 한 줄 요약이라(F4) 거의
무게가 없고, **비용은 호출 횟수 × 고정 바닥**이다. 즉 **이 하네스의 토큰 비용은 사실상 "몇 번
부르는가"의 함수**이고, 산출물 길이나 체인 깊이가 아니다.

**정직한 한계 — 그 70k 안에 무엇이 있는지는 이 run으로 가르지 못했다.** 후보는 둘이고 둘 다
비어 있지 않다: ⓐ 하네스가 싣는 공통 프롬프트(`agents/common_agent_operating_prompt_v3.md`
22,515자 · **한글 49.9%**) + agent 프롬프트(`tech_lead_agent.md` 17,715자 · 한글 44.7%),
ⓑ `claude-code` provider가 CLI를 띄우며 붙이는 자기 system prompt·도구 스키마.
**둘을 가르려면 빈 프롬프트 1회 호출 대조가 필요하고, 그것은 하지 않았다.**

가른 뒤에 의미가 생기는 레버는 이미 알려져 있다 — 기계끼리 읽는 프롬프트를 영어로 바꾸면
**실측 1.46배**의 토큰을 되돌린다(레포 기존 규약). 위 두 파일은 machine-facing인데 절반이 한글이다.
**대조 없이 고치면 효과를 주장할 수 없으므로 대장에만 올린다.**

## 4. 계측이 **아닌** 것 (과대주장 금지)

- **사업 판정이 아니다.** `dev-preflight`엔 게이트가 없다. 이 run은 "구현 가능한가"에만 답했고,
  `chief_of_staff` 자신이 Handoff Notes에 *"5개 에이전트 중 누구도 '축소 후에도 쓸 만한가'에는
  답하지 않았다"* 고 적었다. 그 말이 맞다.
- **4단계(`dev-handoff`)는 여전히 0회다.** 그 단계는 workflow가 아니라 `task_prompt` 생성이라
  모델 호출이 0회이고(F3), 파이프라인 경로로만 도달한다. 이 단독 run은 거기 닿지 않는다.
- **파이프라인 상태기는 이 run이 재지 않았다.** `harness run` 단독 경로라 checkpoint·승인·drift가
  전부 무관하다(pipeline absent).
- **비용 대조군이 없다.** 첫 3단계 live라 "이 정도가 정상인지"를 잴 기준선이 이 run 자신뿐이다.

## 5. 재현

```bash
harness init _t_preflight                       # 그다음 docs/00_IDEA.md를 계측용으로 채운다
harness run dev-preflight --project _t_preflight \
  --provider claude-code --allow-spawn --yes    # --yes 없으면 approval_approver_missing으로 시작조차 안 한다
python3 - <<'PY'                                # 계측 추출
import json; d=json.load(open('projects/_t_preflight/outputs/run_state.json'))
print(d['usage']['input_tokens'], d['usage']['output_tokens'])
for t in d['step_timings']: print(t['agent_id'], t['kind'], t['elapsed_ms']/1000, t['ok'])
PY
```

**주의**: 이 프로젝트의 산출물은 gitignore 대상이 아니다. `git clean -fd`를 치면 사라진다 —
M14의 live 7 run 증거가 그렇게 사라졌다(판정 ⑯ ⓗ).
