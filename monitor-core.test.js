import test from "node:test";
import assert from "node:assert/strict";

import {
  courseDisplayLabel,
  courseStatusKey,
  parseCapacity,
  refreshCoursePage,
} from "./monitor-core.js";

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

test("course display label includes teacher and section details", () => {
  assert.equal(
    courseDisplayLabel({
      id: "COURSE001",
      name: "示例课程",
      teacher: "张三",
      classCode: "CLASS001",
      keywords: ["COURSE001", "示例课程", "张三", "CLASS001", "方向A"],
    }),
    "[COURSE001] 示例课程 | 张三 | CLASS001 | 方向A"
  );
});

test("collects text from all frames and auto-scroll results", async () => {
  const calls = [];
  const frame = {
    locator() {
      return {
        async innerText() {
          return "顶部课程";
        },
      };
    },
    async evaluate(_fn, options) {
      calls.push(options);
      return ["底部课程", "底部课程"];
    },
  };
  const page = {
    frames() {
      return [frame];
    },
  };
  const { collectPageText } = await import("./monitor-core.js");

  const text = await collectPageText(page, {
    autoScroll: true,
    autoScrollStepPixels: 900,
    autoScrollDelayMs: 50,
    autoScrollMaxSteps: 20,
    autoScrollMaxContainers: 3,
  });

  assert.equal(calls.length, 1);
  assert.match(text, /顶部课程/);
  assert.match(text, /底部课程/);
});
