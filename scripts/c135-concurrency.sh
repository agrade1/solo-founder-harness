#!/usr/bin/env bash
# [C-135] pipeline lock 동시 실행 **실측** — 두 프로세스를 실제로 경합시킨다.
#
# 왜 셸 스크립트가 정본인가: `outputs/pipeline.lock`은 O_EXCL(파일시스템)로 배타를 만든다.
# 같은 프로세스 안에서 두 번째 `writeFileSync(flag:"wx")`도 정직하게 실패하므로 단위 테스트가
# 거짓 GREEN을 주지는 않지만, 그것이 "두 프로세스가 경합했다"의 증거는 아니다 — 프로세스 경계·
# SIGKILL·PID 생존판정은 진짜 프로세스가 있어야만 재진다. 자동화 가능한 성질은
# `src/commands/pipeline.test.ts`가 들고 있고, 그러지 못한 것(실제 spawn·SIGKILL·PID 재사용)은
# 이 파일이 정본이다.
#
# 무과금: provider는 mock 기본값 고정. live provider(claude-code/anthropic)를 부르지 않는다.
# 사용: bash scripts/c135-concurrency.sh [a|b|c|all]   (N=ⓐ 반복횟수, 기본 20)
set -uo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || exit 1

# 작업공간은 이미 gitignore된 .tmp-test-workspace 아래 — 레포의 projects/를 더럽히지 않는다.
WS="$ROOT/.tmp-test-workspace/c135"
LOGS="$WS/logs"
PROJ=c135a
N=${N:-20}
PHASE=${1:-all}
TSX="$ROOT/node_modules/.bin/tsx"
CLI="$ROOT/src/cli.ts"
PROOT="$WS/projects/$PROJ"
PSTATE="$PROOT/outputs/pipeline_state.json"
RSTATE="$PROOT/outputs/run_state.json"
LOCK="$PROOT/outputs/pipeline.lock"
ANSWER="$WS/answer.flag"

export HARNESS_WORKSPACE="$WS"

harness() { "$TSX" "$CLI" "$@"; }

# pipeline_state의 필드 하나를 읽는다. 파싱 실패는 "!" — 조용히 기본값을 주지 않는다.
pstate() { python3 -c '
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    print("!"); raise SystemExit(0)
k = sys.argv[2]
if k == "ncp": print(len(s["checkpoints"]))
elif k == "haspending": print(s["pending"] is not None)
elif k.startswith("pending."): print((s["pending"] or {}).get(k[8:], "None"))
else: print(s.get(k, "None"))' "$PSTATE" "$1"; }

parses() { python3 -c 'import json,sys;json.load(open(sys.argv[1]))' "$1" >/dev/null 2>&1; }

# next 로그 하나를 사유로 분류한다 (CLI가 내는 문장이 안정 사유의 대리다)
classify() {
  if grep -q "단계 완료" "$1"; then echo RAN
  elif grep -q "pipeline_locked" "$1"; then echo LOCKED
  elif grep -q "승인 시점 바이트와 다릅니다" "$1"; then echo DRIFT
  elif grep -q "전진하지 않았습니다" "$1"; then echo PENDING
  else echo OTHER; fi
}

setup() {
  rm -rf "$WS"
  mkdir -p "$LOGS"
  harness init "$PROJ" >"$LOGS/init.log" 2>&1 || { echo "init 실패"; cat "$LOGS/init.log"; exit 1; }
  cat >"$PROOT/docs/00_IDEA.md" <<'IDEA'
# 00_IDEA

## 아이디어 한 줄 정의

- 1인 개발자를 위한 구독 결제 해지 대행 앱 — 흩어진 구독을 한 화면에 모아 해지까지 대신 처리한다.

## 문제

- 사람들은 자신이 어떤 구독에 얼마를 내는지 모른다. 해지 절차가 서비스마다 달라 미루다 계속 결제된다.

## 대상 사용자

- 월 5개 이상 구독을 쓰는 20~40대 직장인.

## 가설

- 구독 목록 자동 수집 + 해지 원클릭이면 월 1만원 이상 절감이 관측되고, 절감액의 20%를 수수료로 받을 수 있다.
IDEA
}

# ── ⓐ 동시 `pipeline next` 2개 ─────────────────────────────────
phase_a() {
  echo "=== ⓐ 동시 next ×2 · ${N}회 ==="
  # torn read 탐침을 **여기서** 돈다: lock 없이 도는 독자(`status`가 하는 일)가 두 writer가
  # 경합하는 동안 찢어진 바이트를 보는가. pipeline_state.json은 tmp+rename(원자),
  # run_state.json은 직접 writeFileSync — 같은 창에서 둘을 비교한다.
  local stopfile="$WS/torn.stop"; rm -f "$stopfile"
  python3 -c '
import json, os, sys
paths = {"pipeline_state": sys.argv[1], "run_state": sys.argv[2]}
n = {k: 0 for k in paths}; bad = {k: 0 for k in paths}
while not os.path.exists(sys.argv[4]):     # sentinel 파일로 멈춘다 (시그널 경로를 만들지 않는다)
    for k, p in paths.items():
        try:
            json.load(open(p)); n[k] += 1
        except FileNotFoundError:
            pass
        except Exception:
            n[k] += 1; bad[k] += 1
open(sys.argv[3], "w").write(" · ".join(f"{k} {bad[k]}/{n[k]} 실패" for k in paths) + "\n")
' "$PSTATE" "$RSTATE" "$LOGS/a-torn.txt" "$stopfile" &
  local probe=$!
  local ran=0 locked=0 pending=0 other=0 both=0 bad=0
  local i e1 e2 c1 c2 c cp p1 p2 st pend ncp
  for ((i=1;i<=N;i++)); do
    harness pipeline next --project "$PROJ" --yes-internal-gates >"$LOGS/a-$i-1.log" 2>&1 &
    p1=$!
    harness pipeline next --project "$PROJ" --yes-internal-gates >"$LOGS/a-$i-2.log" 2>&1 &
    p2=$!
    wait $p1; e1=$?
    wait $p2; e2=$?
    c1=$(classify "$LOGS/a-$i-1.log"); c2=$(classify "$LOGS/a-$i-2.log")
    for c in "$c1" "$c2"; do
      case $c in
        RAN) ran=$((ran+1));;
        LOCKED) locked=$((locked+1));;
        PENDING) pending=$((pending+1));;
        *) other=$((other+1));;
      esac
    done
    # 불변식 ①: 한 회차에 단계가 두 번 돌았으면 배타가 깨진 것이다.
    [[ $c1 == RAN && $c2 == RAN ]] && both=$((both+1))
    # 불변식 ②: 전이는 정확히 한 번 = awaiting_approval · pending 1개 · checkpoints는 그대로(i-1)
    st=$(pstate status); pend=$(pstate haspending); ncp=$(pstate ncp)
    if [[ $st != awaiting_approval || $pend != True || $ncp != $((i-1)) ]]; then
      bad=$((bad+1)); echo "  [$i] ⚠ 상태 이상: status=$st pending=$pend checkpoints=$ncp (기대 $((i-1)))"
    fi
    parses "$RSTATE" || { bad=$((bad+1)); echo "  [$i] ⚠ run_state.json 파싱 실패"; }
    [[ -e $LOCK ]] && { bad=$((bad+1)); echo "  [$i] ⚠ lock 파일이 남았다"; }
    echo "  [$i] exit=$e1/$e2 · $c1/$c2 · checkpoints=$ncp"
    # 리셋은 reject로 (내부 파일을 손대지 않는다) — 같은 단계 awaiting_run으로 돌아간다.
    cp=$(pstate pending.checkpoint_id)
    harness pipeline reject idea-validation --checkpoint "$cp" --project "$PROJ" >"$LOGS/a-$i-reset.log" 2>&1 \
      || { echo "  [$i] ⚠ reset 실패"; cat "$LOGS/a-$i-reset.log"; return 1; }
  done
  touch "$stopfile"; wait "$probe" 2>/dev/null
  echo "ⓐ 합계: RAN=$ran LOCKED=$locked PENDING=$pending OTHER=$other · 둘다RAN=$both · 상태이상=$bad · 회차=$N"
  echo "ⓐ torn read(lock 없는 독자): $(cat "$LOGS/a-torn.txt" 2>/dev/null || echo '(탐침 결과 없음)')"
}

# `next`를 workflow **내부 승인**에서 멈춰 세운다 — lock을 쥔 채로 창이 열린다.
# 새 프로덕션 코드를 넣지 않는다: mvp-planning의 approval step + stdinApprover가 이미 그 seam이다.
#
# stdin은 **평범한 파이프**다(fifo가 아니다). 실측으로 확인한 차이:
#   TTY(사람이 y 입력·열린 채) → 종료 O · 파이프(즉시 EOF / 답 8초 뒤 EOF) → 종료 O ·
#   **fifo(답 직후 writer close) → 종료 X (영원히 매달린다)**.
# 마지막 것은 node의 fifo stdin 처리 특성이고 **실험 도구의 함정**이다. 그 함정 위에서 재면
# "owner가 lock을 영원히 쥔다"는 프로덕션 결함으로 오독된다 — 그래서 파이프로 잰다.
start_blocked_next() { # $1 = 로그 경로 → BLOCKED_PID 설정
  rm -f "$ANSWER"
  # writer는 sentinel이 생길 때까지 기다렸다가 y를 쓰고 **종료한다**(= EOF까지 준다).
  # `exec`로 배경 job 자체를 tsx로 바꾼다: 감싸는 subshell을 남기면 kill 대상이 흐려진다.
  # writer 루프에 상한을 둔다: 상한이 없으면 owner를 죽인 회차에서 이 subshell이 **영원히 돈다**
  # (`wait <pid>`는 그 pid가 속한 **job 전체**를 기다리므로 스크립트도 같이 매달린다 — 실측으로 밟았다).
  { local w=0
    while [[ ! -e $ANSWER && $w -lt 1200 ]]; do perl -e 'select undef,undef,undef,0.05'; w=$((w+1)); done
    echo y; } \
    | { exec "$TSX" "$CLI" pipeline next --project "$PROJ"; } >"$1" 2>&1 &
  BLOCKED_PID=$!
  local w=0
  until grep -q "승인 필요" "$1" 2>/dev/null; do
    w=$((w+1)); [[ $w -gt 400 ]] && { echo "  ⚠ 승인 프롬프트가 뜨지 않았다"; cat "$1"; touch "$ANSWER"; return 1; }
    perl -e 'select undef,undef,undef,0.05'
  done
}
release_blocked_next() { touch "$ANSWER"; wait "$BLOCKED_PID"; }

# ⓑ·ⓒ는 **내부 approval step이 있는 단계**가 필요하다 — 1단계(idea-validation)에는 없다.
# 1단계를 돌려 승인하고 2단계(mvp-planning)를 실행 대기로 세운다. → CP1에 1단계 checkpoint id.
advance_to_stage2() { # $1 = 로그 접두어
  harness pipeline next --project "$PROJ" --yes-internal-gates >"$LOGS/$1-pre-next.log" 2>&1
  CP1=$(pstate pending.checkpoint_id)
  harness pipeline approve idea-validation --checkpoint "$CP1" --project "$PROJ" >"$LOGS/$1-pre-approve.log" 2>&1
}

lock_pid() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$LOCK"; }
set_lock_pid() { python3 -c '
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["pid"] = int(sys.argv[2])
open(p, "w").write(json.dumps(d, indent=2) + "\n")' "$LOCK" "$1"; }

# ── ⓑ next 보유 중 approve / status / unlock + torn read ───────
phase_b() {
  echo "=== ⓑ next 보유 중 approve / status / unlock ==="
  advance_to_stage2 b
  local cp1=$CP1
  echo "  준비: index=$(pstate current_index) status=$(pstate status)"

  start_blocked_next "$LOGS/b-blocked.log" || return 1
  echo "  lock 보유 중 (owner pid $(lock_pid))"

  # lock을 쥔 owner가 살아 있는 동안 **mutating 4개는 전부 막히고**, 읽기 2개는 돈다.
  local e before after
  before=$(shasum -a 256 "$PSTATE" | cut -c1-16)
  harness pipeline approve idea-validation --checkpoint "$cp1" --project "$PROJ" >"$LOGS/b-approve.log" 2>&1; e=$?
  echo "  approve exit=$e · $(head -1 "$LOGS/b-approve.log")"
  harness pipeline reject idea-validation --checkpoint "$cp1" --project "$PROJ" >"$LOGS/b-reject.log" 2>&1; e=$?
  echo "  reject  exit=$e · $(grep -o 'pipeline_locked' "$LOGS/b-reject.log" | head -1)"
  harness pipeline restart --project "$PROJ" >"$LOGS/b-restart.log" 2>&1; e=$?
  echo "  restart exit=$e · $(grep -o 'pipeline_locked' "$LOGS/b-restart.log" | head -1)"
  harness pipeline next --project "$PROJ" --yes-internal-gates >"$LOGS/b-next2.log" 2>&1; e=$?
  echo "  next    exit=$e · $(classify "$LOGS/b-next2.log")"
  harness pipeline status --project "$PROJ" >"$LOGS/b-status.log" 2>&1; e=$?
  echo "  status  exit=$e · lock표시=$(grep -c '^lock:' "$LOGS/b-status.log") · 상태줄=$(grep -c '파이프라인 founder-predev' "$LOGS/b-status.log")"
  harness pipeline unlock --project "$PROJ" >"$LOGS/b-unlock.log" 2>&1; e=$?
  echo "  unlock  exit=$e · $(head -1 "$LOGS/b-unlock.log")"
  if [[ -e $LOCK ]]; then echo "  lock 유지됨 ✓"; else echo "  ⚠ lock이 사라졌다"; fi
  after=$(shasum -a 256 "$PSTATE" | cut -c1-16)
  if [[ $before == "$after" ]]; then echo "  거부된 6개 명령 뒤 pipeline_state 바이트 불변 ✓ ($before)"
  else echo "  ⚠ pipeline_state가 바뀌었다: $before → $after"; fi

  release_blocked_next
  echo "  owner 종료 후: lock 존재=$([[ -e $LOCK ]] && echo yes || echo no) · status=$(pstate status) · 단계=$(pstate pending.stage)"
  echo "  run_state 파싱=$(parses "$RSTATE" && echo ok || echo FAIL)"
}

# ── ⓒ 죽은 lock 회수 · PID 재사용 ──────────────────────────────
phase_c() {
  echo "=== ⓒ SIGKILL로 남은 lock · unlock 회수 · PID 재사용 ==="
  advance_to_stage2 c
  start_blocked_next "$LOGS/c-blocked.log" || return 1
  # 죽일 대상은 **lock에 적힌 owner**다: `node_modules/.bin/tsx`는 wrapper라 $! 는 그 wrapper이고,
  # 실제 lock 보유자는 그 자식이다. wrapper를 죽이면 owner가 살아남아 실험이 성립하지 않는다.
  local owner; owner=$(lock_pid)
  kill -9 "$owner" 2>/dev/null
  kill -9 "$BLOCKED_PID" 2>/dev/null
  touch "$ANSWER"   # 답을 기다리던 writer를 풀어 준다 — job 전체가 끝나야 wait가 돌아온다
  wait "$BLOCKED_PID" 2>/dev/null
  echo "  SIGKILL 후 lock 존재=$([[ -e $LOCK ]] && echo yes || echo no) · 기록된 owner pid=$owner"

  local e
  harness pipeline next --project "$PROJ" --yes-internal-gates >"$LOGS/c-next-blocked.log" 2>&1; e=$?
  echo "  죽은 lock 상태의 next exit=$e · $(classify "$LOGS/c-next-blocked.log")"

  # PID 재사용 흉내: lock 안 pid를 **살아 있는 무관한 프로세스**로 바꾼다 → 회수를 거부해야 한다.
  perl -e 'sleep 60' &
  local alive=$!
  set_lock_pid "$alive"
  harness pipeline unlock --project "$PROJ" >"$LOGS/c-unlock-alive.log" 2>&1; e=$?
  echo "  PID재사용(살아있는 pid $alive) unlock exit=$e · $(head -1 "$LOGS/c-unlock-alive.log")"
  if [[ -e $LOCK ]]; then echo "  → 회수 거부 ✓ (lock 유지)"; else echo "  ⚠ 살아있는 pid인데 회수했다"; fi

  set_lock_pid 1   # EPERM = 판별 불가 → 살아 있는 쪽으로 fail closed 여야 한다
  harness pipeline unlock --project "$PROJ" >"$LOGS/c-unlock-eperm.log" 2>&1; e=$?
  echo "  pid 1(EPERM) unlock exit=$e · lock 존재=$([[ -e $LOCK ]] && echo yes || echo no)"

  kill "$alive" 2>/dev/null; wait "$alive" 2>/dev/null
  set_lock_pid "$owner"   # 진짜 죽은 owner로 되돌린 뒤 회수
  harness pipeline unlock --project "$PROJ" >"$LOGS/c-unlock-dead.log" 2>&1; e=$?
  echo "  죽은 owner unlock exit=$e · lock 존재=$([[ -e $LOCK ]] && echo yes || echo no)"
  harness pipeline next --project "$PROJ" --yes-internal-gates >"$LOGS/c-next-after.log" 2>&1; e=$?
  echo "  회수 후 next exit=$e · $(classify "$LOGS/c-next-after.log")"

  # 실행 도중 SIGKILL ×10 — 상태 파일이 깨진 채 남는지 (원자 쓰기의 실측).
  #
  # **프로젝트를 새로 세우고 1단계에서 잰다.** 위에서 쓰던 프로젝트로 이어서 재면 모든 next가
  # `pipeline_artifact_drift`에 먼저 걸려 **아무 일도 하지 않고** 죽는다 — "손상 0"이 공허해진다
  # (첫 판에서 실제로 그렇게 쟀고, 로그를 열어 보고서야 알았다).
  setup
  local k kp w cp stuck=0 rs_bad=0 ps_bad=0 midrun=0
  for ((k=1;k<=10;k++)); do
    # 앞 회차가 완주했으면 되돌려 놓는다 — 확인 대기 상태의 next는 아무 일도 안 하고 끝나서
    # 그 회차의 SIGKILL이 공허해진다.
    if [[ $(pstate haspending) == True ]]; then
      cp=$(pstate pending.checkpoint_id)
      harness pipeline reject idea-validation --checkpoint "$cp" --project "$PROJ" >"$LOGS/c-kill-$k-reset.log" 2>&1
    fi
    harness pipeline next --project "$PROJ" --yes-internal-gates >"$LOGS/c-kill-$k.log" 2>&1 &
    kp=$!
    # **lock이 생기기를 기다렸다가 그 구간 안에서** 죽인다 = owner가 확실히 일하는 중이다.
    # 셸로 어림잡으면 안 된다: 시간 난수(0.4~0.9s)는 10/10이 완주 뒤에 떨어졌고, perl로 폴링하니
    # 2/10만 잡혔다(프로세스 기동 비용이 lock 보유 구간보다 크다). 한 프로세스 안에서 재고 죽인다.
    # 죽일 것은 lock에 적힌 owner다 — `$!`는 함수를 감싼 subshell이라 그걸 죽이면 owner가 살아남는다.
    python3 -c '
import json, os, random, sys, time
lock = sys.argv[1]; t0 = time.time()
while not os.path.exists(lock) and time.time() - t0 < 10: time.sleep(0.002)
if not os.path.exists(lock): raise SystemExit(3)          # 끝까지 lock을 못 봤다
time.sleep(random.uniform(0, float(sys.argv[2])))
try: pid = json.load(open(lock))["pid"]
except Exception: raise SystemExit(4)                     # 그 사이 놓아 버렸다
try: os.kill(pid, 9)
except Exception: raise SystemExit(5)
' "$LOCK" 0.15
    [[ $? -eq 0 ]] && midrun=$((midrun+1))
    kill -9 $kp 2>/dev/null; wait $kp 2>/dev/null
    if [[ -e $LOCK ]]; then
      harness pipeline unlock --project "$PROJ" >"$LOGS/c-kill-$k-unlock.log" 2>&1 || stuck=$((stuck+1))
    fi
    if [[ -e $PSTATE ]]; then parses "$PSTATE" || ps_bad=$((ps_bad+1)); fi
    if [[ -e $RSTATE ]]; then parses "$RSTATE" || rs_bad=$((rs_bad+1)); fi
  done
  echo "  실행중 SIGKILL ×10 → 실제로 lock 쥔 채 죽음=$midrun/10 · pipeline_state 손상=$ps_bad · run_state 손상=$rs_bad · unlock 실패=$stuck"
  harness pipeline next --project "$PROJ" --yes-internal-gates >"$LOGS/c-final.log" 2>&1; e=$?
  echo "  마지막 next exit=$e · $(classify "$LOGS/c-final.log")"
}

case "$PHASE" in
  a) setup; phase_a;;
  b) setup; phase_b;;
  c) setup; phase_c;;
  # 각 phase는 **자기 setup으로 시작한다**: 앞 phase가 남긴 단계/승인 바이트를 물려받으면
  # 다음 phase가 pipeline_artifact_drift에 걸려 재는 것이 달라진다(실측으로 밟았다).
  all) setup; phase_a; setup; phase_b; setup; phase_c;;
  *) echo "usage: $0 [a|b|c|all]"; exit 1;;
esac
