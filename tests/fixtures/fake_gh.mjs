#!/usr/bin/env node
// Stands in for gh in the tests: owner/has-match holds an open issue like the item, owner/broken fails, a new issue is
// #42 with its title and body kept in a file, and signing in is kept in the file FAKE_GH_STATE names.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];
const repository = option("--repo");

const state = process.env.FAKE_GH_STATE;

if (argv[0] === "auth" && argv[1] === "status") {
  if (state && existsSync(state)) process.stdout.write(`github.com\n  ✓ Logged in to github.com account ${readFileSync(state, "utf8")} (keyring)\n`);
  else {
    process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\n");
    process.exit(1);
  }
} else if (argv[0] === "auth" && argv[1] === "login") {
  process.stderr.write("! First copy your one-time code: WXYZ-9876\nPress Enter to open https://github.com/login/device in your browser... ");
  readFileSync(0, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 200));
  writeFileSync(state, "test-user");
  process.stderr.write("\n✓ Logged in as test-user\n");
} else if (argv[0] === "auth" && argv[1] === "logout") {
  rmSync(state, { force: true });
} else if (repository === "owner/broken") {
  process.stderr.write("HTTP 404: Not Found\n");
  process.exit(1);
} else if (argv[0] === "issue" && argv[1] === "list") {
  const issues = repository === "owner/has-match" ? [{ number: 5, title: "Swimlanes on the board" }, { number: 6, title: "Unrelated thing" }] : [];
  process.stdout.write(JSON.stringify(issues));
} else if (argv[0] === "issue" && argv[1] === "create") {
  const record = join(tmpdir(), `x-dev-fake-gh-${repository.replace("/", "-")}.json`);
  writeFileSync(record, JSON.stringify({ title: option("--title"), body: readFileSync(0, "utf8") }));
  process.stdout.write(`https://github.com/${repository}/issues/42\n`);
}
