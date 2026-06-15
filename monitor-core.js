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

function revealNeedles(course) {
  const keywords = Array.isArray(course?.keywords) ? course.keywords : [];
  return uniqueNonEmpty([
    course?.classCode,
    course?.id,
    course?.name,
    course?.teacher,
    ...keywords,
  ]);
}

async function revealCourseInFrame(frame, needles, config) {
  try {
    return await frame.evaluate(
      async ({ needles, stepPixels, delayMs, maxSteps, maxContainers }) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalize = (value) =>
          String(value ?? "")
            .replace(/[ \t\r\n]+/g, "")
            .replace(/[－–—]/g, "-")
            .replace(/[，]/g, "/")
            .replace(/[（]/g, "(")
            .replace(/[）]/g, ")");
        const normalizedNeedles = needles.map(normalize).filter(Boolean);
        const primaryNeedle = normalizedNeedles[0] || "";

        const elementText = (element) => element?.innerText || element?.textContent || "";
        const pageContainsCourse = () => {
          const bodyText = normalize(document.body?.innerText || "");
          return normalizedNeedles.some((needle) => bodyText.includes(needle));
        };
        const scoreElement = (element) => {
          const text = normalize(elementText(element));
          if (!text) return null;

          let score = 0;
          let matches = 0;
          for (const needle of normalizedNeedles) {
            if (!text.includes(needle)) continue;
            matches += 1;
            score += needle === primaryNeedle ? 10 : 3;
          }

          if (matches === 0) return null;
          if (primaryNeedle && !text.includes(primaryNeedle) && matches < 2) return null;

          return { score: score - Math.min(text.length / 600, 12), matches, text };
        };

        const findBestElement = () => {
          if (!pageContainsCourse()) return null;

          const selectors = [
            "tr",
            "[role='row']",
            "li",
            ".el-table__row",
            ".ant-table-row",
            ".ivu-table-row",
            ".list-item",
            ".course-item",
            ".result-item",
            ".card",
            "section",
            "article",
            "div",
          ];
          let best = null;

          for (const element of Array.from(document.querySelectorAll(selectors.join(",")))) {
            const tagName = element.tagName;
            if (tagName === "SCRIPT" || tagName === "STYLE") continue;

            const scored = scoreElement(element);
            if (!scored) continue;
            if (!best || scored.score > best.score) {
              best = { element, ...scored };
            }
          }

          return best;
        };

        const clearPreviousHighlight = () => {
          for (const element of Array.from(
            document.querySelectorAll("[data-course-monitor-highlight='true']")
          )) {
            element.style.outline = "";
            element.style.boxShadow = "";
            element.style.backgroundColor = "";
            element.removeAttribute("data-course-monitor-highlight");
          }
        };

        const reveal = (match) => {
          clearPreviousHighlight();
          match.element.setAttribute("data-course-monitor-highlight", "true");
          match.element.scrollIntoView({ block: "center", inline: "nearest" });
          match.element.style.outline = "4px solid #ff3b30";
          match.element.style.boxShadow = "0 0 0 6px rgba(255, 59, 48, 0.25)";
          match.element.style.backgroundColor = "rgba(255, 245, 157, 0.45)";
          return {
            found: true,
            matchedText: elementText(match.element).replace(/\s+/g, " ").trim().slice(0, 240),
          };
        };

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

        const firstMatch = findBestElement();
        if (firstMatch) return reveal(firstMatch);

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

            const match = findBestElement();
            if (match) return reveal(match);
            if (nextTop >= maxTop) break;
          }

          element.scrollTop = originalTop;
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        }

        return { found: false, matchedText: "" };
      },
      {
        needles,
        stepPixels: config.assistScrollStepPixels ?? 900,
        delayMs: config.assistScrollDelayMs ?? 50,
        maxSteps: config.assistScrollMaxSteps ?? 20,
        maxContainers: config.assistScrollMaxContainers ?? 3,
      }
    );
  } catch (error) {
    return { found: false, matchedText: "", error: error.message };
  }
}

export async function revealCourseOnPage(page, course, config = {}) {
  const needles = revealNeedles(course);
  if (typeof page.bringToFront === "function") {
    await page.bringToFront();
  }

  if (needles.length === 0) {
    return { found: false, matchedText: "" };
  }

  const frames = typeof page.frames === "function" ? page.frames() : [page];
  let lastResult = { found: false, matchedText: "" };

  for (const frame of frames) {
    const result = await revealCourseInFrame(frame, needles, config);
    if (result?.found) return result;
    lastResult = result || lastResult;
  }

  return lastResult;
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
