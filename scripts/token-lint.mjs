#!/usr/bin/env node
/**
 * 디자인 토큰 린트 (디자인 레이어 킥오프 §6). LLM 없이 정적 검사만.
 *   1) 소스의 raw hex 컬러 검출 (tokens 정의값이면 "토큰 교체" 경고, 미정의면 "미등록" 오류)
 *   2) primitive 토큰 직접 참조 검출 (semantic/component를 거치지 않은 사용)
 *   3) tokens.json 자체 검증 (계층 규율·참조 존재·순환 없음)
 * 예외: 줄에 `token-lint-ignore` 포함 시 그 줄 건너뜀.
 *
 * 사용: node scripts/token-lint.mjs [--tokens docs/tokens.json] [scanPath...]
 *   scanPath 기본 "." (node_modules/.harness/.git/dist/docs 제외).
 * exit 0 = 위반 0건, 1 = 위반 있음(또는 tokens.json 없음/파싱 실패).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

const SOURCE_EXT = new Set([".tsx", ".jsx", ".ts", ".js", ".css", ".scss", ".vue", ".svelte"]);
const SKIP_DIR = new Set(["node_modules", ".git", ".harness", "dist", "build", "docs", "coverage", ".next"]);
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const PRIMITIVE_REF_RE = /(--primitive-[\w-]+|\bprimitive\.[\w.-]+|tokens\.primitive\b)/g;

function parseArgs(argv) {
  let tokensPath = "docs/tokens.json";
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tokens") tokensPath = argv[++i];
    else paths.push(argv[i]);
  }
  return { tokensPath, paths: paths.length ? paths : ["."] };
}

/** {a:{b:"x"}} → Map("a.b" => "x") (leaf 문자열만). */
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, path, out);
    else out.set(path, String(v));
  }
  return out;
}

function refTarget(val) {
  const m = /^\{(.+)\}$/.exec(val.trim());
  return m ? m[1].trim() : null;
}

/** tokens.json 구조 검증 → 위반 배열. */
function validateTokens(tokensPath) {
  const violations = [];
  let json;
  try {
    json = JSON.parse(readFileSync(tokensPath, "utf8"));
  } catch (e) {
    return { violations: [{ level: "error", file: tokensPath, line: 0, msg: `tokens.json 파싱 실패: ${e.message}` }], flat: new Map() };
  }
  const flat = new Map();
  flatten(json.primitive, "primitive", flat);
  flatten(json.semantic, "semantic", flat);
  flatten(json.component, "component", flat);

  const allowed = { semantic: "primitive", component: "semantic" };
  for (const [path, val] of flat) {
    const layer = path.split(".")[0];
    const ref = refTarget(val);
    if (ref === null) {
      if (layer !== "primitive" && /^#|px$|rem$|em$/.test(val) === false && !/^\d/.test(val)) {
        // semantic/component가 raw 문자열이어도 치명적이진 않으나 참조 권장 — 정보성 생략
      }
      if (layer === "primitive") continue; // primitive는 raw 정상
      continue;
    }
    // 참조값
    if (layer === "primitive") {
      violations.push({ level: "error", file: tokensPath, line: 0, msg: `primitive는 raw 값만 허용(참조 금지): ${path} → {${ref}}` });
      continue;
    }
    const need = allowed[layer];
    const refLayer = ref.split(".")[0];
    if (need && refLayer !== need) {
      violations.push({ level: "error", file: tokensPath, line: 0, msg: `${layer}는 ${need}만 참조해야 함: ${path} → {${ref}}` });
    }
    if (!flat.has(ref)) {
      violations.push({ level: "error", file: tokensPath, line: 0, msg: `참조 대상 없음: ${path} → {${ref}}` });
    }
  }
  // 순환 참조 (참조를 따라가다 자기 자신으로)
  for (const [start] of flat) {
    const seen = new Set();
    let cur = start;
    while (cur && flat.has(cur)) {
      if (seen.has(cur)) {
        violations.push({ level: "error", file: tokensPath, line: 0, msg: `순환 참조: ${start}` });
        break;
      }
      seen.add(cur);
      const ref = refTarget(flat.get(cur));
      cur = ref;
    }
  }
  // hex 원시값 집합(소스 스캔용)
  const hexValues = new Set();
  for (const [path, val] of flat) {
    if (path.startsWith("primitive") && /^#[0-9a-fA-F]{3,8}$/i.test(val)) hexValues.add(val.toLowerCase());
  }
  return { violations, flat, hexValues };
}

function walk(root, files) {
  let st;
  try {
    st = statSync(root);
  } catch {
    return files;
  }
  if (st.isFile()) {
    if (SOURCE_EXT.has(extname(root))) files.push(root);
    return files;
  }
  for (const name of readdirSync(root)) {
    if (SKIP_DIR.has(name)) continue;
    walk(join(root, name), files);
  }
  return files;
}

function scanSource(files, hexValues) {
  const violations = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (line.includes("token-lint-ignore")) return;
      const ln = idx + 1;
      for (const m of line.matchAll(HEX_RE)) {
        const hex = m[0].toLowerCase();
        if (hexValues.has(hex)) violations.push({ level: "warn", file, line: ln, msg: `raw hex ${m[0]} — tokens에 정의됨, 토큰 참조로 교체` });
        else violations.push({ level: "error", file, line: ln, msg: `미등록 raw hex ${m[0]} — tokens.json에 없음` });
      }
      for (const m of line.matchAll(PRIMITIVE_REF_RE)) {
        violations.push({ level: "error", file, line: ln, msg: `primitive 토큰 직접 참조(${m[0]}) — semantic/component 토큰만 사용` });
      }
    });
  }
  return violations;
}

function main() {
  const { tokensPath, paths } = parseArgs(process.argv.slice(2));
  if (!existsSync(tokensPath)) {
    console.error(`token-lint: tokens 파일 없음: ${tokensPath}`);
    process.exit(1);
  }
  const { violations: tv, hexValues } = validateTokens(tokensPath);
  const files = [];
  for (const p of paths) walk(p, files);
  const sv = scanSource(files, hexValues ?? new Set());
  const all = [...tv, ...sv];

  for (const v of all) {
    const loc = v.line ? `${relative(".", v.file)}:${v.line}` : relative(".", v.file);
    console.log(`  ${v.level === "error" ? "✗" : "⚠"} ${loc} — ${v.msg}`);
  }
  const errors = all.length;
  if (errors === 0) {
    console.log(`token-lint: 위반 0건 (검사 파일 ${files.length}개)`);
    process.exit(0);
  }
  console.log(`token-lint: 위반 ${errors}건`);
  process.exit(1);
}

main();
