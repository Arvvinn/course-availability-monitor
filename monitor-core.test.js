import test from "node:test";
import assert from "node:assert/strict";

import { courseStatusKey, parseCapacity, refreshCoursePage } from "./monitor-core.js";

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

test("capacity parser handles negative remaining values from selected/exempt pages", () => {
  const capacity = parseCapacity(`
    任课教师：张三
    上课班级：CLASS001 示例课程
    已选/免听：126/0
    剩    余：-81
  `);

  assert.equal(capacity.selected, 126);
  assert.equal(capacity.exempted, 0);
  assert.equal(capacity.available, -81);
  assert.match(capacity.source, /剩余/);
});

test("course status key distinguishes sections of the same course", () => {
  assert.equal(
    courseStatusKey({ id: "COURSE001", classCode: "CLASS001", name: "示例课程" }),
    "COURSE001::CLASS001"
  );
  assert.equal(
    courseStatusKey({ id: "COURSE001", classCode: "CLASS002", name: "示例课程" }),
    "COURSE001::CLASS002"
  );
});
