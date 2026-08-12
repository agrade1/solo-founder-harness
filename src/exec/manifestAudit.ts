/**
 * V3 M7 T1 — 승인 manifest **정적 감사**(대장 `C-67`). read-only이며 아무것도 실행하지 않는다.
 *
 * kernel은 *실행 시점*에 manifest를 집행한다(`approvalManifest.ts`). 여기는 그 앞이다: **이미 유효한**
 * manifest가 서로 모순되거나 지나치게 넓은지를 사람이 승인하기 전에 읽어 보고한다.
 *
 * `src/tools/preflight.ts`와 중복되지 않는다 — 그쪽은 실제 `claude` headless 세션의 MCP 서버/도구
 * init 스냅샷을 실측 비교하는 **런타임** 게이트이고, 이쪽은 파일 존재 여부 외에는 프로세스도 네트워크도
 * 건드리지 않는 **정적 판정 함수**다.
 *
 * 진단만 낸다 — 아무것도 던지지 않고 아무것도 차단하지 않는다. 차단은 kernel의 몫이다.
 */
import { existsSync } from "node:fs";
import type { MilestoneApprovalManifest } from "./orchestrationTypes.js";
import { pathWithin } from "./approvalManifest.js";

/** 승인 만료 상한 — 이보다 먼 `expiresAt`은 "무기한 승인"에 가깝다고 보고한다. */
export const MAX_APPROVAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type AuditSeverity = "high" | "medium";

export interface AuditFinding {
  rule: string;
  severity: AuditSeverity;
  subject: string; // 어느 필드/값인가
  message: string;
}

export interface AuditManifestOpts {
  /** 만료 판정 기준 시각(ISO). 테스트 결정성을 위해 주입한다. */
  now: string;
  /** 파일 존재 확인 seam. 기본은 실제 파일 시스템(read-only). */
  exists?: (path: string) => boolean;
}

/**
 * 감사 결과는 `rule`+`subject` 사전순으로 고정한다 — 같은 manifest가 두 가지 보고로 나오지 않게 한다.
 */
export function auditApprovalManifest(manifest: MilestoneApprovalManifest, opts: AuditManifestOpts): AuditFinding[] {
  const exists = opts.exists ?? existsSync;
  const out: AuditFinding[] = [];

  // R1 — 다른 writableRoot를 통째로 덮는 root. 넓은 쪽 하나면 좁은 쪽 승인은 의미가 없다.
  for (const root of manifest.writableRoots) {
    for (const other of manifest.writableRoots) {
      if (other !== root && pathWithin(other, root)) {
        out.push({
          rule: "writable_root_covers_another",
          severity: "high",
          subject: root,
          message: `writableRoots의 '${root}'가 '${other}'를 통째로 덮는다 — 좁은 쪽만 승인하거나 넓은 쪽을 좁혀라`,
        });
        break;
      }
    }
  }

  // R2 — 어떤 task ownership도 쓰지 않는 writableRoot. 아무도 안 쓰는 쓰기 권능이 승인돼 있다.
  const ownedPaths = Object.values(manifest.ownershipByTask).flat();
  for (const root of manifest.writableRoots) {
    if (!ownedPaths.some((p) => pathWithin(p, root))) {
      out.push({
        rule: "writable_root_unowned",
        severity: "medium",
        subject: root,
        message: `writableRoots의 '${root}'를 ownership으로 쓰는 task가 없다 — 사용되지 않는 쓰기 승인이다`,
      });
    }
  }

  // R3 — ownership 없는 task에 typed operation 권위만 승인돼 있다(권능과 소유의 불일치).
  for (const taskId of Object.keys(manifest.operationAuthorityByTask).sort()) {
    if (!Object.prototype.hasOwnProperty.call(manifest.ownershipByTask, taskId)) {
      out.push({
        rule: "authority_without_ownership",
        severity: "high",
        subject: taskId,
        message: `operationAuthorityByTask['${taskId}']에 권능이 있으나 ownershipByTask에 그 task가 없다`,
      });
    }
  }

  // R4 — 승인 창이 과도하게 길다(사실상 무기한 승인).
  const windowMs = Date.parse(manifest.expiresAt) - Date.parse(opts.now);
  if (windowMs > MAX_APPROVAL_WINDOW_MS) {
    out.push({
      rule: "expiry_too_far",
      severity: "high",
      subject: manifest.expiresAt,
      message: `expiresAt이 기준 시각에서 ${Math.round(windowMs / 3_600_000)}시간 뒤다 — 상한 ${MAX_APPROVAL_WINDOW_MS / 3_600_000}시간을 넘는다`,
    });
  }

  // R5 — digest가 가리키는 실행 파일/디렉터리가 이미 부재. 승인이 존재하지 않는 대상을 가리킨다.
  const a = manifest.executionAuthority;
  const targets: [string, string][] = [
    ...(a.codex ? ([["executionAuthority.codex", a.codex.path]] as [string, string][]) : []),
    ...(a.codexHome ? ([["executionAuthority.codexHome", a.codexHome.path]] as [string, string][]) : []),
    ["executionAuthority.controllerEntrypoint", a.controllerEntrypoint.path],
    ["executionAuthority.git", a.git.path],
    ["executionAuthority.node", a.node.path],
    ["executionAuthority.processObserver", a.processObserver.path],
  ];
  for (const [field, path] of targets) {
    if (!exists(path)) {
      out.push({
        rule: "approved_path_missing",
        severity: "high",
        subject: field,
        message: `${field}가 가리키는 경로가 없다: ${path}`,
      });
    }
  }

  return out.sort((x, y) => (x.rule + x.subject < y.rule + y.subject ? -1 : x.rule + x.subject > y.rule + y.subject ? 1 : 0));
}
