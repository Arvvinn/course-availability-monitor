import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

test("private course config is ignored and example config is published", async () => {
  const gitignore = await readFile(".gitignore", "utf8");

  assert.match(gitignore, /^courses\.json$/m);
  await access("courses.example.json");
});

test("uncertain course matches do not alert by default", async () => {
  const envExample = await readFile(".env.example", "utf8");

  assert.match(envExample, /^ALERT_ON_UNCERTAIN=false$/m);
});
