import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

test("private course config is ignored and example config is published", async () => {
  const gitignore = await readFile(".gitignore", "utf8");

  assert.match(gitignore, /^courses\.json$/m);
  await access("courses.example.json");
});
