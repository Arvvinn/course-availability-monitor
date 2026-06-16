import "dotenv/config";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright-core";
import {
  analyzeCourseText,
  buildAlertText,
  collectCourseDetailTexts,
  collectPageText,
  courseDisplayLabel,
  courseStatusKey,
  createSimulatedOpenResult,
  normalizeText,
  revealCourseOnPage,
  refreshCoursePage,
  statusLabel,
} from "./monitor-core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = new Set(process.argv.slice(2));
const paths = {
  courses: path.join(__dirname, "courses.json"),
  screenshots: path.join(__dirname, "screenshots"),
  browserProfile: path.join(__dirname, "browser-profile"),
  lastStatus: path.join(__dirname, "last-status.json"),
};

function readBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getConfig() {
  return {
    webhook: process.env.FEISHU_WEBHOOK ?? "",
    feishuSecret: process.env.FEISHU_SECRET ?? "",
    coursePageUrl: process.env.COURSE_PAGE_URL || "https://example.edu.cn",
    intervalMinutes: readNumber("REFRESH_INTERVAL_MINUTES", 1),
    browserChannel: process.env.BROWSER_CHANNEL || "msedge",
    headless: readBool("HEADLESS", false),
    sendUnchangedAlerts: readBool("SEND_UNCHANGED_ALERTS", false),
    alertOnUncertain: readBool("ALERT_ON_UNCERTAIN", false),
    refreshMode: process.env.REFRESH_MODE || "soft",
    saveScreenshots: readBool("SAVE_SCREENSHOTS", false),
    autoScroll: readBool("AUTO_SCROLL", true),
    autoScrollStepPixels: readNumber("AUTO_SCROLL_STEP_PIXELS", 900),
    autoScrollDelayMs: readNumber("AUTO_SCROLL_DELAY_MS", 50),
    autoScrollMaxSteps: readNumber("AUTO_SCROLL_MAX_STEPS", 20),
    autoScrollMaxContainers: readNumber("AUTO_SCROLL_MAX_CONTAINERS", 3),
    assistOnOpen: readBool("ASSIST_ON_OPEN", true),
    beepOnOpen: readBool("BEEP_ON_OPEN", true),
    assistScrollStepPixels: readNumber("ASSIST_SCROLL_STEP_PIXELS", 900),
    assistScrollDelayMs: readNumber("ASSIST_SCROLL_DELAY_MS", 50),
    assistScrollMaxSteps: readNumber("ASSIST_SCROLL_MAX_STEPS", 20),
    assistScrollMaxContainers: readNumber("ASSIST_SCROLL_MAX_CONTAINERS", 3),
    scanCourseDetails: readBool("SCAN_COURSE_DETAILS", true),
    courseDetailWaitMs: readNumber("COURSE_DETAIL_WAIT_MS", 1500),
  };
}

function isMissingWebhook(webhook) {
  return !webhook || webhook.includes("replace-with-your-webhook");
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

function fileTimestamp(date = new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadCourses() {
  const courses = await readJson(paths.courses, []);
  if (!Array.isArray(courses) || courses.length === 0) {
    throw new Error("courses.json 为空，无法监控课程。");
  }

  return courses.map((course) => {
    const keywords = Array.isArray(course.keywords) ? course.keywords : [];
    const strongKeywords = [course.id, course.name, course.classCode].filter(Boolean);
    if (keywords.length === 0 || strongKeywords.length === 0) {
      throw new Error(`课程配置不完整：${JSON.stringify(course)}`);
    }
    return {
      ...course,
      keywords,
      strongKeywords,
      normalizedKeywords: keywords.map(normalizeText),
      normalizedStrongKeywords: strongKeywords.map(normalizeText),
    };
  });
}

function shouldNotify(result, previous, config) {
  if (result.status === "not_found" || result.status === "full") return false;
  if (result.status === "uncertain" && !config.alertOnUncertain) return false;
  if (config.sendUnchangedAlerts) return true;
  return !previous || previous.fingerprint !== result.fingerprint;
}

async function sendFeishu(config, text) {
  if (isMissingWebhook(config.webhook)) {
    throw new Error("FEISHU_WEBHOOK 未配置，请先编辑 .env。");
  }

  const payload = {
    msg_type: "text",
    content: { text },
  };

  if (config.feishuSecret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = createHmac("sha256", `${timestamp}\n${config.feishuSecret}`)
      .update("")
      .digest("base64");
  }

  const response = await fetch(config.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`飞书请求失败：HTTP ${response.status} ${body}`);
  }

  try {
    const json = JSON.parse(body);
    const code = json.code ?? json.StatusCode ?? 0;
    if (code !== 0) {
      throw new Error(`飞书返回错误：${body}`);
    }
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

async function launchBrowser(config) {
  const channels = [
    config.browserChannel,
    config.browserChannel === "msedge" ? "chrome" : "msedge",
  ].filter(Boolean);
  let lastError;

  for (const channel of channels) {
    try {
      console.log(`正在启动浏览器：${channel}`);
      return await chromium.launchPersistentContext(paths.browserProfile, {
        channel,
        headless: config.headless,
        viewport: null,
        args: ["--start-maximized"],
      });
    } catch (error) {
      lastError = error;
      console.warn(`启动 ${channel} 失败，尝试下一个浏览器。`);
    }
  }

  throw new Error(
    `无法启动 Edge/Chrome。请确认已安装 Microsoft Edge 或 Chrome。原始错误：${lastError?.message}`
  );
}

async function getMonitorPage(context, config) {
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());
  if (page.url() === "about:blank") {
    await page.goto(config.coursePageUrl, { waitUntil: "domcontentloaded" });
  }
  await page.bringToFront();
  return page;
}

async function waitForManualLogin() {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(
      "\n请在打开的浏览器里手动登录教务系统，并进入需要监控的选课页面。完成后回到这里按回车开始。\n"
    );
  } finally {
    rl.close();
  }
}

async function saveScreenshot(page, config) {
  if (!config.saveScreenshots) return "";

  await fs.mkdir(paths.screenshots, { recursive: true });
  const screenshotPath = path.join(paths.screenshots, `course-${fileTimestamp()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

async function assistOpenCourse(page, course, config) {
  if (config.beepOnOpen) {
    output.write("\x07\x07\x07");
  }

  if (!config.assistOnOpen) return;

  const result = await revealCourseOnPage(page, course, config);
  if (result.found) {
    console.log(`  已在浏览器中定位并高亮课程：${courseDisplayLabel(course)}`);
    return;
  }

  console.warn(`  未能自动定位课程，请手动搜索：${courseDisplayLabel(course)}`);
}

async function runCheck(page, courses, config) {
  console.log(`\n[${formatTime()}] 开始刷新并检查页面...`);
  try {
    const refreshOutcome = await refreshCoursePage(page, config);
    console.log(`页面刷新策略：${refreshOutcome.mode} / ${refreshOutcome.action}`);
  } catch (error) {
    console.warn(`刷新页面数据时出现问题，继续尝试读取当前页面：${error.message}`);
  }

  const screenshotPath = await saveScreenshot(page, config);
  const overviewText = await collectPageText(page, config);
  const detailTexts = await collectCourseDetailTexts(page, courses, config);
  if (config.scanCourseDetails) {
    console.log(`课程详情页扫描：${detailTexts.length} 个`);
  }
  const text = [overviewText, ...detailTexts].filter(Boolean).join("\n\n--- course detail ---\n\n");
  const lastStatus = await readJson(paths.lastStatus, {});
  const nextStatus = { ...lastStatus };
  const results = courses.map((course) => analyzeCourseText(text, course));

  for (const result of results) {
    const statusKey = courseStatusKey(result.course);
    const previous = lastStatus[statusKey];
    const line = [
      courseDisplayLabel(result.course),
      statusLabel(result),
      result.capacitySource ? `(${result.capacitySource})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`- ${line}`);

    if (shouldNotify(result, previous, config)) {
      if (result.status === "open") {
        await assistOpenCourse(page, result.course, config);
      }

      const alertText = buildAlertText(result, screenshotPath, page.url());
      await sendFeishu(config, alertText);
      console.log(`  已发送飞书提醒：${courseDisplayLabel(result.course)}`);
    }

    nextStatus[statusKey] = {
      fingerprint: result.fingerprint,
      status: result.status,
      available: result.available,
      checkedAt: new Date().toISOString(),
    };
  }

  await writeJson(paths.lastStatus, nextStatus);
  if (screenshotPath) {
    console.log(`截图已保存：${screenshotPath}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const config = getConfig();
  const courses = await loadCourses();

  if (args.has("--test-feishu")) {
    await sendFeishu(config, `选课监控测试\n\n时间：${formatTime()}\n如果收到这条消息，飞书机器人可用。`);
    console.log("飞书测试消息已发送。");
    return;
  }

  if (args.has("--test-alert")) {
    const course = courses[0];
    const result = createSimulatedOpenResult(course, 1);
    const alertText = buildAlertText(result, "", config.coursePageUrl, {
      simulated: true,
    });
    await sendFeishu(config, alertText);
    console.log(`脚本模拟抓课提醒已发送：${courseDisplayLabel(course)}`);
    return;
  }

  if (isMissingWebhook(config.webhook)) {
    throw new Error("FEISHU_WEBHOOK 仍是占位地址。请先编辑 .env，填入飞书机器人 Webhook。");
  }

  const context = await launchBrowser(config);
  const page = await getMonitorPage(context, config);
  await waitForManualLogin();

  if (args.has("--once")) {
    await runCheck(page, courses, config);
    await context.close();
    return;
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;
  console.log(`开始持续监控，每 ${config.intervalMinutes} 分钟检查一次。按 Ctrl+C 停止。`);

  while (true) {
    try {
      await runCheck(page, courses, config);
    } catch (error) {
      console.error(`[${formatTime()}] 本轮检查失败：${error.stack || error.message}`);
    }
    await sleep(intervalMs);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
