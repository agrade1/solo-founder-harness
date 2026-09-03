import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPaths, projectExists } from "./project.js";
import { extractMainJudgment, extractSectionBullets } from "./validate.js";
import { devSurfaceGateStatus, ideaGateStatus, readRunState, snapshotIdea, IDEA_REL } from "./runWorkflow.js";
import { pipelineGateStatus, pipelineStatePath, readPipelineStateAt } from "./pipeline.js";
const NEXT_ACTIONS_RE = /^##\s+.*Next Actions\s*$/;
function readIfExists(abs) {
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}
// [B-40/A-4] 이 파일에 있던 지역 run_state 리더를 지웠다: `catch { return null }`로 손상을 부재로 접어서
// 깨진 killed state를 못 본 척했다. 이제 core의 `readRunState`(부재/손상 구분) 하나만 쓴다.
// Claude Code 작업 지시문에 항상 포함하는 규칙 (PERMISSION_POLICY §6)
const RULES = [
    "작업 전 구현 계획을 먼저 제시하고, 사용자 승인 전에는 파일을 수정하지 않는다.",
    "관련 없는 파일은 열지 않고, 한 번에 하나의 기능만 구현한다.",
    "패키지 설치가 필요하면 이유와 대체안을 먼저 제시한다. 승인 없이 설치하지 않는다.",
    "배포, DB migration/변경, git push는 실행하지 않는다.",
    ".env, secrets 파일은 읽거나 출력하지 않는다.",
    "수정 후 변경 파일, 실행한 명령어, 남은 TODO를 요약한다.",
    "작업 결과는 docs/WORKLOG.md에 남긴다.",
];
/**
 * Claude Code 작업 지시문 markdown을 생성한다.
 *
 * @param today 호출자가 넘기는 날짜. **본문에 싣지 않는다**(결정 1 — 지시문 멱등성). 시그니처는
 *   호환을 위해 유지한다(`generateTaskPrompt`·handoff가 그대로 넘긴다).
 */
export function buildTaskPrompt(project, today) {
    void today;
    const paths = projectPaths(project);
    // [B-40] 폐기된 아이디어로는 구현 지시문을 만들지 않는다. 아래에 Next Actions가 없으면
    // "MVP의 첫 기능 하나를 구현한다"를 지어내는 경로가 있는데, killed run에서 그것이 돌면
    // 게이트가 죽인 아이디어가 구현 지시문으로 부활한다. 해제는 재평가 run의 '진행' 판정뿐이고,
    // 손상된 run_state도 거부한다(A-4) — 폐기 기록이 그 안에 있을 수 있다.
    // [A-1] 아이디어를 **한 번** 읽어 검사와 사용에 같은 바이트를 쓴다 — 검사 후 다시 읽으면
    // "검사한 바이트 ≠ 지시문에 실리는 바이트"가 된다(재검증보다 이쪽이 더 싸고 창 자체가 없다).
    const ideaSnapshot = snapshotIdea(join(paths.root, IDEA_REL));
    const read = readRunState(project);
    const gate = ideaGateStatus(read, ideaSnapshot);
    if (!gate.ok)
        throw new Error(`${gate.code}: ${gate.message}`);
    // [B-41/2단] 단계 체크포인트 게이트. 파이프라인을 쓰는 프로젝트에서는 **완료 후**(또는 마지막
    // dev-handoff 단계의 실행 대기)에만 지시문을 만든다 — 확인 대기 중인 산출물로 구현을 시작하는 것이
    // 이 기능이 막으려는 것 그 자체다. 승인 후 문서가 바뀌었으면 drift로 거부한다(전수 대조).
    // 파이프라인이 없으면 `absent` → ok라서 기존 사용법은 완전히 불변이다.
    // **정직한 한계**: 이 검증 뒤에 아래 로직이 문서를 다시 읽는다 — 그 사이 창은 남는다(§8-5).
    const pipeGate = pipelineGateStatus(readPipelineStateAt(pipelineStatePath(paths.root)), paths.root, "task-prompt");
    if (!pipeGate.ok)
        throw new Error(pipeGate.message);
    // [B-50/A-1/A-2] 게이트가 '진행'을 내지 않은 상태에서는 지시문을 만들지 않는다 — 게이트가
    // "개발하지 마라"로 멈춘 그 자리에서 개발 착수 문서가 나오면 그것이 곧 상태 전이 우회다
    // (plan-dag와 **같은 판정 함수**를 쓴다 — 규칙이 두 벌이면 한쪽만 정직해진다).
    // 판정 근거는 durable한 decider 문서다: run_state만 보면 게이트 없는 workflow 한 번으로 지워졌다(A-1).
    // **drift 게이트 뒤에 둔다**: 승인된 판정 문서를 사람이 갈아치우면 원인은 drift이고, 그때 이 게이트가
    // 먼저 말하면 원인과 다른 코드를 적게 된다(C-96 부류). 앞뒤 어느 쪽이든 fail closed는 같다.
    const devGate = devSurfaceGateStatus(paths.root);
    if (!devGate.ok)
        throw new Error(`${devGate.code}: ${devGate.message}`);
    const state = read.kind === "ok" ? read.state : null;
    const ceo = readIfExists(join(paths.docs, "06_CEO_DECISION.md"));
    const prd = readIfExists(join(paths.docs, "02_PRD.md"));
    const idea = ideaSnapshot.sha256 === null ? null : ideaSnapshot.text; // [A-1] 검사한 그 바이트를 쓴다
    // Task / Done Criteria 후보: CEO → PRD 순서로 Next Actions를 찾는다.
    let nextActions = [];
    if (ceo)
        nextActions = extractSectionBullets(ceo, NEXT_ACTIONS_RE);
    if (nextActions.length === 0 && prd)
        nextActions = extractSectionBullets(prd, NEXT_ACTIONS_RE);
    if (nextActions.length === 0) {
        nextActions = ["판단 문서를 근거로 MVP의 첫 기능 하나를 구현한다."];
    }
    const ceoJudgment = ceo ? extractMainJudgment(ceo) : "(CEO 판단 문서 없음)";
    // Include: 실제 존재하는 핵심 문서만
    const includeCandidates = [
        "docs/00_IDEA.md",
        "docs/01_RESEARCH.md",
        "docs/02_PRD.md",
        "docs/03_UX_FLOW.md",
        "docs/04_TECH_PLAN.md",
        "docs/05_RED_TEAM.md",
        "docs/06_CEO_DECISION.md",
        "docs/API_CONTRACT.md",
        "docs/DESIGN.md",
        "docs/tokens.json",
    ].filter((rel) => existsSync(join(paths.root, rel)));
    const lines = [];
    lines.push(`# Claude Code 작업 지시문 — ${project}`, "");
    // [B-41/결정 1] **생성 날짜를 본문에 넣지 않는다 — 지시문을 멱등하게 유지한다.**
    //
    // 원칙: **산출물은 자기를 만드는 명령을 게이트하지 못한다.** 이 파일은 dev-handoff 단계의 승인
    // 대상인데, 완료 후 `task-prompt`·`handoff`가 같은 파일을 다시 만든다. 본문에 날짜가 있으면
    // 하루만 지나도 바이트가 달라져 그 다음 소비가 `pipeline_artifact_drift`로 막혔다(실측 재현:
    // task-prompt exit 2 · handoff exit 1, 탈출구는 restart뿐). 근본 원인은 "같은 입력에 다른 바이트"
    // 였고, 그것을 없애는 것이 가장 싸다.
    // **일반적 경로 제외(설계 §9-6이 기각한 방향)를 도입한 것이 아니다** — drift 검증은 그대로 전수다.
    // 시각이 필요한 곳은 승인 대상 **밖**이다: run_state.finished_at · pipeline 영수증의
    // `run_finished_at`/`decided_at`가 "언제 만들어졌고 언제 승인됐나"를 담는다.
    lines.push(`생성: harness task-prompt --project ${project} (provider: ${state?.provider ?? "미실행"})`, "");
    lines.push("## Context");
    lines.push(`- 프로젝트: ${project}`);
    if (state) {
        lines.push(`- 마지막 workflow: \`${state.workflow_id}\` (완료: ${state.completed_steps.join(" → ") || "없음"})`);
        if (state.failed_agent)
            lines.push(`- 주의: \`${state.failed_agent}\`에서 중단됨`);
    }
    else {
        lines.push("- workflow 미실행 상태");
    }
    lines.push(`- CEO 핵심 판단: ${ceoJudgment}`);
    if (idea) {
        const oneLine = extractSectionBullets(idea, /^##\s+아이디어 한 줄 정의\s*$/)[0];
        if (oneLine)
            lines.push(`- 아이디어: ${oneLine}`);
    }
    lines.push("");
    lines.push("## Task");
    lines.push("아래 판단 문서를 근거로 다음을 수행한다 (우선순위 순):");
    nextActions.slice(0, 5).forEach((a, i) => lines.push(`${i + 1}. ${a}`));
    lines.push("");
    // 동적 분화(fanout)가 있었으면 병렬 subagent 실행 스펙을 추가한다 (B-③).
    const spawned = state?.spawned_agents ?? [];
    if (spawned.length > 0) {
        lines.push("## 병렬 실행 (Claude Code subagents)");
        lines.push(`\`${spawned[0].parent}\`가 아래 ${spawned.length}개 전문 영역으로 분화했다. ` +
            "Claude Code에서 각 영역을 **병렬 subagent**로 띄워 진행하고, 전부 완료된 뒤 통합·교차검증한다.");
        lines.push("⚠️ 각 subagent 작업 전 구현 계획을 먼저 제시하고 사용자 승인을 받는다 (자동 실행 금지).");
        lines.push("");
        for (const s of spawned) {
            lines.push(`### ${s.id} — ${s.name}`);
            lines.push(`- 담당 범위: ${s.focus}`);
            if (s.output)
                lines.push(`- 계획 문서: ${s.output}`);
            else
                lines.push(`- (계획 문서 미생성 — \`harness run ${state?.workflow_id ?? "<workflow>"} --project ${project} --allow-spawn\`으로 생성 가능)`);
            lines.push(`- 산출: 담당 범위의 코드/변경만. 다른 영역 파일은 건드리지 않는다.`);
            lines.push("");
        }
        lines.push("### 통합");
        lines.push("- `docs/API_CONTRACT.md`의 인터페이스 계약을 기준으로 각 영역을 통합한다.");
        lines.push("- 각 subagent 완료 후 계약 일치·빌드·테스트로 교차 검증한다.");
        lines.push("");
    }
    // ux_ui 산출물(03_UX_FLOW.md)이 있으면 디자인 실행(레퍼런스 검색 + Claude 시안) 지시를 추가한다.
    if (existsSync(join(paths.root, "docs/03_UX_FLOW.md"))) {
        lines.push("## 디자인 실행 (화면 시안)");
        lines.push("`docs/03_UX_FLOW.md`의 화면 흐름/컴포넌트와 그 안의 [디자인 레퍼런스]·[비주얼 방향]을 근거로 화면 시안을 만든다.");
        lines.push("1. **레퍼런스 수집** — 문서가 지목한 소스(Pinterest/Dribbble/Mobbin/경쟁사·유사 서비스)와 검색 키워드로 WebSearch/WebFetch해 레퍼런스 3~5개를 모으고, 차용할 패턴을 한 줄씩 정리한다.");
        lines.push("2. **시안 생성** — 위 레퍼런스와 비주얼 방향을 반영해 Claude 아티팩트로 핵심 화면(Landing/Input/Result 등)의 HTML/React 시안을 만든다. 화면 수는 UX 문서 범위를 넘기지 않는다.");
        lines.push("3. **검증(MVP-lean)** — 레퍼런스는 명확성·속도용이며 과장/과설계 금지. 모바일·접근성 기본을 지킨다. 저작권 자산을 그대로 복제하지 않는다.");
        lines.push("");
    }
    // DESIGN.md + tokens.json이 모두 있으면 토큰 기반 구현 규칙을 주입한다 (디자인 레이어 §5).
    // FE/UI 담당 코드에 적용. (위 "디자인 실행"은 시안 생성, 이건 코드화 규칙 — 상호 보완)
    if (existsSync(join(paths.root, "docs/DESIGN.md")) && existsSync(join(paths.root, "docs/tokens.json"))) {
        lines.push("## 디자인 구현 규칙 (필수 — FE/UI 담당 코드)");
        lines.push("- 구현 전 `docs/DESIGN.md`와 `docs/tokens.json`을 읽을 것.");
        lines.push("- 모든 컬러/스페이싱/타이포/radius/shadow 값은 tokens.json의 토큰을 참조할 것. " +
            "CSS 변수 또는 Tailwind config 매핑으로 소비하고, raw 값(hex, px) 하드코딩 금지.");
        lines.push("- primitive 토큰을 컴포넌트에서 직접 사용 금지. semantic 또는 component 토큰만 사용.");
        lines.push("- DESIGN.md 컴포넌트 인벤토리에 없는 컴포넌트가 필요하면 임의 생성하지 말고 인벤토리 추가를 먼저 제안할 것.");
        lines.push("- 상태(hover/focus/disabled/error) 처리는 DESIGN.md 인터랙션 원칙을 따를 것.");
        lines.push("- 구현 완료 후 `node scripts/token-lint.mjs`를 실행해 위반 0건을 확인할 것.");
        lines.push("");
    }
    lines.push("## Include (읽을 것)");
    for (const rel of includeCandidates)
        lines.push(`- ${rel}`);
    for (const s of spawned)
        if (s.output)
            lines.push(`- ${s.output}`);
    lines.push("");
    lines.push("## Exclude (건드리지 말 것)");
    lines.push("- 위 Include에 없는 무관한 파일");
    lines.push("- .env 및 secrets 파일");
    lines.push("- 하네스 자체 소스(src/, registry/, agents/)");
    lines.push("");
    lines.push("## Rules");
    for (const r of RULES)
        lines.push(`- ${r}`);
    lines.push("");
    lines.push("## Done Criteria");
    lines.push("- Task 항목이 구현되고 로컬에서 동작 확인됨");
    lines.push("- 변경 파일/실행 명령/남은 TODO가 요약됨");
    lines.push("- docs/WORKLOG.md에 결과 기록됨");
    lines.push("- 승인 없는 패키지 설치/배포/DB 변경이 없음");
    lines.push("");
    return lines.join("\n");
}
/** 작업 지시문을 outputs/claude_code_task_prompt.md로 저장하고 상대경로를 반환한다. */
export function generateTaskPrompt(project, today) {
    if (!projectExists(project)) {
        throw new Error(`프로젝트가 없습니다: ${project} (먼저 'harness init ${project}' 실행)`);
    }
    const content = buildTaskPrompt(project, today);
    const rel = "outputs/claude_code_task_prompt.md";
    writeFileSync(join(projectPaths(project).root, rel), content, "utf8");
    return rel;
}
