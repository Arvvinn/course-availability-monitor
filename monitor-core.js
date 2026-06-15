const SEARCH_BUTTON_NAMES = [/^(检索|查询|搜索)$/];
const SELECTION_ENTRY_NAMES = ["选课(按开课计划)", "选课（按开课计划）"];

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
