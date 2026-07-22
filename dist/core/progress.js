/**
 * 실행 진행 이벤트 모델 (V3 F2 / MCP M1).
 *
 * runWorkflow는 진행 상황을 console.log로 직접 그리지 않고 RunEvent를 방출한다.
 * 렌더러(commands/progress.ts)가 이벤트를 소비해 TTY 스피너 / 비-TTY 라인 로그로 그린다.
 * 이유: (a) 테스트에서 이벤트 시퀀스를 검증 가능, (b) 비-TTY 자동 강등,
 * (c) step 타이밍 데이터가 부산물로 생겨 run_state.step_timings에 저장된다.
 *
 * 의존성 0. core는 TTY/렌더링을 모른다 — 전부 ProgressReporter 뒤에 격리.
 */
export {};
