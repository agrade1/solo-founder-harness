# M10 T7 KICKOFF — codex 리뷰어 backend 마무리(`C-97`)

> 작성 2026-08-22. 이전 세션이 컨텍스트 한계로 끊으며 인계. **이 문서 하나로 착수 가능하게 썼다.**

## 0. 30초 요약

M10 T1~T6은 머지 완료(main = `ca3d549`). 지금 하는 일은 **`C-97`(무인 loop 안의 리뷰 왕복)** 하나다.
**codex 리뷰어 backend는 섰고 라우팅도 실측으로 확인했지만, live에서 리뷰어 turn이 worker 본문에
도달하지 못한 채 `plan_invalid`로 pause한다.** 원인을 한 걸음 남기고 끊었다.

- 브랜치 `work/m5c-autopilot` = PR **#61**(`pr/v3-m10-15-t7-codex-backend` · **OPEN · 커밋 2개**).
- 판정 정본: 로드맵 `M10 진행 판정 ⑥`(T6). **T7 판정 절은 아직 없다 — 이번 세션이 쓴다.**

## 1. 지금 서 있는 지반

| 항목 | 상태 |
|---|---|
| `src/exec/codexPlanWorker.ts` | **동작 확인됨** — 실제 codex(vendor 바이너리)로 직접 호출하면 `started→progress→terminal`이 나오고 계획이 유효하다 |
| 라우팅(`backendForRole`) | **실측 확인됨** — `review-* role=qa-security.* → codex-plan` |
| 격리 홈 계약 | codex-cli **0.146** 실측에 맞춰 확장(`cache`·`shell_snapshots`·`installation_id`·`models_cache.json`·`.sandbox_migration`·sqlite 패턴). **`plugins`·`skills`는 비어 있을 때만** 통과 |
| live `scripts/m10-live-t7.mjs` | **FAIL 4/8** — 저자(claude) 완주 · 리뷰어 3턴 `plan_invalid` |
| focused | codexPlanWorker 5 · codexCliProvider 69 · autopilot 51 = **125/125** · tsc clean |

## 2. 좁혀 둔 원인 (여기서부터 시작해라)

1. 라우팅은 정상이다(위 실측).
2. **worker 본문에 도달하지 않는다** — worker 안에 넣었던 디버그 출력이 한 번도 찍히지 않았다.
3. → 실패 지점은 codex 갈래의 **`kernel.approvedCodexWorker()`**(승인 홈·vendor 바이너리 재검증) 또는
   그 직후이고, 그 예외가 **marker 매핑에서 `plan_invalid`로 접히고 있다.**

**첫 두 걸음(둘 다 codex 왕복 0회)**
- `approvedCodexWorker()`를 live 값으로 직접 호출해 **실제 error code**를 본다(홈 `~/harness-codex-home`,
  바이너리 `.../@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`).
- `src/commands/autopilot.ts`의 marker 매핑이 `worker_backend_unapproved` 같은 코드를 `plan_invalid`로
  삼키는지 확인한다. **원인과 다른 marker가 나오는 것 자체가 `C-96` 부류이므로 함께 고친다.**

그 다음 `node scripts/m10-live-t7.mjs`를 다시 돌린다(claude 2 + codex 4 왕복 예상 · 둘 다 구독).

## 3. 이번 세션이 끝내야 하는 것

1. 위 원인 수정 → **live t7 8/8**(안 되면 되는 데까지 하고 **그대로 적는다**).
2. 로드맵에 **`M10 진행 판정 ⑦`** 절: 무엇이 증명됐고 무엇이 아닌지. `C-97`을 닫을 수 있으면 닫고,
   못 닫으면 **왜 못 닫는지**를 행에 적는다.
3. **대장 신규 `C-98` 등록**(아직 없다 — live 스크립트 본문만 이 id를 언급한다):
   "왕복 계약 검사가 loop 밖이다 — kernel이 리뷰를 안 거친 결과를 거부하지는 않는다."
4. `npm run build` → **dist 별도 커밋**(T7 dist는 아직 안 올렸다).
5. 전체 suite 1회(직렬) + 적대적 read-only 리뷰(fresh Fable 5 · live 금지) → 지적 반영 → PR #61 머지.

## 4. 재논의 금지 / 이미 정해진 것

- **승인 대상 codex는 vendor 플랫폼 바이너리**다. `~/.nvm/.../bin/codex`는 `#!/usr/bin/env node`
  wrapper라 닫힌 env(`CODEX_HOME` 하나)에서 `env: node: No such file`로 **아예 안 뜬다**(fail closed).
  감사 규칙 **R6**이 그 함정을 잡는다 — 그 설계를 되돌리지 마라.
- 자식 env는 **`CODEX_HOME` 하나**다. PATH·HOME을 더하지 마라(그것이 격리의 근거다).
- `--skip-git-repo-check`를 붙이지 마라. codex는 신뢰된 디렉터리를 요구하고 v3 workspace는 어차피
  승인된 checkout이다(live fixture는 `git init`으로 만든다).
- worker terminal 이벤트에는 **원본 계획 JSON**을 싣는다(정규화·동결 계획을 실으면 autopilot 재검증이
  닫힌 key 집합에서 걸린다 — 이미 한 번 겪었다).
- 리뷰어 role family는 `qa-security`. 승인에 codex 권위가 없으면 `worker_backend_unapproved`이고
  **조용한 claude fallback을 만들지 마라**(그러면 "리뷰어가 저자와 같은 엔진"이 조용히 성립한다).
- `~/harness-codex-home`의 `plugins`·`skills`는 `~/harness-codex-home-backup-20260822`로 옮겨 뒀다.
  되돌리려면 그대로 `mv`. 홈 계약은 그 두 디렉터리가 **비어 있을 때만** 통과한다.

## 5. 작업 방식(그대로)

A급(과대주장·거짓 성공 영수증·secret 유출) 즉시 수정 · B/C는 대장 기록 후 진행 · 테스트 완화·삭제 금지 ·
acceptance를 만들면 mutation으로 red 확인 · 리뷰는 구현자와 다른 fresh 세션(read-only · **live 금지**) ·
live는 실행 전 알리고 `auth_mode` 재확인(`~/.codex/auth.json` = `chatgpt` · `OPENAI_API_KEY` 없음) ·
suite와 live를 동시에 돌리지 마라(`C-88`) · PR 1000줄 이하 분할(소스/dist 분리) · `--delete-branch` 금지 ·
`git add -A` 금지 · `dist/exec/codexCliProvider.js`는 건드리지 마라.

## 6. 첫 명령

```bash
grep -n '| open |' docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md   # 대장 실상(문서보다 grep이 정본)
sed -n '1,40p' docs/CONTEXT_SUMMARY.md                                    # T7 현황 블록
gh pr view 61 --json state,commits
```
