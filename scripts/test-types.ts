/**
 * Type-level acceptance runner.
 *
 * 1. Builds the package (the fixture and the examples resolve `@oomol-lab/connector-mastra` via a
 *    self-symlink in node_modules → package.json exports → dist/*.d.mts, i.e. the REAL published
 *    resolution).
 * 2. Runs the tsd assertions in fixtures/consumer.
 * 3. Type-checks the runnable examples against the built package.
 *
 * Exits non-zero on any failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => join(root, "node_modules", ".bin", name);

// Must be a SYMLINK to the repo root so consumers type-check against the LIVE build; anything else
// (a stale real directory from an earlier `bun add`) would shadow dist with old declarations.
function ensureSelfLink(): void {
  const scopeDir = join(root, "node_modules", "@oomol-lab");
  const link = join(scopeDir, "connector-mastra");
  if (existsSync(link)) {
    if (lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(root)) return;
    rmSync(link, { recursive: true, force: true });
  }
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync("../..", link, "dir");
}
ensureSelfLink();

let failures = 0;
function run(label: string, cmd: string, args: string[], cwd = root): void {
  process.stdout.write(`\n▶ ${label}\n`);
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status === 0) {
    process.stdout.write(`✓ ${label}\n`);
  } else {
    process.stdout.write(`✗ ${label} (exit ${res.status})\n`);
    failures++;
  }
}

// 1. Always rebuild so nothing type-checks against a stale declaration file.
run("build", bin("tsdown"), []);

// 2. tsd assertions against dist.
run("tsd: consumer", bin("tsd"), ["fixtures/consumer", "--files", "index.test-d.ts"]);

// 3. Examples against the built package (resolved via the symlink).
run("examples", bin("tsc"), ["-p", "tsconfig.json"], join(root, "examples"));

if (failures > 0) {
  process.stderr.write(`\n${failures} type-acceptance check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nAll type-acceptance checks passed.\n");
