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
