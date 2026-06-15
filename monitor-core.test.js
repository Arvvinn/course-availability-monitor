import test from "node:test";
import assert from "node:assert/strict";

import { refreshCoursePage } from "./monitor-core.js";

test("soft refresh does not use browser-level reload", async () => {
  const calls = [];
  const page = {
    async reload() {
      calls.push("reload");
    },
    async waitForTimeout(ms) {
      calls.push(`wait:${ms}`);
    },
    getByRole() {
      return {
        first() {
          return {
            async count() {
              return 0;
            },
          };
        },
      };
    },
    locator() {
      return {
        first() {
          return {
            async count() {
              return 0;
            },
          };
        },
      };
    },
  };

  const outcome = await refreshCoursePage(page, { refreshMode: "soft" });

  assert.equal(outcome.mode, "soft");
  assert.deepEqual(calls, ["wait:2000"]);
});

test("hard refresh remains opt-in", async () => {
  const calls = [];
  const page = {
    async reload(options) {
      calls.push(["reload", options.waitUntil, options.timeout]);
    },
    async waitForTimeout(ms) {
      calls.push(["wait", ms]);
    },
  };

  const outcome = await refreshCoursePage(page, { refreshMode: "hard" });

  assert.equal(outcome.mode, "hard");
  assert.deepEqual(calls, [["reload", "domcontentloaded", 60000], ["wait", 3000]]);
});
