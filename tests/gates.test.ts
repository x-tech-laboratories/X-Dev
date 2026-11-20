import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run_x_dev_check } from "../src/cli/check.ts";
import { checkout_state, run_gates } from "../src/server/gates.ts";
import { repository_of_remote } from "../src/shared/items/model.ts";
import { check_scope, check_size, check_status, check_tests_kept, gates_cleared, type ChangedFile, type GateResult } from "../src/shared/gates/model.ts";

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

describe("the size gate", () => {
  it("warns of a code file over 500 lines", () => {
    expect(check_size({ "src/a.ts": 620, "src/b.ts": 40, "docs/long.md": 900 })).toEqual({ gate: "size", outcome: "warning", findings: ["src/a.ts is 620 lines long, over 500"] });
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

describe("the repository of a remote", () => {
  it("reads the repository from its origin over ssh or https", () => {
    expect(repository_of_remote("git@github.com:x-tech-laboratories/X-Dev.git")).toBe("x-tech-laboratories/X-Dev");
    expect(repository_of_remote("https://github.com/x-tech-laboratories/X-Dev")).toBe("x-tech-laboratories/X-Dev");
  });
});

// A repository with a package.json, a coverage floor and one source file at its base, and node_modules ignored.
function make_project(): { folder: string; base: string; git: (...args: string[]) => string } {
  const { folder, git } = make_repository();
  writeFileSync(join(folder, ".gitignore"), "node_modules\n");
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
  writeFileSync(join(folder, "vitest.config.ts"), "coverage: { thresholds: { lines: 60, statements: 60, functions: 60, branches: 60 } }\n");
  git("add", ".");
  git("commit", "-q", "-m", "chore: set up");
  return { folder, base: git("rev-parse", "HEAD"), git };
}

// Adds a dependency to package.json and installs a stand-in for it with the licence given.
function add_dependency(folder: string, name: string, license: string): void {
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "app", dependencies: { [name]: "^1.0.0" } }));
  mkdirSync(join(folder, "node_modules", name), { recursive: true });
  writeFileSync(join(folder, "node_modules", name, "package.json"), JSON.stringify({ name, license }));
}

function outcomes(results: GateResult[]): Record<string, string> {
  return Object.fromEntries(results.map((result) => [result.gate, result.outcome]));
}

const every_change_gate = ["commits", "secrets", "leftovers", "comments", "coverage", "x-libs", "dependencies", "size", "scope", "tests-kept"];

describe("running the gates on a real repository", () => {
  it("passes a clean change on each gate, naming a new dependency for Review", async () => {
    const { folder, base, git } = make_project();
    writeFileSync(join(folder, "b.ts"), "// Adds one to a number.\nexport const next = (value: number) => value + 1;\n");
    add_dependency(folder, "yaml", "ISC");
    git("add", ".");
    git("commit", "-q", "-m", "feat: add next\n\nAssisted-by: Claude Code");

    const results = await run_gates(every_change_gate, { worktree: folder, base, repository: "x-tech-laboratories/X-Dev", paths: [], specified_tests: [] });
    expect(outcomes(results)).toEqual({ commits: "passed", secrets: "passed", leftovers: "passed", comments: "passed", coverage: "passed", "x-libs": "passed", dependencies: "warning", size: "passed", scope: "passed", "tests-kept": "passed" });
    expect(results.find((result) => result.gate === "dependencies")!.findings).toEqual(["yaml is new, licensed ISC"]);
  });

  it("fails a change on each gate, reading uncommitted and untracked files too", async () => {
    const { folder, base, git } = make_project();
    // Made from pieces so no whole token sits in the file.
    const token = ["gh", "p_", "x".repeat(36)].join("");
    writeFileSync(join(folder, "a.ts"), `const a = 1;\nconsole.log(a);\nimport { eq } from "drizzle-orm";\n// Two lines\n// in a row.\nconst b = 2;\n`);
    git("commit", "-q", "-am", `Added logging with ${token}`);
    writeFileSync(join(folder, "vitest.config.ts"), "coverage: { thresholds: { lines: 50, statements: 60, functions: 60, branches: 60 } }\n");
    add_dependency(folder, "shady", "SSPL-1.0");
    mkdirSync(join(folder, "tests"));
    writeFileSync(join(folder, "tests", "a.test.ts"), "it.only('a', () => {});\n");
    writeFileSync(join(folder, "long.ts"), "const line = 1;\n".repeat(600));

    const results = await run_gates(every_change_gate, { worktree: folder, base, repository: "x-tech-laboratories/X-Dev", paths: ["tests/**"], specified_tests: [], report: `the key is ${token}` });
    expect(outcomes(results)).toEqual({ commits: "failed", secrets: "failed", leftovers: "failed", comments: "failed", coverage: "failed", "x-libs": "failed", dependencies: "failed", size: "warning", scope: "failed", "tests-kept": "failed" });
    const findings = Object.fromEntries(results.map((result) => [result.gate, result.findings]));
    const short = git("rev-parse", "--short=7", "HEAD");
    expect(findings.commits).toEqual([`${short}'s subject is not a Conventional Commit`, `${short} has no Assisted-by trailer`]);
    expect(findings.secrets).toEqual([`${short}'s message holds a GitHub token`, "the report holds a GitHub token"]);
    expect(findings.leftovers).toEqual(["a.ts:2 logs to the console"]);
    expect(findings.comments).toEqual(["a.ts:4 has a comment 2 lines long"]);
    expect(findings.coverage).toEqual(["the lines floor went from 60 to 50"]);
    expect(findings["x-libs"]).toEqual(["a.ts:3 imports drizzle-orm, which X-Libs wraps; import it from X-Libs"]);
    expect(findings.dependencies).toEqual(["shady is new, licensed SSPL-1.0, which is not among the allowed licences"]);
    expect(findings.size).toEqual(["long.ts is 601 lines long, over 500"]);
    expect(findings["tests-kept"]).toEqual(["tests/a.test.ts:1 skips or focuses a test"]);
  });

  it("allows only listed licences, the trailer only in the organisation, and wrapped imports only in X-Libs itself", async () => {
    const { folder, base, git } = make_project();
    writeFileSync(join(folder, "b.ts"), 'import { eq } from "drizzle-orm";\n');
    add_dependency(folder, "odd", "WTFPL");
    git("add", ".");
    git("commit", "-q", "-m", "feat: use eq\n\nAssisted-by: Claude Code");
    const short = git("rev-parse", "--short=7", "HEAD");
    const run = (repository: string) => run_gates(["commits", "x-libs", "dependencies"], { worktree: folder, base, repository, paths: [], specified_tests: [] });

    const elsewhere = await run("someone/x-libs");
    expect(elsewhere.map((result) => [result.gate, result.outcome, result.findings[0]])).toEqual([
      ["commits", "failed", `${short} has an Assisted-by trailer, which only x-tech-laboratories repositories carry`],
      ["x-libs", "failed", "b.ts:1 imports drizzle-orm, which X-Libs wraps; import it from X-Libs"],
      ["dependencies", "failed", "odd is new, licensed WTFPL, which is not among the allowed licences"],
    ]);
    expect(outcomes(await run("X-Tech-Laboratories/x-libs"))).toEqual({ commits: "passed", "x-libs": "passed", dependencies: "failed" });
  });

  it("runs the gates named, skipping what this repository cannot check and naming unknown gates", async () => {
    const { folder, base } = make_repository();
    writeFileSync(join(folder, "b.ts"), "console.log(1);\n");

    const results = await run_gates(["leftovers", "tests-pass", "tests-fail-first", "types-lint", "report", "status", "worktree", "ci", "vibes"], { worktree: folder, base, repository: "someone/else", paths: [], specified_tests: [] });
    expect(results.map((result) => [result.gate, result.outcome])).toEqual([
      ["leftovers", "failed"],
      ["tests-pass", "skipped"],
      ["tests-fail-first", "skipped"],
      ["types-lint", "skipped"],
      ["report", "skipped"],
      ["status", "skipped"],
      ["worktree", "skipped"],
      ["ci", "skipped"],
      ["vibes", "skipped"],
    ]);
  });

  it("checks the report and status sheet a run hands in, and that the main checkout stayed as it was", async () => {
    const { folder, base } = make_repository();
    const main = make_repository();
    const before = await checkout_state(main.folder);
    const context = { worktree: folder, base, repository: "someone/else", paths: [], specified_tests: [], report: "done", status: { before: "{}", after: '{"goal":"x"}' }, main_checkout: { folder: main.folder, before } };

    expect(outcomes(await run_gates(["report", "status", "worktree"], context))).toEqual({ report: "passed", status: "passed", worktree: "passed" });
    writeFileSync(join(main.folder, "stray.ts"), "");
    expect((await run_gates(["worktree"], context))[0]!.findings).toEqual([`the main checkout at ${main.folder} changed during the run`]);
  });
});

describe("the gates that run the repository's own tools", () => {
  // A project whose vitest is a stand-in exiting with the code in vitest_exit, with a type check that passes and a lint that fails.
  function make_tooled_project(): { folder: string; base: string; git: (...args: string[]) => string } {
    const project = make_project();
    const manifest = { name: "app", devDependencies: { vitest: "^1.0.0" }, scripts: { typecheck: "exit 0", lint: "echo lint found a problem && exit 1" } };
    writeFileSync(join(project.folder, "package.json"), JSON.stringify(manifest));
    mkdirSync(join(project.folder, "node_modules", "vitest"), { recursive: true });
    mkdirSync(join(project.folder, "node_modules", ".bin"));
    writeFileSync(join(project.folder, "node_modules", "vitest", "package.json"), JSON.stringify({ name: "vitest", version: "1.0.0", bin: { vitest: "cli.sh" } }));
    writeFileSync(join(project.folder, "node_modules", "vitest", "cli.sh"), '#!/bin/sh\necho "stand-in vitest"\nexit "$(cat vitest_exit)"\n', { mode: 0o755 });
    symlinkSync("../vitest/cli.sh", join(project.folder, "node_modules", ".bin", "vitest"));
    project.git("add", ".");
    project.git("commit", "-q", "-m", "chore: add tools");
    return { ...project, base: project.git("rev-parse", "HEAD") };
  }

  it("runs the tests for what changed, and wants Specify's new tests to fail first", async () => {
    const { folder, base } = make_tooled_project();
    writeFileSync(join(folder, ".git", "info", "exclude"), "vitest_exit\n");
    const context = { worktree: folder, base, repository: "someone/else", paths: [], specified_tests: [] };

    writeFileSync(join(folder, "vitest_exit"), "0");
    expect(outcomes(await run_gates(["tests-pass", "tests-fail-first"], context))).toEqual({ "tests-pass": "passed", "tests-fail-first": "failed" });
    writeFileSync(join(folder, "a.test.ts"), "it('a', () => {});\n");
    expect((await run_gates(["tests-fail-first"], context))[0]!.findings).toEqual(["the new tests already pass, so they do not pin down behaviour that is missing"]);
    writeFileSync(join(folder, "vitest_exit"), "1");
    const results = await run_gates(["tests-pass", "tests-fail-first"], context);
    expect(outcomes(results)).toEqual({ "tests-pass": "failed", "tests-fail-first": "passed" });
    expect(results[0]!.findings).toEqual(["the tests for what changed fail:", "stand-in vitest"]);
  }, 30_000);

  it("runs the tests changed since the base x-dev-check worked out", async () => {
    const { folder, base } = make_tooled_project();
    writeFileSync(join(folder, "node_modules", "vitest", "cli.sh"), '#!/bin/sh\necho "$@"\nexit 1\n', { mode: 0o755 });
    const out = { text: "", write(more: string) { this.text += more; } };

    expect(await run_x_dev_check(["--base", base, "tests-pass"], { cwd: folder, env: {}, out, err: { write: () => undefined } })).toBe(1);
    expect(out.text).toContain(`run --changed ${base} --passWithNoTests`);
  }, 30_000);

  it("runs the type check and lint scripts, naming the one that fails", async () => {
    const { folder, base } = make_tooled_project();

    const [result] = await run_gates(["types-lint"], { worktree: folder, base, repository: "someone/else", paths: [], specified_tests: [] });
    expect(result).toEqual({ gate: "types-lint", outcome: "failed", findings: ["the lint fails:", "lint found a problem"] });
  }, 30_000);
});

describe("x-dev-check", () => {
  function capture(): { text: () => string; stream: { write(text: string): void } } {
    let text = "";
    return { text: () => text, stream: { write: (more: string) => void (text += more) } };
  }

  it("runs the default gates, size among them, and fails on a failed gate", async () => {
    const { folder, base, git } = make_project();
    writeFileSync(join(folder, "b.ts"), "console.log(1);\n");
    git("add", ".");
    git("commit", "-q", "-m", "feat: log\n\nAssisted-by: Claude Code");
    const out = capture();

    const code = await run_x_dev_check(["--base", base, "--repository", "x-tech-laboratories/X-Dev"], { cwd: folder, env: {}, out: out.stream, err: capture().stream });
    expect(code).toBe(1);
    expect(out.text()).toContain("✗ leftovers: failed\n    b.ts:1 logs to the console");
    expect(out.text()).toContain("✓ size: passed");
    expect(await run_x_dev_check(["--base", base, "--repository", "x-tech-laboratories/X-Dev", "commits", "size"], { cwd: folder, env: {}, out: capture().stream, err: capture().stream })).toBe(0);
  });

  it("refuses a gate it does not know, and takes the branch point from origin/main when no base is given", async () => {
    const { folder, base, git } = make_repository();
    const err = capture();
    expect(await run_x_dev_check(["--base", base, "vibes"], { cwd: folder, env: {}, out: capture().stream, err: err.stream })).toBe(2);
    expect(err.text()).toContain("x-dev-check: no check called vibes");
    expect(err.text()).toContain("Usage: x-dev-check");

    git("update-ref", "refs/remotes/origin/main", base);
    const out = capture();
    expect(await run_x_dev_check(["size"], { cwd: folder, env: {}, out: out.stream, err: capture().stream })).toBe(0);
    expect(out.text()).toContain("✓ size: passed");
  });
});

describe("the ci gate", () => {
  const fake_gh = join(import.meta.dirname, "fixtures", "fake_gh.mjs");

  afterEach(() => {
    delete process.env.FAKE_GH_DATA;
  });

  // A fake GitHub with pull request #12 from the branch, its one check in the state given.
  function fake_pull_request(bucket: string | null, offline = false): void {
    const file = join(mkdtempSync(join(tmpdir(), "x-dev-github-")), "github.json");
    const pulls = [{ number: 12, url: "https://github.com/owner/repo/pull/12", state: "OPEN", isDraft: false, head: "worktree-item-7" }];
    writeFileSync(file, JSON.stringify({ offline, issues: {}, labels: [], pulls, checks: bucket ? { "12": [{ name: "test", bucket, link: "", workflow: "CI" }] } : {}, next_comment_id: 1, calls: [] }));
    process.env.FAKE_GH_DATA = file;
  }

  async function ci_on_branch(branch: string): Promise<GateResult> {
    const { folder, base, git } = make_repository();
    git("switch", "-q", "-c", branch);
    return (await run_gates(["ci"], { worktree: folder, base, repository: "owner/repo", paths: [], specified_tests: [], gh_program: fake_gh }))[0]!;
  }

  it("reads the checks of the pull request from the worktree's branch", async () => {
    fake_pull_request("pass");
    expect((await ci_on_branch("worktree-item-7")).outcome).toBe("passed");
    fake_pull_request("fail");
    expect((await ci_on_branch("worktree-item-7")).findings).toEqual(["CI / test failed"]);
    fake_pull_request(null);
    expect((await ci_on_branch("worktree-item-7")).findings).toEqual(["pull request #12 has no checks"]);
  });

  it("is not checked without a pull request, and holds the item when GitHub cannot be reached", async () => {
    fake_pull_request("pass");
    expect((await ci_on_branch("other-branch")).outcome).toBe("skipped");
    fake_pull_request("pass", true);
    expect((await ci_on_branch("worktree-item-7")).findings[0]).toContain("GitHub could not be reached");
  });
});
