const SEARCH_BUTTON_NAMES = [/^(检索|查询|搜索)$/];
const SELECTION_ENTRY_NAMES = ["选课(按开课计划)", "选课（按开课计划）"];

export function courseStatusKey(course) {
  const id = String(course?.id ?? "").trim();
  const classCode = String(course?.classCode ?? "").trim();
  const name = String(course?.name ?? "").trim();
  return [id, classCode].filter(Boolean).join("::") || name;
}

export function courseDisplayLabel(course) {
  const id = String(course?.id ?? "").trim();
  const name = String(course?.name ?? "").trim();
  const teacher = String(course?.teacher ?? "").trim();
  const classCode = String(course?.classCode ?? "").trim();
  const keywords = Array.isArray(course?.keywords) ? course.keywords : [];
  const lastKeyword = String(keywords.at(-1) ?? "").trim();
  const suffix = [teacher, classCode, lastKeyword]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(" | ");
  const prefix = id ? `[${id}] ${name}` : name;
  return suffix ? `${prefix} | ${suffix}` : prefix;
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function statusLabel(result) {
  if (result.status === "open") return `有可选名额：${result.available}`;
  if (result.status === "full") return "暂无余量";
  if (result.status === "uncertain") {
    return "已匹配到课程，但未能解析可选人数，需要人工确认";
  }
  return "本页未匹配到该课程";
}

export function buildAlertText(result, screenshotPath, pageUrl, options = {}) {
  const course = result.course;
  const lines = [
    options.simulated ? "选课监控提醒（模拟测试）" : "选课监控提醒",
    "",
    `课程：${courseDisplayLabel(course)}`,
    `状态：${statusLabel(result)}`,
    `时间：${formatTime()}`,
    `页面：${pageUrl}`,
  ];

  if (screenshotPath) {
    lines.push(`截图：${screenshotPath}`);
  }

  if (result.capacitySource) {
    lines.push(`识别字段：${result.capacitySource}`);
  }

  lines.push(
    "",
    options.simulated
      ? "这是脚本模拟测试，不代表真的有课余量。请马上打开教务系统确认并手动选课。"
      : "请马上打开教务系统确认并手动选课；脚本不会自动选课。"
  );
  return lines.join("\n");
}

export function createSimulatedOpenResult(course, available = 1) {
  return {
    course,
    status: "open",
    available,
    matchedKeywords: Array.isArray(course?.keywords) ? course.keywords : [],
    capacitySource: "模拟测试",
    fingerprint: `simulated::open::${available}`,
  };
}

async function visibleText(target) {
  try {
    return await target.locator("body").innerText({ timeout: 1500 });
  } catch {
    return "";
  }
}

function getSearchTargets(page) {
  if (typeof page.frames !== "function") return [page];
  return [page, ...page.frames()];
}

async function firstCount(locator) {
  try {
    return await locator.first().count();
  } catch {
    return 0;
  }
}

async function tryClick(locator, actionName) {
  if (!locator || (await firstCount(locator)) === 0) return null;

  try {
    await locator.first().click({ timeout: 3000 });
    return actionName;
  } catch {
    return null;
  }
}

async function tryClickSelectionEntry(page) {
  const pageText = await visibleText(page);
  if (pageText.includes("课程范围") && pageText.includes("选课")) {
    return null;
  }

  for (const target of getSearchTargets(page)) {
    for (const name of SELECTION_ENTRY_NAMES) {
      if (typeof target.getByText === "function") {
        const clicked = await tryClick(
          target.getByText(name, { exact: true }),
          `click:${name}`
        );
        if (clicked) return clicked;
      }

      if (typeof target.getByRole === "function") {
        const clicked = await tryClick(
          target.getByRole("button", { name }),
          `click:${name}`
        );
        if (clicked) return clicked;
      }
    }
  }

  return null;
}

async function tryClickSearch(page) {
  for (const target of getSearchTargets(page)) {
    if (typeof target.getByRole !== "function") continue;

    for (const name of SEARCH_BUTTON_NAMES) {
      const clicked = await tryClick(
        target.getByRole("button", { name }),
        "click:search"
      );
      if (clicked) return clicked;
    }
  }

  return null;
}

export function parseCapacity(context) {
  const compact = String(context ?? "")
    .replace(/[／]/g, "/")
    .replace(/[：]/g, ":")
    .replace(/\s+/g, "");

  const limitSelectedAvailable = compact.match(
    /限选\/已选\/可选:?(-?\d+)\/(-?\d+)\/(-?\d*)/
  );
  if (limitSelectedAvailable) {
    const limit = Number(limitSelectedAvailable[1]);
    const selected = Number(limitSelectedAvailable[2]);
    const availableText = limitSelectedAvailable[3];
    const available =
      availableText === "" ? Math.max(0, limit - selected) : Number(availableText);
    return {
      limit,
      selected,
      available,
      source: limitSelectedAvailable[0],
    };
  }

  const labeledLimitSelectedAvailable = compact.match(
    /限选[^\d-]{0,20}(-?\d+)[^\d-]{0,20}已选[^\d-]{0,20}(-?\d+)[^\d-]{0,20}可选[^\d-]{0,20}(-?\d+)/
  );
  if (labeledLimitSelectedAvailable) {
    return {
      limit: Number(labeledLimitSelectedAvailable[1]),
      selected: Number(labeledLimitSelectedAvailable[2]),
      available: Number(labeledLimitSelectedAvailable[3]),
      source: labeledLimitSelectedAvailable[0],
    };
  }

  const selectedExemptedRemaining = compact.match(
    /已选\/免听:?(\d+)\/(\d+).*?剩余:?(-?\d+)/
  );
  if (selectedExemptedRemaining) {
    return {
      selected: Number(selectedExemptedRemaining[1]),
      exempted: Number(selectedExemptedRemaining[2]),
      available: Number(selectedExemptedRemaining[3]),
      source: selectedExemptedRemaining[0],
    };
  }

  const availability = compact.match(/(?:余量|剩余名额|剩余|可选人数):?(-?\d+)/);
  if (availability) {
    return {
      available: Number(availability[1]),
      source: availability[0],
    };
  }

  return {
    available: null,
    source: "",
  };
}

async function frameBodyText(frame, timeout = 5000) {
  try {
    return await frame.locator("body").innerText({ timeout });
  } catch {
    return "";
  }
}

function uniqueNonEmpty(parts) {
  const seen = new Set();
  const output = [];

  for (const part of parts) {
    const text = String(part ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }

  return output;
}

async function scrollFrameAndCollectText(frame, config) {
  try {
    return await frame.evaluate(
      async ({ stepPixels, delayMs, maxSteps, maxContainers }) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const text = () => document.body?.innerText || "";
        const candidates = [];
        const addCandidate = (element) => {
          if (element && !candidates.includes(element)) candidates.push(element);
        };

        addCandidate(document.scrollingElement || document.documentElement);

        for (const element of Array.from(document.querySelectorAll("*"))) {
          const style = window.getComputedStyle(element);
          const overflow = `${style.overflowY} ${style.overflow}`;
          const isScrollable =
            element.scrollHeight > element.clientHeight + 20 &&
            !/(hidden|clip)/.test(overflow);

          if (isScrollable) addCandidate(element);
          if (candidates.length >= maxContainers) break;
        }

        const collected = [];
        for (const element of candidates.slice(0, maxContainers)) {
          const originalTop = element.scrollTop;
          const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
          if (maxTop < 20) continue;

          for (let step = 0; step <= maxSteps; step += 1) {
            const nextTop = Math.min(maxTop, step * stepPixels);
            element.scrollTop = nextTop;
            element.dispatchEvent(new Event("scroll", { bubbles: true }));
            window.dispatchEvent(new Event("scroll"));
            await sleep(delayMs);
            collected.push(text());
            if (nextTop >= maxTop) break;
          }

          element.scrollTop = originalTop;
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        }

        return Array.from(new Set(collected));
      },
      {
        stepPixels: config.autoScrollStepPixels ?? 900,
        delayMs: config.autoScrollDelayMs ?? 50,
        maxSteps: config.autoScrollMaxSteps ?? 20,
        maxContainers: config.autoScrollMaxContainers ?? 3,
      }
    );
  } catch {
    return [];
  }
}

export async function collectFrameText(frame, config = {}) {
  const parts = [await frameBodyText(frame)];

  if (config.autoScroll) {
    parts.push(...(await scrollFrameAndCollectText(frame, config)));
  }

  return uniqueNonEmpty(parts).join("\n\n--- scrolled ---\n\n");
}

export async function collectPageText(page, config = {}) {
  const parts = [];

  for (const frame of page.frames()) {
    const text = await collectFrameText(frame, config);
    if (text.trim()) parts.push(text);
  }

  return parts.join("\n\n--- frame ---\n\n");
}

export async function refreshCoursePage(page, config = {}) {
  const refreshMode = config.refreshMode || "soft";

  if (refreshMode === "hard") {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    return { mode: "hard", action: "browser-reload" };
  }

  const selectionAction = await tryClickSelectionEntry(page);
  if (selectionAction) {
    await page.waitForTimeout(3000);
  }

  const searchAction = await tryClickSearch(page);
  if (searchAction) {
    await page.waitForTimeout(3000);
    return { mode: "soft", action: searchAction, recovered: Boolean(selectionAction) };
  }

  await page.waitForTimeout(2000);
  return {
    mode: "soft",
    action: selectionAction || "read-current-page",
    recovered: Boolean(selectionAction),
  };
}
