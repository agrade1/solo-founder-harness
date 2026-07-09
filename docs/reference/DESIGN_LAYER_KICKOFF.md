# DESIGN_LAYER_KICKOFF — 디자인 에이전트 확장 및 문서 산출물 체계 정비

> 대상 레포: `agrade1/solo-founder-harness`
> 작업 주체: Claude Code
> 관련 문서: `docs/backlog/V2_KICKOFF.md`, `docs/backlog/V3_KICKOFF.md`, `docs/reference/MINIMAL_CONTEXT_LOAD_POLICY.md`
> 원칙: 기존 v2 파이프라인(스키마 검증 루프, critique 루프, 게이트, run_state 기록)과 동일한 패턴을 따른다. 새로운 메커니즘을 발명하지 말 것.

---

## 0. 배경과 목적

현재 하네스의 디자인 관련 에이전트는 "레퍼런스 리서치 + 유사 시장 서비스 디자인 참고" 수준의 산출물만 낸다. 이 산출물은 코드화 단계(task-prompt → Claude Code 구현)에 연결되지 않아, 실제 구현 시 디자인 결정이 매번 즉흥적으로 이뤄지고 화면이 늘어날수록 드리프트가 발생한다.

이번 작업의 목적:

1. **문서 산출물 체계 정비** — PM은 PRD, Tech Lead는 Tech Spec을 산출물로 명시하고, 각각의 필수 헤더 스키마를 스키마 검증 재생성 루프에 등록한다.
2. **디자인 에이전트 확장** — 레퍼런스 리서치에 더해 `DESIGN.md`(디자인 시스템 명세) + `tokens.json`(3계층 디자인 토큰)을 산출하도록 재정의한다.
3. **워크플로우 통합** — 디자인 단계를 워크플로우에 배치하고, 시안 확인(사람 수동, Stitch/Figma/Claude Design)을 승인 게이트로 연결한다.
4. **코드화 규칙 주입** — task-prompt 생성기가 DESIGN.md/tokens.json 참조 지시와 하드코딩 금지 룰을 자동 포함하게 한다.
5. **토큰 린트 워크플로우** — 에이전트가 아닌 단순 스크립트로 토큰 위반을 검출한다.

**핵심 설계 원칙: DESIGN.md/tokens.json이 source of truth다.** Stitch/Figma 시안은 검증 수단이며, 시안에서 확정된 변경은 사람이 md/json에 역반영한 뒤 하네스를 재실행한다. 시안 → md 방향이 아니라 md → 시안 → md 수정 → 코드화 순서를 지킨다.

---

## 1. 사전 조사 (Phase 0) — 코드 수정 전 필수

작업 전에 아래를 탐색하고, 발견한 실제 파일명/구조를 기준으로 이후 Phase의 계획을 확정해 사람에게 보고할 것. (이 문서는 레포 외부에서 작성되어 정확한 파일명을 모른다. 추측으로 파일을 만들지 말 것.)

- [ ] `agents/` — 현재 PM, UX, Tech Lead, 디자인 관련 에이전트 프롬프트 파일 목록과 각각의 산출물 정의 확인. 디자인 에이전트가 별도 파일인지, UX 에이전트에 포함돼 있는지 확인.
- [ ] `registry/*.json` — agent 정의와 workflow 정의 구조 확인. 특히 `mvp-planning`, `dev-preflight`, `full-predev`의 step 배열 형식과 `{gate}`, `{critique_loop}` 표기법.
- [ ] `src/core/` — 스키마 검증(필수 헤더) 로직이 어디서 어떤 형식으로 헤더 목록을 읽는지 확인 (agent 정의 JSON 내 필드인지, 별도 스키마 파일인지).
- [ ] `src/core/`의 task-prompt 생성기 (`generateClaudeTaskPrompt` 추정) — 멀티에이전트 task-prompt(v2.3)가 어떤 조건에서 어떤 섹션을 생성하는지 확인.
- [ ] `projects/sample-project/docs/` — `00_IDEA.md` ~ `0N_*.md` 파일 네이밍 규칙과 init 시 생성되는 docs 6개 목록 확인.
- [ ] `scripts/` — 기존 스크립트 컨벤션(언어, 실행 방식) 확인.

**보고 형식:** 탐색 결과 요약 + Phase 1~5 각각에서 수정/생성할 실제 파일 경로 목록. 사람 승인 후 진행.

---

## 2. Phase 1 — PM/Tech Lead 산출물 스키마 명시

### 2.1 PM 에이전트 → PRD

PM 에이전트 프롬프트에 산출물이 PRD임을 명시하고, 필수 헤더 스키마를 등록한다.

PRD 필수 헤더 (스키마 검증 루프 등록 대상):

```
## 문제 정의            — 누구의 어떤 문제인가, 근거
## 목표와 성공 지표      — 측정 가능한 지표, 목표치
## 사용자와 시나리오     — 핵심 페르소나, 주요 사용 흐름
## 기능 요구사항         — MVP 범위 기능 목록 (우선순위 P0/P1/P2)
## 비범위 (Out of Scope) — 이번에 하지 않는 것
## 제약과 가정           — 기술/일정/리소스 제약
## 오픈 퀘스천           — 미결정 사항
```

### 2.2 Tech Lead 에이전트 → Tech Spec

Tech Spec 필수 헤더:

```
## 아키텍처 개요         — 구성 요소와 데이터 흐름 (텍스트 다이어그램 허용)
## 기술 스택과 선정 근거  — 각 선택의 트레이드오프
## 데이터 모델           — 핵심 엔티티와 관계
## API 계약             — 엔드포인트/입출력 (API_CONTRACT 통합 규칙과 정합)
## 구현 순서             — 마일스톤 단위 분해
## 리스크와 완화책       — 기술 리스크 상위 3~5개
## 비기능 요구사항       — 성능/보안/접근성 기준
```

### 2.3 주의

- 기존 에이전트 산출물과 하위 호환: 기존 헤더를 삭제하지 말고, 누락된 필수 헤더만 추가. 기존 acceptance test(30 checks)가 깨지지 않는지 확인.
- Red Team critique 루프의 target이 tech_lead인 워크플로우(`mvp-planning`)에서 revise 시에도 필수 헤더가 유지되는지 확인.

---

## 3. Phase 2 — 디자인 에이전트 재정의

### 3.1 역할 정의 (에이전트 프롬프트 재작성)

디자인 에이전트의 역할을 아래 3단계로 확장:

1. **레퍼런스 리서치 (기존 유지)** — 유사 시장 서비스의 디자인 패턴, 차별점, 차용/회피할 요소.
2. **디자인 시스템 수립 (신규)** — 브랜드 방향(톤, 무드), 3계층 토큰 체계, 컴포넌트 인벤토리, 레이아웃/반응형 규칙을 결정.
3. **산출물 생성 (신규)** — `DESIGN.md` + `tokens.json` 두 파일. 브랜드 보이스/메시징 같은 비시각 요소는 tokens.json에 섞지 않고 DESIGN.md의 별도 섹션에 둔다.

### 3.2 DESIGN.md 필수 헤더 (스키마 검증 등록 대상)

```
## 디자인 방향           — 브랜드 무드 3~5 키워드, 레퍼런스 서비스와 차용 요소
## 디자인 토큰 개요       — tokens.json 요약: 컬러 팔레트 의도, 타입 스케일, 스페이싱 단위
## 컴포넌트 인벤토리      — MVP에 필요한 컴포넌트 목록 (Button/Input/Card/...) + 각 variant
## 레이아웃 규칙          — 그리드, 브레이크포인트, 모바일 퍼스트 여부
## 인터랙션 원칙          — 상태(hover/focus/disabled/loading/error) 처리 기준
## 접근성 기준           — 대비비, 터치 타깃 최소 크기, 키보드 내비게이션
## 비시각 가이드          — 톤앤매너, 마이크로카피 원칙 (tokens.json 비포함 사유 명시)
## 시안 검증 절차         — 아래 4절의 수동 워크플로우 안내 (사람용)
```

### 3.3 tokens.json 구조 (3계층 강제)

에이전트 프롬프트에 아래 구조와 규칙을 명시:

```json
{
  "primitive": {
    "color":   { "blue-500": "#3B82F6", "gray-900": "#111827" },
    "spacing": { "4": "16px", "6": "24px" },
    "font":    { "size-base": "16px", "weight-medium": "500" }
  },
  "semantic": {
    "color": {
      "text-primary":  "{primitive.color.gray-900}",
      "action-primary": "{primitive.color.blue-500}"
    },
    "spacing": { "component-padding": "{primitive.spacing.4}" }
  },
  "component": {
    "button": {
      "bg-primary": "{semantic.color.action-primary}",
      "padding-x":  "{semantic.spacing.component-padding}"
    }
  }
}
```

규칙 (프롬프트에 명시):

- primitive는 raw 값만, semantic은 primitive 참조만, component는 semantic 참조만. 계층 건너뛰기 금지.
- 네이밍은 시맨틱하게: `blue` 금지, `action-primary` 형식. 값이 바뀌어도 이름이 유효해야 한다.
- 다크 모드가 범위에 있으면 semantic 계층에서 모드 분기 (`light`/`dark` 키). 나중에 추가하면 전면 리팩토링이 필요하므로 MVP 범위 판단은 PRD를 따르되 구조는 처음부터 모드 분기 가능하게.
- 모든 CSS 속성을 토큰화하지 말 것. 컬러/타이포/스페이싱/radius/shadow까지만.

### 3.4 저장 위치

`projects/<name>/docs/` 네이밍 규칙(`0N_*.md`)에 맞춰 DESIGN.md를 번호 문서로 저장할지, `docs/DESIGN.md` + `docs/tokens.json` 고정 이름으로 둘지 Phase 0 탐색 결과를 보고 결정. **권장: 고정 이름.** task-prompt와 토큰 린트가 경로를 하드코딩으로 참조할 수 있어야 하기 때문. run_state에는 기존 패턴대로 산출 기록.

---

## 4. Phase 3 — 워크플로우 통합과 승인 게이트

### 4.1 단계 배치

디자인 단계는 **UX 다음, Tech Lead 이전**에 배치한다. 근거: 컴포넌트 인벤토리와 레이아웃 규칙이 Tech Spec의 구현 순서/스택 선정에 입력이 되어야 한다.

```
Research → PM(PRD) → UX → Design(DESIGN.md + tokens.json) → [사람 승인 게이트] → Tech Lead(Tech Spec) → Red Team → CEO
```

기존 워크플로우 중 어디에 넣을지: `mvp-planning`과 `full-predev`에 반영. `idea-validation`은 디자인 단계 불필요 (제외). `dev-preflight`는 Phase 0 탐색 후 판단.

### 4.2 사람 승인 게이트 (시안 검증)

디자인 단계 직후 게이트를 둔다. 기존 CEO 게이트(`{gate}`)와 동일한 메커니즘을 재사용하되, decider가 에이전트가 아니라 **사람**이다. 하네스가 자동으로 할 일은 실행을 멈추고 아래 안내를 출력하는 것까지:

```
[DESIGN GATE] 시안 검증이 필요합니다.
1. docs/DESIGN.md를 열어 디자인 방향을 확인하세요.
2. (선택) 시안 생성: DESIGN.md 내용을 프롬프트로 Claude Design 또는
   Google Stitch(stitch.withgoogle.com)에 입력해 초기 시안을 생성하세요.
   - Stitch Standard 모드: Figma export 가능 / 이미지 레퍼런스 불가
   - Stitch Experimental 모드: 이미지 레퍼런스 가능 / Figma export 불가
3. (선택) Figma로 export해 팀 리뷰 / 세부 조정.
4. 시안에서 확정한 변경(컬러, 간격, 컴포넌트 추가/삭제)을
   docs/DESIGN.md와 docs/tokens.json에 직접 반영하세요.
   ※ 시안 파일이 아니라 md/json이 source of truth입니다.
5. 완료 후 `harness run ... --resume-from tech_lead` (또는 해당 재개 명령)로 계속.
```

재개 메커니즘은 v2.5 stabilization의 resume 기능과 연동. resume이 아직 미구현이면 이 게이트는 "여기서 중단 + 다음 실행 명령 안내" 수준으로 구현하고 TODO 주석으로 연결점 표시.

### 4.3 run_state 기록

기존 패턴(`critique_rounds`, `gate_jumps`, `spawned_agents`)과 동일하게 `design_gate: { status: "pending" | "approved", tokens_hash: "<sha256>" }` 형태로 기록. tokens_hash는 게이트 통과 시점의 tokens.json 해시 — 이후 코드화 단계에서 토큰이 변경됐는지 감지하는 용도.

---

## 5. Phase 4 — task-prompt에 디자인 규칙 주입

task-prompt 생성기 수정. `docs/DESIGN.md`와 `docs/tokens.json`이 존재하면 생성되는 Claude Code 작업 지시문에 아래 섹션을 자동 포함:

```markdown
## 디자인 구현 규칙 (필수)

- 구현 전 docs/DESIGN.md와 docs/tokens.json을 읽을 것.
- 모든 컬러/스페이싱/타이포/radius/shadow 값은 tokens.json의 토큰을 참조할 것.
  CSS 변수 또는 Tailwind config 매핑으로 소비하고, raw 값(hex, px) 하드코딩 금지.
- primitive 토큰을 컴포넌트에서 직접 사용 금지. semantic 또는 component 토큰만 사용.
- DESIGN.md 컴포넌트 인벤토리에 없는 컴포넌트가 필요하면
  임의 생성하지 말고 인벤토리 추가를 먼저 제안할 것.
- 상태(hover/focus/disabled/error) 처리는 DESIGN.md 인터랙션 원칙을 따를 것.
- 구현 완료 후 scripts/token-lint를 실행해 위반 0건을 확인할 것.
```

멀티에이전트 task-prompt(FE/BE 분리)인 경우 이 섹션은 **FE 담당 스펙에만** 포함.

---

## 6. Phase 5 — 토큰 린트 스크립트 (에이전트 아님)

`scripts/token-lint` (기존 scripts 컨벤션에 맞는 언어로) 작성. 판단이 필요 없는 규칙 검사이므로 LLM 호출 없이 정적 검사만:

1. 소스 파일(`.tsx/.jsx/.css/.scss` 등)에서 raw hex 컬러(`#[0-9a-fA-F]{3,8}`) 사용 검출 → tokens.json에 정의된 값이면 "토큰으로 교체" 경고, 미정의 값이면 "미등록 값" 오류.
2. primitive 토큰의 직접 참조 검출 (semantic/component를 거치지 않은 사용).
3. tokens.json 자체 검증: semantic이 primitive만 참조하는지, component가 semantic만 참조하는지, 참조 대상이 실제 존재하는지, 순환 참조 없는지.
4. 출력: 위반 목록 + 파일:라인. exit code 0/1로 CI 연동 가능하게.

예외 허용: `// token-lint-ignore` 주석 라인.

---

## 7. 수용 기준

- [ ] `npm test` 기존 30 checks 전부 통과 (하위 호환).
- [ ] mock provider로 `mvp-planning` 실행 시: PRD/Tech Spec/DESIGN.md 필수 헤더 누락 → 스키마 검증 재생성 루프가 동작.
- [ ] 디자인 단계 이후 실행이 게이트에서 멈추고 안내 메시지 출력, run_state에 `design_gate` 기록.
- [ ] DESIGN.md + tokens.json 존재 시 task-prompt에 디자인 구현 규칙 섹션 포함, 부재 시 미포함 (기존 프로젝트 무영향).
- [ ] `scripts/token-lint`가 의도적 위반 샘플(하드코딩 hex, primitive 직접 참조, 깨진 참조)을 전부 검출.
- [ ] sample-project 또는 신규 테스트 프로젝트로 end-to-end 1회 실행해 산출물 확인.
- [ ] README의 workflow 설명과 명령 요약 표 갱신.

## 8. 제외 범위

- Figma MCP / Stitch MCP 자동 연동 (시안 생성·확인은 사람 수동 단계로 유지 — v3 이후 검토)
- 시각적 회귀 테스트, 스크린샷 비교
- Style Dictionary 등 토큰 빌드 파이프라인 (tokens.json → CSS 변수 변환은 구현 프로젝트 쪽 책임)
- 디자인 에이전트의 이미지 생성/처리

## 9. 작업 방식

- Phase 단위로 커밋 분리, 각 Phase 완료 시 변경 요약 보고 후 다음 Phase 진행.
- Phase 0 보고 → 사람 승인 전에는 코드 수정 금지.
- 기존 문서 로드 정책(`MINIMAL_CONTEXT_LOAD_POLICY.md`)을 위반하지 않게 DESIGN.md 로드 시점을 설계에 반영.
- 불확실한 지점(파일 구조, 네이밍)은 추측 구현하지 말고 질문으로 남길 것.

## 10. 참고 자료

- Stitch DESIGN.md 워크플로우: designsystemscollective.com "The DESIGN.md Workflow" (2026-04)
- 3계층 토큰 구조: contentful.com/blog/design-token-system
- 토큰 → 프로덕션 코드 파이프라인: designsystemscollective.com "Design Tokens in Practice"
- 에이전트 vs 워크플로우 판단 기준: learn.thedesignsystem.guide "Should you build an agent for your design system"
- 8-에이전트 디자인 시스템 파이프라인 사례(게이트 설계 참고): kaelig.fr/design-system-components-with-ai-agent-teams
- Figma MCP (v3 이후 자동화 검토용): figma.com/blog/introducing-claude-code-to-figma
