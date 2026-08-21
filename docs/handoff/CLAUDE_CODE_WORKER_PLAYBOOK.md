# CLAUDE_CODE_WORKER_PLAYBOOK.md — Claude Code 구현 세션 운영 표준

이 문서는 **세션 운영 절차**만 적는다. 장기 고정 규칙(아키텍처 유지, hard deny, 활성 설계 문서 우선순위,
finding A/B/C 분류, 테스트 비례 원칙, 병렬 세션 안전 조건)은 루트 **`AGENTS.md`** 가 정본이며 여기서
복제하지 않는다. 진행 사실·마일스톤 판정은 `docs/handoff/CODEX_HANDOFF.md`,
`docs/WORKLOG.md`, `docs/CONTEXT_SUMMARY.md`를 본다. 유예 대장은 로드맵 §9.1이다.

작성 기준: 2026-07-27 (M4a~M4c 세션에서 실제로 통했던 절차를 그대로 적었다).

---

## 1. 세션 시작

1. **구현·리비전은 항상 fresh Claude Code Opus 5 세션**이다. 이전 세션 컨텍스트를 이어받지 않는다
   (근거: `AGENTS.md` fresh context 규칙).
2. **Pony Tail SKILL.md를 부분이 아니라 전체로 읽고**, 스트림에 **정확한 파일 경로와 적용 레벨**을 보고한다.
   예: `/Users/<user>/.claude/plugins/cache/ponytail/ponytail/<version>/skills/ponytail/SKILL.md`, level `full`.
   그 파일이 없거나 읽히지 않으면 **아무것도 수정하지 않고 종료**한다.
3. 스트림 첫 보고에 `git branch --show-current` · `git rev-parse HEAD` · `git status --short --branch`를 넣는다.
4. **소유 파일과 금지 파일을 그 자리에서 재확인**한다. 목록에 없는 파일은 편집·stage·commit 대상이 아니다.

## 2. 격리와 파일 소유권

- 세션마다 **격리된 git worktree 1개 + 전용 브랜치 1개**. 원본 checkout은 읽기 전용으로만 접근한다.
- **worktree 하나에 writer 한 명.** 여러 세션을 병렬로 돌릴 때 파일 소유권은 **명시적이고 disjoint**해야 한다.
- **공유 API/schema가 확정(freeze)되기 전에는 병렬 writer를 쓰지 않는다.** 공유 schema/API 변경 · 통합/병합 ·
  상태 마이그레이션 · 최종 전체 테스트 · 배타 자원/stress/live 테스트는 **직렬**이다(`AGENTS.md`).
- 공유 dirty 체크아웃에서의 즉시 리비전은 **단일 세션**으로 한다.

## 3. 표준 Claude CLI 호출

```bash
claude --model opus --effort high -p \
  --output-format stream-json \
  --verbose \
  --permission-mode acceptEdits \
  --setting-sources user,project,local \
  --strict-mcp-config \
  --mcp-config <empty-config.json>
```

- **`-p --output-format stream-json`은 `--verbose`가 필수다**(없으면 CLI가 거부한다).
  기존 `src/exec/claudeCliProvider.ts`의 `baseArgs`도 같은 이유로 `--verbose`를 넣는다.
  (2026-07-27 M5a 정정 — B/P1 운영 문서 오류: 이 예시에 `--verbose`가 빠져 있었다.)

- 프롬프트는 **stdin 또는 임시 파일**로 넣는다. **shell 위치 인자 보간으로 프롬프트를 넘기지 않는다**
  (인용·확장 사고로 프롬프트가 잘리거나 명령으로 해석된다).
- **`--dangerously-skip-permissions`는 어떤 경우에도 쓰지 않는다.**
- MCP는 **strict + 빈 config**가 기본이다. MCP 서버·`@latest` 패키지는 쓰지 않는다(hard deny).
- 도구 허용 범위는 그 세션 범위에 필요한 것만 남기고, 원격 쓰기·설치·배포 계열은 **금지**로 유지한다.

## 4. 권한 경계 (세션에서 자주 부딪히는 것)

| 항목 | 기본 |
|---|---|
| 패키지 설치 / 신규 런타임·dev 의존성 / package·lockfile 변경 | **사전 승인 없이는 금지** |
| 네트워크 · `gh` · fetch/pull/push · PR/merge | **금지**(원격 쓰기는 hard deny) |
| 로컬 git commit · 로컬 브랜치 | 승인된 범위에서 허용 |
| rebase / reset / checkout / switch / worktree 조작 | 지시 없이는 금지 |
| deploy · DB · production · live billing | **hard deny** |
| MCP 패키지 실행 | 금지 |

## 5. 테스트 순서 (위험 비례 — `AGENTS.md` §테스트)

1. **focused**: 변경한 계약의 파일 단독 테스트. 카운트는 **실행한 명령과 함께** 적는다
   (예: 파일 단독 `orchestrationKernel.test.ts` 67/67 ≠ `npm run test:exec` 142/142).
2. **offline acceptance**: 해당 마일스톤 스크립트(`scripts/m4a|m4b|m4c-offline-acceptance.mjs` 등) exit 0.
3. **최종 전체 suite**: 마지막 코드 변경 후 **`npm test` 정확히 1회, 직렬**. 전체 suite와
   `npm run acceptance:stress:m3d2`는 같은 배타 lock을 지나므로 **동시에 시작할 수 없다**.
4. **stress · live runner · 반복(연속 3회)** 는 **마일스톤/하드닝 게이트에서만** 돌린다. 단 변경이 동시성·lock·
   타이밍·live runner 계약을 건드렸으면 그 범위에서 즉시 돌린다.
5. **테스트 완화·삭제는 금지.** 돌리지 않은 것은 "미실행"으로 정직하게 적는다.
6. 비공허성이 의심되는 새 게이트는 mutation으로 확인하고 **정확히 원복**한 뒤 focused를 재확인한다
   (원복 증거: 파일 해시 일치 + mutation 흔적 grep 0).

## 6. Codex 리뷰 왕복

- 리뷰는 **fresh Codex `gpt-5.6-sol` xhigh · read-only**이며 작성자 transcript·자기평가와 분리한다.
- finding은 **P0 / P1 / P2**(= A/B/C 분류와 함께)로 받는다. 분류·유예 대장 필드는 `AGENTS.md` + 로드맵 §9.1.
- **`--resume <session-id>`는 P0에 대해서만, 정확히 한 번만 쓴다.** P1/P2로 리비전 루프를 다시 열지 않고
  대장에 등록한 뒤 진행한다.
- 리뷰가 P0를 내면 수정 → focused → 최종 전체 suite 1회 순서를 다시 지킨다.

## 7. 커밋과 PR 단위

- **로컬 커밋만** 만든다. 마일스톤을 **stacked 브랜치**로 쌓고 각 브랜치는 리뷰 가능한 **PR 크기**로 자른다
  (예: M4a → M4b(base = M4a 커밋) → M4c(base = M4b 커밋)).
- 커밋에는 **소유 파일만** 넣는다. `git diff` · `git diff --check`로 소유 밖 변경 0을 확인하고,
  임시 제어 파일은 untracked·unstaged로 남긴다.
- **push · PR 생성 · merge · 원격 자동화는 하지 않는다.** 원격 쓰기는 hard deny다.

## 8. 세션 종료 시

- `docs/WORKLOG.md` — 무엇을 했고 무엇을 하지 않았는지, 실행한 명령과 카운트.
- `docs/DECISIONS.md` — **정말 중요한 결정만**. 되돌리기 어려운 선택과 그 대가.
- `docs/CONTEXT_SUMMARY.md` — 다음 세션 시작용으로 짧게.
- `docs/handoff/CODEX_HANDOFF.md` — 현행 상태·계약·검증 실측·열린 P0 여부·다음 단계.
- 과거 세션 기록은 **고쳐 쓰지 않고** "그 시점 기록"으로 표시한다. 현행 사실은 현행 상태 블록에만 둔다.
- 마지막 스트림 보고: 관찰 가능하면 Claude 버전/모델/session ID, Pony Tail 경로·레벨, branch/worktree/base,
  변경 파일, 테스트와 카운트, 커밋 해시, 블로커.
