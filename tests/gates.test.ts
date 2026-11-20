import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";

import { describe, expect, it } from "vitest";

import { repository_of_remote } from "../src/cli/check.ts";
import { read_changes, read_commits, run_gates } from "../src/server/gates.ts";
import {
  check_comments,
  check_commits,
  check_coverage,
  check_dependencies,
  check_leftovers,
  check_scope,
  check_secrets,
  check_size,
  check_status,
  check_tests_kept,
  check_x_libs,
  code_only,
  gates_cleared,
  read_thresholds,
  type ChangedFile,
} from "../src/shared/gates/model.ts";

function changed(path: string, lines: string[], status: ChangedFile["status"] = "modified", first_line = 1): ChangedFile {
  return { path, status, added: lines.map((text, index) => ({ line: first_line + index, text })) };
}

// ============================================================================
// Checks
// ============================================================================

describe("the scope gate", () => {
  it("fails files outside the stage's paths, and allows anything when none are given", () => {
    const files = [changed("tests/a.test.ts", []), changed("src/a.ts", [])];
    expect(check_scope(files, ["tests/**"], (path, glob) => matchesGlob(path, glob)).findings).toEqual(["src/a.ts is outside what this stage may change (tests/**)"]);
    expect(check_scope(files, [], () => false).outcome).toBe("passed");
  });
});

describe("the tests-kept gate", () => {
  it("fails a changed or deleted Specify test and any skipped or focused test", () => {
    const files = [changed("tests/a.test.ts", ["  it.only('runs', () => {"]), changed("tests/b.test.ts", [], "deleted"), changed("tests/c.test.ts", ["it('new', () => {})"], "added")];
    expect(check_tests_kept(files, ["tests/a.test.ts", "tests/b.test.ts"]).findings).toEqual([
      "tests/a.test.ts is one of Specify's tests and was changed",
      "tests/a.test.ts:1 skips or focuses a test",
      "tests/b.test.ts is one of Specify's tests and was deleted",
    ]);
  });
});

describe("the commits gate", () => {
  it("wants Conventional Commits, the trailer in X-Tech Laboratories repositories and no AI mention elsewhere", () => {
    const good = { sha: "a".repeat(40), message: "feat(board): add swimlanes\n\nAssisted-by: Claude Code" };
    expect(check_commits([good], true).outcome).toBe("passed");
    expect(check_commits([{ sha: "b".repeat(40), message: "Added swimlanes" }], true).findings).toEqual(['bbbbbbb "Added swimlanes" is not a Conventional Commit', "bbbbbbb has no Assisted-by trailer"]);
    expect(check_commits([good], false).findings).toEqual(["aaaaaaa has an Assisted-by trailer, which only X-Tech Laboratories repositories carry"]);
    expect(check_commits([{ sha: "c".repeat(40), message: "fix: lanes\n\nCo-Authored-By: Claude" }], false).findings).toEqual(["ccccccc mentions AI outside the trailer"]);
  });
});

describe("the secrets gate", () => {
  it("finds keys and tokens in added lines, environment files, and the report", () => {
    // Made from pieces so no whole key or token sits in the file.
    const token = ["gh", "p_", "x".repeat(36)].join("");
    const key_header = ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" ");
    const files = [changed("src/a.ts", [`const token = "${token}";`]), changed(".env", ["NAME=value"], "added"), changed(".env.example", ["NAME="], "added")];
    expect(check_secrets(files, [{ name: "report", text: key_header }]).findings).toEqual([
      "src/a.ts:1 holds a GitHub token",
      ".env is an environment file, which keeps secrets",
      "the report holds a private key",
    ]);
    expect(check_secrets([changed("src/a.ts", ['const label = "Password";'])]).outcome).toBe("passed");
  });
});

describe("the leftovers gate", () => {
  it("finds debug output, commented-out code and TODOs without an issue in code", () => {
    const files = [changed("src/a.ts", ["console.log(lanes);", "// const old = 1;", "// TODO tidy this", "// TODO tidy this, #12", "debugger;"]), changed("README.md", ["console.log in docs is fine"])];
    expect(check_leftovers(files).findings).toEqual(["src/a.ts:1 logs to the console", "src/a.ts:2 leaves code commented out", "src/a.ts:3 leaves a TODO without an issue", "src/a.ts:5 stops in the debugger"]);
  });
});

describe("code without its strings", () => {
  it("blanks strings and regular expressions, so checks read only the code around them", () => {
    expect(code_only('const pattern = /\\bdebugger\\b/; log("TODO later");')).toBe('const pattern = /./; log("");');
    expect(code_only("const half = total / 2 / count;")).toBe("const half = total / 2 / count;");
    expect(check_leftovers([changed("src/a.ts", ['[/\\bdebugger\\b/, "stops in the debugger"],', 'const note = "TODO";'])]).outcome).toBe("passed");
  });
});

describe("the comments gate", () => {
  it("lets a file's overview start after a #! line", () => {
    expect(check_comments([changed("src/cli.ts", ["#!/usr/bin/env node", "// The overview,", "// at length."])]).outcome).toBe("passed");
  });

  it("fails a comment of more than one line, but not banners, the file's opening comment or separate one-liners", () => {
    const file = changed("src/a.ts", ["// The file's overview,", "// which may run long.", "", "// ── Lanes ──────", "// One line.", "const a = 1;", "// Two lines", "// in a row.", "/* a block"]);
    expect(check_comments([file]).findings).toEqual(["src/a.ts:7 has a comment 2 lines long", "src/a.ts:9 opens a block comment"]);
  });
});

describe("the size gate", () => {
  it("warns of a code file over 500 lines", () => {
    expect(check_size({ "src/a.ts": 620, "src/b.ts": 40, "docs/long.md": 900 })).toEqual({ gate: "size", outcome: "warning", findings: ["src/a.ts is 620 lines long, over 500"] });
  });
});

describe("the x-libs gate", () => {
  it("fails an app's import of a library X-Libs wraps, but not X-Libs' own", () => {
    const files = [changed("src/a.ts", ['import { eq } from "drizzle-orm";', 'import { Editor } from "@tiptap/react";', 'import { x } from "@x-tech-laboratories/x-libs/drizzle";'])];
    expect(check_x_libs(files, false).findings).toEqual(["src/a.ts:1 imports drizzle-orm, which X-Libs wraps; import it from X-Libs", "src/a.ts:2 imports @tiptap/react, which X-Libs wraps; import it from X-Libs"]);
    expect(check_x_libs(files, true).outcome).toBe("passed");
  });
});

describe("the coverage gate", () => {
  const config = (lines: number, exclude = "") => `coverage: { ${exclude}thresholds: { lines: ${lines}, statements: 50, functions: 50, branches: 50 } }`;

  it("reads the floor and fails one lowered or code newly left out", () => {
    expect(read_thresholds(config(60))).toEqual({ lines: 60, statements: 50, functions: 50, branches: 50 });
    expect(check_coverage(config(60), config(65)).outcome).toBe("passed");
    expect(check_coverage(config(60), config(55)).findings).toEqual(["the lines floor went from 60 to 55"]);
    expect(check_coverage(config(60), config(60, 'exclude: ["src/daemon/**"], ')).findings).toEqual(['"src/daemon/**" was newly left out of coverage']);
    expect(check_coverage(config(60), null).findings).toEqual(["vitest.config.ts was deleted"]);
    expect(check_coverage(null, null).outcome).toBe("skipped");
  });
});

describe("the dependencies gate", () => {
  it("names new dependencies with their licences, failing one that cannot sit beside the GPL", () => {
    const licences: Record<string, string> = { yaml: "ISC", shady: "SSPL-1.0" };
    expect(check_dependencies({ dependencies: {} }, { dependencies: { yaml: "^2" } }, (name) => licences[name] ?? null)).toEqual({ gate: "dependencies", outcome: "warning", findings: ["yaml is new, licensed ISC"] });
    expect(check_dependencies({}, { devDependencies: { shady: "1" } }, (name) => licences[name] ?? null).outcome).toBe("failed");
    expect(check_dependencies({ dependencies: { yaml: "^2" } }, { dependencies: { yaml: "^2.1" } }, () => null).outcome).toBe("passed");
  });
});

describe("the status gate and overrides", () => {
  it("fails a run that left the status sheet alone, and clears once each failed gate is passed over", () => {
    expect(check_status("{}", "{}").outcome).toBe("failed");
    expect(check_status("{}", '{"goal":"x"}').outcome).toBe("passed");
    const results = [check_status("{}", "{}"), check_size({})];
    expect(gates_cleared(results, [])).toBe(false);
    expect(gates_cleared(results, [{ gate: "status", reason: "nothing to say" }])).toBe(true);
  });
});

// ============================================================================
// Reading git
// ============================================================================

function make_repository(): { folder: string; base: string; git: (...args: string[]) => string } {
  const folder = mkdtempSync(join(tmpdir(), "x-dev-gates-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.org", ...args], { cwd: folder, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(folder, "a.ts"), "const a = 1;\nconst b = 2;\n");
  git("add", ".");
  git("commit", "-q", "-m", "chore: start");
  return { folder, base: git("rev-parse", "HEAD"), git };
}

describe("x-dev-check", () => {
  it("reads the repository from its origin over ssh or https", () => {
    expect(repository_of_remote("git@github.com:x-tech-laboratories/X-Dev.git")).toBe("x-tech-laboratories/X-Dev");
    expect(repository_of_remote("https://github.com/x-tech-laboratories/X-Dev")).toBe("x-tech-laboratories/X-Dev");
  });
});

describe("reading what changed", () => {
  it("lists committed, uncommitted and untracked changes with the lines each added", async () => {
    const { folder, base, git } = make_repository();
    writeFileSync(join(folder, "a.ts"), "const a = 1;\nconsole.log(a);\nconst b = 2;\n");
    git("commit", "-q", "-am", "feat: log a\n\nAssisted-by: Claude Code");
    mkdirSync(join(folder, "tests"));
    writeFileSync(join(folder, "tests", "a.test.ts"), "it('a', () => {});\n");

    const files = await read_changes(folder, base);
    expect(files).toEqual([
      { path: "a.ts", status: "modified", added: [{ line: 2, text: "console.log(a);" }] },
      { path: "tests/a.test.ts", status: "added", added: [{ line: 1, text: "it('a', () => {});" }, { line: 2, text: "" }] },
    ]);
    expect(await read_commits(folder, base)).toEqual([{ sha: git("rev-parse", "HEAD"), message: "feat: log a\n\nAssisted-by: Claude Code" }]);
  });

  it("runs the gates named, skipping what this repository cannot check and naming unknown gates", async () => {
    const { folder, base } = make_repository();
    writeFileSync(join(folder, "b.ts"), "console.log(1);\n");

    const results = await run_gates(["leftovers", "tests-pass", "ci", "vibes"], { worktree: folder, base, repository: "someone/else", paths: [], specified_tests: [] });
    expect(results.map((result) => [result.gate, result.outcome])).toEqual([
      ["leftovers", "failed"],
      ["tests-pass", "skipped"],
      ["ci", "skipped"],
      ["vibes", "skipped"],
    ]);
  });
});
