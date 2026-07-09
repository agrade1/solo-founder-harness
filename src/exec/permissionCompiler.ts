/**
 * 권한 컴파일러 (ARCH §9-3, §4.2 권한 티어, §8 안전 baseline).
 * (SessionSpec + permission_policy.json) → Claude Code 권한 규칙(allow/ask/deny) + settings 객체 + 훅 패턴.
 *
 * 티어 매핑 (PERMISSION_POLICY.md §7):
 *   T0(읽기)·T1(경계 내) → allow / T2(정책) → ask / T3(금지) → deny.
 * T3의 파이프·특수 케이스(curl|sh, main push)는 규칙으로 표현이 어려워 hookDenyPatterns로 분리
 * → 향후 PreToolUse 가드 스크립트(§9-4 이후)가 소비.
 *
 * ⚠ CLI 검증 미완: `--settings`가 permissions.allow/ask/deny를 이 형태로 수용하는지,
 * 규칙 문자열 문법(`Bash(cmd:*)`, `Read(glob)`)의 정확성은 end-to-end 시 실측 필요(RECON에 기록).
 * 이 모듈의 단위 테스트는 매핑 로직만 검증한다(무과금).
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fromPackage } from "../core/paths.js";
import type { SessionSpec } from "./types.js";

interface TierRead {
  tools: string[];
  bash: string[];
}
interface TierT3 {
  bash: string[];
  read_deny: string[];
  hook_deny_patterns: string[];
}
export interface PermissionPolicy {
  version: number;
  permissionMode: string;
  tiers: {
    T0_read: TierRead;
    T1_bounded: TierRead;
    T2_policy: TierRead;
    T3_forbidden: TierT3;
  };
}

export interface CompiledPermissions {
  permissionMode: string;
  allow: string[]; // Claude Code 권한 규칙 문자열
  ask: string[];
  deny: string[];
  hookDenyPatterns: string[]; // 규칙으로 표현 못 하는 T3 정규식 (curl|sh 등) — 가드 훅용
  ownership: string[]; // 담당 경로 glob (쓰기 경계 — 향후 훅에서 강제)
  settings: { permissions: { allow: string[]; ask: string[]; deny: string[] } };
}

const POLICY_PATH = "registry/permission_policy.json";

/** registry/permission_policy.json 로드. */
export function loadPermissionPolicy(): PermissionPolicy {
  const abs = fromPackage(POLICY_PATH);
  if (!existsSync(abs)) throw new Error(`권한 정책 파일 없음: ${POLICY_PATH}`);
  return JSON.parse(readFileSync(abs, "utf8")) as PermissionPolicy;
}

/** bash 명령 접두어 → Claude Code Bash 규칙. */
function bashRule(cmd: string): string {
  return `Bash(${cmd}:*)`;
}
/** 중복 제거하며 순서 유지. */
function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/**
 * SessionSpec + 정책 → 컴파일된 권한.
 * spec.allowedTools/disallowedTools는 spec-레벨 추가분으로 합쳐진다(정책이 바닥).
 */
export function compilePermissions(spec: SessionSpec, policy: PermissionPolicy = loadPermissionPolicy()): CompiledPermissions {
  const { T0_read, T1_bounded, T2_policy, T3_forbidden } = policy.tiers;

  const allow = uniq([
    ...T0_read.tools,
    ...T0_read.bash.map(bashRule),
    ...T1_bounded.tools,
    ...T1_bounded.bash.map(bashRule),
    ...(spec.allowedTools ?? []),
  ]);

  const ask = uniq([...T2_policy.tools, ...T2_policy.bash.map(bashRule)]);

  const deny = uniq([
    ...T3_forbidden.bash.map(bashRule),
    ...T3_forbidden.read_deny.map((g) => `Read(${g})`),
    ...(spec.disallowedTools ?? []),
  ]);

  return {
    permissionMode: spec.permissionMode ?? policy.permissionMode,
    allow,
    ask,
    deny,
    hookDenyPatterns: [...T3_forbidden.hook_deny_patterns],
    ownership: spec.ownership ?? [],
    settings: { permissions: { allow, ask, deny } },
  };
}

/**
 * 컴파일된 settings를 파일로 써서 --settings로 넘길 경로를 반환한다.
 * dir/settings.json에 기록(디렉토리는 필요 시 생성).
 */
export function materializeSettings(dir: string, compiled: CompiledPermissions): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify(compiled.settings, null, 2) + "\n", "utf8");
  return path;
}
