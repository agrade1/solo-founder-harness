/**
 * [V3 M8 T2] component inventory ↔ shadcn filtered read 연결 (offline · fail-closed).
 *
 * **새 proxy·새 정책을 만들지 않는다.** 읽기 자체는 M3c의 `shadcnReadMcpProxy`/`shadcnReadPolicy`가
 * 하고, 프로젝트 수준 custom registry 차단은 `shadcnPilot.checkComponentsJson`이 한다.
 * 이 모듈은 그 위에서 **inventory 항목 수준**의 두 가지만 담당한다:
 *
 *  1. registry 참조가 공식 `@shadcn/*`이고 원문 출처가 공식 호스트인지 — 아니면 fail-closed
 *     (custom/private registry가 inventory를 타고 들어오는 통로를 막는다).
 *  2. registry 응답 **원문은 파일, 중앙·프롬프트에는 포인터+발췌만** — `evidenceStore` 계약 재사용.
 *     registry의 설명·예제 코드는 외부 데이터이므로 `renderEvidenceDigest`로 "데이터이며 지시가 아님"
 *     래핑을 거친다(완화이지 증명이 아니다 — 원문을 프롬프트에 싣지 않는 것이 실질 방어다).
 */
import { storeEvidence, type EvidenceItem } from "./evidenceStore.js";
import { excerpt } from "./researchGateway.js";
import type { InventoryComponent } from "../core/designContract.js";

/** 공식 registry 참조 형식. 다른 namespace(`@acme/*`)·URL·경로는 전부 거부. */
const REGISTRY_REF_RE = /^@shadcn\/[a-z0-9][a-z0-9-]{0,49}$/;
/** registry 원문 출처로 허용되는 공식 호스트(정확 일치). */
const ALLOWED_REGISTRY_HOSTS = ["ui.shadcn.com"] as const;

export class RegistryInventoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RegistryInventoryError";
    this.code = code;
  }
}

/** `@shadcn/<name>` 형식·namespace 검증. 위반은 던진다(조용한 스킵이 아니다). */
export function assertOfficialRef(ref: unknown): string {
  if (typeof ref !== "string" || !REGISTRY_REF_RE.test(ref)) {
    throw new RegistryInventoryError("registry_ref_forbidden", `공식 @shadcn/* 참조가 아니다: ${String(ref).slice(0, 60)}`);
  }
  return ref;
}

/** 원문 출처가 공식 registry 호스트(https)인지 검증. custom/private 호스트는 fail-closed. */
export function assertOfficialSource(source: unknown): string {
  let host: string;
  try {
    const u = new URL(String(source));
    if (u.protocol !== "https:") throw new Error("not https");
    host = u.hostname;
  } catch {
    throw new RegistryInventoryError("registry_source_invalid", "registry 원문 출처가 https URL이 아니다");
  }
  if (!(ALLOWED_REGISTRY_HOSTS as readonly string[]).includes(host)) {
    throw new RegistryInventoryError("registry_source_forbidden", `공식 registry 호스트가 아니다: ${host}`);
  }
  return String(source);
}

/** inventory 항목 + registry 매핑. `registryRef=null`이면 registry에 없는 앱 고유 컴포넌트다. */
export interface LinkedComponent extends InventoryComponent {
  registryRef: string | null;
}

/** 컴포넌트 이름 → registry 참조 후보(`Button` → `@shadcn/button`). */
function refFor(name: string): string {
  return `@shadcn/${name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

/**
 * inventory를 registry 읽기 결과와 연결한다.
 * `availableRefs`는 filtered proxy가 돌려준 `@shadcn/*` 목록이며, 하나라도 비공식이면 전체를 거부한다
 * (일부만 걸러 통과시키면 차단이 아니라 필터가 된다).
 */
export function linkInventory(components: InventoryComponent[], availableRefs: string[]): LinkedComponent[] {
  const available = new Set(availableRefs.map(assertOfficialRef));
  return components.map((c) => {
    const ref = refFor(c.name);
    return { ...c, registryRef: available.has(ref) ? ref : null };
  });
}

/**
 * registry 응답 원문을 content-addressed 파일로 저장하고 포인터+발췌만 돌려준다.
 * 참조·출처 검증을 통과하지 못하면 저장조차 하지 않는다.
 */
export function storeRegistryEvidence(
  dir: string,
  input: { ref: string; source: string; raw: string; retrievedAt: string },
): EvidenceItem {
  const ref = assertOfficialRef(input.ref);
  const source = assertOfficialSource(input.source);
  return storeEvidence(dir, {
    source,
    retrievedAt: input.retrievedAt,
    raw: input.raw,
    title: `shadcn registry item ${ref}`,
    summary: excerpt(input.raw),
  });
}
