import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeCourseText,
  buildAlertText,
  courseDisplayLabel,
  courseStatusKey,
  createSimulatedOpenResult,
  focusBrowserWindow,
  openCourseDetailFromOverview,
  parseCapacity,
  revealCourseOnPage,
  refreshCoursePage,
  statusLabel,
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

test("capacity parser handles table detail rows with zero available seats", () => {
  const capacity = parseCapacity(`
    上课班号 上课班级名称 任课教师 授课方式 限选人数 已选/免听 可选人数 上课时间
    071 健身健美 徐怡康 体育 45 45/0 0 1-18周 二(3-4节)
  `);

  assert.equal(capacity.limit, 45);
  assert.equal(capacity.selected, 45);
  assert.equal(capacity.exempted, 0);
  assert.equal(capacity.available, 0);
});

test("course analysis reads the matching section row instead of the first detail row", () => {
  const result = analyzeCourseText(
    `
    选课-[00300003] 大学体育（三）
    上课班号 上课班级名称 开课校区 任课教师 授课方式 限选人数 已选/免听 可选人数 上课时间
    041 跆拳道 金明校区 牛露露 体育 45 45/0 0 1-18周 一(7-8节)
    071 健身健美 金明校区 徐怡康 体育 45 44/0 1 1-18周 二(3-4节)
  `,
    {
      id: "00300003",
      name: "大学体育（三）",
      teacher: "徐怡康",
      classCode: "000689-071",
      keywords: ["00300003", "大学体育（三）", "徐怡康", "000689-071", "健身健美"],
      strongKeywords: ["00300003", "大学体育（三）", "000689-071"],
    }
  );

  assert.equal(result.status, "open");
  assert.equal(result.available, 1);
  assert.match(result.capacitySource, /071/);
});

test("uncertain and missing matches are displayed as no available seats", () => {
  assert.equal(statusLabel({ status: "uncertain" }), "暂无余量");
  assert.equal(statusLabel({ status: "not_found" }), "暂无余量");
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

test("builds simulated open alert text without a screenshot path", () => {
  const result = createSimulatedOpenResult(
    {
      id: "COURSE001",
      name: "示例课程",
      teacher: "张三",
      classCode: "CLASS001",
      keywords: ["COURSE001", "示例课程", "张三", "CLASS001", "方向A"],
    },
    2
  );
  const text = buildAlertText(result, "", "https://xk.example.test", {
    simulated: true,
  });

  assert.match(text, /模拟测试/);
  assert.match(text, /有可选名额：2/);
  assert.match(text, /请马上打开教务系统确认并手动选课/);
  assert.doesNotMatch(text, /截图/);
});

test("reveal helper focuses page and asks frames to locate course without clicking", async () => {
  const calls = [];
  const frame = {
    async evaluate(_fn, payload) {
      calls.push(payload);
      return { found: true, matchedText: "CLASS001 示例课程" };
    },
  };
  const page = {
    async bringToFront() {
      calls.push("bringToFront");
    },
    frames() {
      return [frame];
    },
  };

  const result = await revealCourseOnPage(
    page,
    {
      id: "COURSE001",
      name: "示例课程",
      teacher: "张三",
      classCode: "CLASS001",
      keywords: ["COURSE001", "示例课程", "张三", "CLASS001", "方向A"],
    },
    { assistScrollMaxSteps: 3 }
  );

  assert.equal(result.found, true);
  assert.equal(calls[0], "bringToFront");
  assert.deepEqual(calls[1].needles, ["CLASS001", "COURSE001", "示例课程", "张三", "方向A"]);
});

test("focus helper restores and maximizes the browser window before bringing it forward", async () => {
  const calls = [];
  const session = {
    async send(method, params) {
      calls.push([method, params]);
      if (method === "Browser.getWindowForTarget") return { windowId: 12 };
      return {};
    },
    async detach() {
      calls.push(["detach"]);
    },
  };
  const page = {
    context() {
      return {
        async newCDPSession(target) {
          assert.equal(target, page);
          calls.push(["newCDPSession"]);
          return session;
        },
      };
    },
    async bringToFront() {
      calls.push(["bringToFront"]);
    },
  };

  const result = await focusBrowserWindow(page, { maximizeOnOpen: true });

  assert.equal(result.maximized, true);
  assert.deepEqual(calls, [
    ["newCDPSession"],
    ["Browser.getWindowForTarget", undefined],
    ["Browser.setWindowBounds", { windowId: 12, bounds: { windowState: "normal" } }],
    ["Browser.setWindowBounds", { windowId: 12, bounds: { windowState: "maximized" } }],
    ["detach"],
    ["bringToFront"],
  ]);
});

test("course detail opener targets the overview course row only", async () => {
  const calls = [];
  const frame = {
    async evaluate(_fn, payload) {
      calls.push(payload);
      return { opened: true, matchedText: "[00300003] 大学体育（三） 选择" };
    },
  };
  const page = {
    frames() {
      return [frame];
    },
    async waitForTimeout(ms) {
      calls.push(["wait", ms]);
    },
  };

  const result = await openCourseDetailFromOverview(
    page,
    {
      id: "00300003",
      name: "大学体育（三）",
      teacher: "徐怡康",
      classCode: "000689-071",
      keywords: ["00300003", "大学体育（三)", "徐怡康", "000689-071", "健身健美"],
    },
    { courseDetailWaitMs: 1200 }
  );

  assert.equal(result.opened, true);
  assert.deepEqual(calls[0].needles, ["00300003", "大学体育（三）"]);
  assert.deepEqual(calls[1], ["wait", 1200]);
});

test("course detail opener uses view for selected courses and does not click withdraw", async () => {
  const clicked = [];
  const makeElement = (text, children = []) => ({
    innerText: text,
    textContent: text,
    value: "",
    getAttribute() {
      return "";
    },
    querySelectorAll() {
      return children;
    },
    click() {
      clicked.push(text);
    },
  });
  const withdraw = makeElement("退选");
  const view = makeElement("查看");
  const row = makeElement("[00300003] 大学体育（三） 选中 查看 退选", [
    withdraw,
    view,
  ]);
  const previousDocument = globalThis.document;
  const frame = {
    async evaluate(fn, payload) {
      globalThis.document = {
        querySelectorAll() {
          return [row];
        },
      };
      try {
        return fn(payload);
      } finally {
        globalThis.document = previousDocument;
      }
    },
  };
  const page = {
    frames() {
      return [frame];
    },
    async waitForTimeout() {},
  };

  const result = await openCourseDetailFromOverview(page, {
    id: "00300003",
    name: "大学体育（三）",
  });

  assert.equal(result.opened, true);
  assert.deepEqual(clicked, ["查看"]);
});
