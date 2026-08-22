/**
 * V3 M10 T6 — **승인된 controller entrypoint**(대장 `C-90`).
 *
 * typed `run_process` 권위가 실행하는 **유일한 script**다. kernel이 띄우는 형태는 정확히
 * `node <이 파일> <action> <path>`이고(`orchestrationKernel.controllerActionArgs`) 그 밖의 인자·flag·env·
 * shell을 담을 자리가 승인 레코드에 없다. 여기까지 오면 이미 ⓐ 승인 manifest의 `operationAuthorityByTask`
 * ⓑ action enum ⓒ 경로 계약(정규화·`writableRoots` 안·task ownership 안) ⓓ 실행 파일 digest 재검증을
 * 전부 지난 상태다.
 *
 * **왜 이 파일이 필요했나**: M10 T5 도그푸딩 감사에서 R5(`approved_path_missing`)가 두 프로젝트 모두에서
 * high를 냈다 — `controllerEntrypoint`로 적을 **실재하는 파일이 레포에 없었다**(기존 스크립트는 전부
 * `/opt/harness/controller.js` 같은 가짜 경로이거나 임시 디렉터리에 자기가 만들었다). 승인 문서를 실제로
 * 쓰면 매번 high가 나고 그 high가 소음으로 학습된다.
 *
 * ## 계약 (좁게 유지한다)
 *
 * - **통신은 종료 코드 하나**다. supervisor가 `stdio: "ignore"`이므로 stdout/stderr는 아무도 읽지 않는다
 *   → 여기서 진단을 찍지 않는다(읽히지 않는 출력을 만들면 "진단이 있다"는 거짓 인상이 생긴다).
 *   `0` 통과 · `1` 실패(계획이 유효하지 않다 / 테스트가 실패했다) · `2` 계약 위반(인자·경로).
 * - **env는 `MANAGED_PROCESS_ENV`가 전부**다(`PATH=/usr/bin:/bin` · `HOME` 없음). 그래서 `npm`·`npx`·
 *   `pnpm`은 **도달 불가**이고 shell도 경유하지 않는다. 테스트 러너는 우리를 띄운 것과 같은 Node
 *   실행 파일(`process.execPath`)의 **내장 러너**(`node --test`)뿐이다 — 새 의존성·새 승인 축 0.
 * - **경로는 cwd 안쪽으로 한 번 더 좁힌다**(fail closed). 승인 계층이 이미 검사했지만 이 프로세스는
 *   자기 인자만 보고 판단할 수 있어야 한다(방어 심층). **범위를 정확히 적는다(T6 리뷰 C1)**: 이 검사는
 *   **경로 문자열 containment**이고 symlink를 해석하지 않는다 — workspace 안의 기존 symlink가 밖을
 *   가리키면 `node --test`가 그 밖의 파일을 실행할 수 있다. 지금 위협 모델에서는 모델이 symlink를 만들
 *   수 없지만(도구 0 · typed write는 내용만), 사전 symlink가 있을 수 있는 외부 저장소에 `run-tests`를
 *   승인하기 전에는 realpath 축을 열어야 한다.
 * - **권위가 아니다**: `validate-plan`은 kernel이 실제 binding으로 다시 하는 검증의 **사전 점검**이다.
 *   여기서 통과했다는 것이 kernel 승인을 대신하지 않는다(계획의 binding은 계획 자신이 주장하는 값이다).
 *
 * ## 하지 않는 것
 *
 * - 네트워크·설치·빌드·git·shell·자식 프로세스 spawn(단 `run-tests`의 `node --test` 하나는 예외이고
 *   그것은 우리와 같은 프로세스 그룹에 남는다 → supervisor의 정리 범위 안이다).
 * - 파일 쓰기 0. `validate-plan`도 `run-tests`도 읽기만 한다(테스트 자체가 무엇을 하는지는 그 프로젝트의
 *   책임이며, 쓰기 승인은 typed `write_file` 채널이 따로 집행한다).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { validateTypedExecutionPlan } from "./typedPlan.js";
/** 계획 파일 상한 — 읽기 **전에** `statSync`로 본다(거대 파일을 메모리에 올리지 않는다 · 대장 `C-51`). */
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_CONTRACT = 2;
/** 승인 계층이 이미 검사한 계약을 이 프로세스 안에서 한 번 더 좁힌다(자기 인자만으로 판단 가능해야 한다). */
function resolveWithin(cwd, raw) {
    if (raw.length === 0 || raw.includes("\0") || isAbsolute(raw))
        return null;
    if (raw.split("/").some((seg) => seg === "." || seg === ".."))
        return null;
    const abs = resolve(cwd, raw);
    return abs === cwd || abs.startsWith(cwd + sep) ? abs : null;
}
function validatePlan(planPath) {
    let size;
    try {
        size = statSync(planPath).size;
    }
    catch {
        return EXIT_FAIL; // 부재·권한 — 계획이 없으면 통과가 아니다
    }
    if (size > MAX_PLAN_BYTES)
        return EXIT_FAIL;
    let raw;
    try {
        raw = JSON.parse(readFileSync(planPath, "utf8"));
    }
    catch {
        return EXIT_FAIL; // malformed JSON
    }
    // binding은 **계획 자신이 주장하는 값**이다 → 이 검증은 형태·닫힌 집합·상한까지이고 신원 대조는
    // kernel이 실제 binding으로 다시 한다. 그 사실을 여기서 흐리지 않는다.
    const b = raw;
    try {
        validateTypedExecutionPlan(raw, {
            runId: b.runId,
            taskId: b.taskId,
            attemptId: b.attemptId,
            turnId: b.turnId,
        });
    }
    catch {
        return EXIT_FAIL;
    }
    return EXIT_OK;
}
function runTests(projectPath) {
    // 내장 러너만 쓴다: 우리를 띄운 Node 실행 파일 + `--test`. shell 미경유 · 인자 배열 · 새 의존성 0.
    // 자식은 우리와 같은 프로세스 그룹에 남으므로 supervisor의 TERM→KILL→그룹 소멸 관측이 그대로 덮는다.
    // **positional 인자 없이 `--test`**를 쓰고 cwd를 대상 디렉터리로 준다: 그러면 Node가 그 디렉터리를
    // 재귀 탐색한다. `--test <dir>`는 인자를 **모듈 경로**로 해석해 `MODULE_NOT_FOUND`가 된다(실측).
    //
    // env를 **상속하지 않는다**(닫힌 allowlist). 실측 근거: 부모가 Node 테스트 러너면 `NODE_TEST_CONTEXT`가
    // 상속돼 자식 러너의 보고·종료 판정이 바뀐다(우리 자신의 focused 테스트에서 실패가 0으로 접혔다).
    // production에서 이 프로세스의 env는 이미 `MANAGED_PROCESS_ENV`뿐이지만, **판정이 ambient에 의존하지
    // 않는다**는 성질을 여기서도 같은 규율로 지킨다(`MANAGED_PROCESS_ENV`와 같은 형태 · 호출자 override 없음).
    const r = spawnSync(process.execPath, ["--test"], {
        cwd: projectPath,
        stdio: "ignore",
        shell: false,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
    });
    if (r.error !== undefined || r.status === null)
        return EXIT_FAIL;
    // ponytail: 판정은 종료 코드 하나다. 내장 러너는 **테스트 0건도 0으로** 끝내므로 "테스트가 없다"와
    // "전부 통과"를 구분하지 못한다(그 한계는 focused 테스트가 고정한다). 구분이 필요해지면 자식 출력을
    // 읽어 개수를 세는 것이 상향 경로이고, 그것은 파싱 계약을 하나 더 만드는 일이라 지금 하지 않는다.
    return r.status === 0 ? EXIT_OK : EXIT_FAIL;
}
export function runControllerAction(argv, cwd) {
    if (argv.length !== 2)
        return EXIT_CONTRACT;
    const [action, rawPath] = argv;
    const abs = resolveWithin(cwd, rawPath);
    if (abs === null)
        return EXIT_CONTRACT;
    if (action === "validate-plan")
        return validatePlan(abs);
    if (action === "run-tests")
        return runTests(abs);
    return EXIT_CONTRACT;
}
// `node <이 파일> <action> <path>`로 직접 실행될 때만 종료 코드를 만든다(import는 부수 효과 0).
if (process.argv[1] !== undefined && /controllerEntrypoint\.(js|ts)$/.test(process.argv[1])) {
    process.exit(runControllerAction(process.argv.slice(2), process.cwd()));
}
