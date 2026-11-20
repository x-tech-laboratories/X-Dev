#!/usr/bin/env node
// Stands in for gh in the tests: owner/has-match holds an open issue like the item, owner/broken fails, and a new
// issue is #42, its title and body kept in a file for the test to read.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];
const repository = option("--repo");

if (repository === "owner/broken") {
  process.stderr.write("HTTP 404: Not Found\n");
  process.exit(1);
}
if (argv[0] === "issue" && argv[1] === "list") {
  const issues = repository === "owner/has-match" ? [{ number: 5, title: "Swimlanes on the board" }, { number: 6, title: "Unrelated thing" }] : [];
  process.stdout.write(JSON.stringify(issues));
} else if (argv[0] === "issue" && argv[1] === "create") {
  const record = join(tmpdir(), `x-dev-fake-gh-${repository.replace("/", "-")}.json`);
  writeFileSync(record, JSON.stringify({ title: option("--title"), body: readFileSync(0, "utf8") }));
  process.stdout.write(`https://github.com/${repository}/issues/42\n`);
}
