# PERMISSION_POLICY.md

## 1. 문서 목적

이 문서는 Solo Founder AI Harness와 Claude Code 작업에서 어떤 행동을 자동 허용하고, 어떤 행동은 반드시 사용자 승인을 받아야 하며, 어떤 행동은 금지해야 하는지 정의한다.

목표는 두 가지다.

```text
- 승인 피로를 줄인다.
- 위험 작업은 반드시 막는다.
```

---

## 2. 기본 원칙

```text
- 읽기 작업은 대체로 허용한다.
- 쓰기 작업은 범위가 명확할 때만 허용한다.
- 설치, 배포, DB, secret 접근은 항상 승인 필요다.
- destructive command는 금지 또는 강한 승인 필요다.
- production 환경 변경은 자동화하지 않는다.
```

---

## 3. 자동 허용 가능 작업

아래 작업은 일반적으로 자동 허용 후보로 볼 수 있다.

단, 프로젝트별 설정에서 다르게 정할 수 있다.

```text
- 현재 폴더 구조 확인
- 관련 소스 파일 읽기
- README, package.json, tsconfig, vite/next config 읽기
- docs 파일 읽기
- git status
- git diff
- git log --oneline -n 5
- npm run lint
- npm run typecheck
- npm run test, 단 오래 걸리지 않는 경우
- 특정 파일 단위 검색
- docs/WORKLOG.md 업데이트
- docs/HANDOFF.md 업데이트
- docs/CONTEXT_SUMMARY.md 업데이트
```

---

## 4. 항상 승인 필요한 작업

아래 작업은 사용자 승인 없이 실행하지 않는다.

```text
- npm install
- pnpm add
- yarn add
- 패키지 업데이트
- 전역 설치
- npx로 외부 패키지 실행
- DB migration
- seed 실행
- 배포 명령
- git push
- git reset
- git clean
- git rebase
- 파일 대량 삭제
- 파일 대량 이동
- .env 생성/수정
- production 환경변수 변경
- API key 등록
- OAuth 설정
- 결제 설정
- cloud resource 생성
- Docker build/run
- curl/wget로 스크립트 다운로드
- 외부 repo clone
```

---

## 5. 금지 작업

아래 작업은 기본적으로 금지한다.

```text
- .env 내용 출력
- secret/token/API key 출력
- curl | sh 실행
- 출처 불명 shell script 실행
- production DB 직접 수정
- production 배포 자동 실행
- 사용자 승인 없는 결제/과금 설정
- 사용자 승인 없는 권한 상승
- 사용자 승인 없는 파일 전체 삭제
- 사용자 승인 없는 홈 디렉터리/시스템 파일 수정
- 알 수 없는 binary 실행
```

---

## 6. Claude Code 작업 지시문에 포함할 규칙

Claude Code에 작업을 넘길 때 아래 문구를 기본 포함한다.

```text
규칙:
- 작업 전 구현 계획을 먼저 제시한다.
- 사용자 승인 전 파일 수정하지 않는다.
- 관련 없는 파일은 열지 않는다.
- 한 번에 하나의 기능만 구현한다.
- 패키지 설치가 필요하면 이유와 대체안을 먼저 제시한다.
- .env, secrets 파일은 읽지 않는다.
- 배포, DB migration, git push는 실행하지 않는다.
- 수정 후 변경 파일, 실행한 명령어, 남은 TODO를 요약한다.
- WORKLOG.md에 작업 결과를 남긴다.
```

---

## 7. 권한 단계

권한은 세 단계로 나눈다.

### 7.1 Allow

자동 허용 가능.

예시:

```text
- docs 읽기
- 관련 source file 읽기
- git diff
- git status
- lint/typecheck
```

### 7.2 Ask

항상 질문해야 함.

예시:

```text
- 패키지 설치
- 파일 생성/수정
- 테스트/빌드 실행이 오래 걸릴 가능성
- config 변경
- migration
- 배포
```

### 7.3 Deny

금지.

예시:

```text
- secret 출력
- curl | sh
- production DB 직접 변경
- 대량 삭제
```

---

## 8. settings / hooks 적용 메모

Claude Code에서 permissions, settings, hooks를 사용할 수 있다면 다음 원칙으로 적용한다.

```text
- 안전한 반복 작업만 allow
- 위험 작업은 ask
- secret 접근과 destructive command는 deny
- hook은 자동 승인 도구가 아니라 차단 장치로 사용
```

---

## 9. 하네스 자체의 권한 정책

하네스 v1은 실제 파일 수정을 하지 않는다.

하네스 v1이 할 수 있는 작업:

```text
- 프로젝트 docs 생성
- agent output markdown 저장
- CONTEXT_SUMMARY.md 갱신
- Claude Code 작업 지시문 생성
```

하네스 v1이 하지 않는 작업:

```text
- 소스 코드 수정
- 패키지 설치
- 배포
- DB 변경
- git push
- 외부 도구 실행
```

---

## 10. 완료 기준

이 문서가 적용되면 다음이 가능해야 한다.

```text
- Claude Code의 승인 질문이 줄어든다.
- 위험 작업은 자동 실행되지 않는다.
- 사용자가 어떤 작업을 승인해야 하는지 명확해진다.
- 하네스 v1 범위가 안전하게 유지된다.
```
