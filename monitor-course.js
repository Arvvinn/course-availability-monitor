import "dotenv/config";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright-core";
import { refreshCoursePage } from "./monitor-core.js";

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
    coursePageUrl: process.env.COURSE_PAGE_URL || "https://xk.henu.edu.cn",
    intervalMinutes: readNumber("REFRESH_INTERVAL_MINUTES", 5),
    browserChannel: process.env.BROWSER_CHANNEL || "msedge",
    headless: readBool("HEADLESS", false),
    sendUnchangedAlerts: readBool("SEND_UNCHANGED_ALERTS", false),
    alertOnUncertain: readBool("ALERT_ON_UNCERTAIN", true),
    refreshMode: process.env.REFRESH_MODE || "soft",
  };
}

function isMissingWebhook(webhook) {
  return !webhook || webhook.includes("replace-with-your-webhook");
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/[ \t\r\n]+/g, "")
    .replace(/[－–—]/g, "-")
    .replace(/[／]/g, "/")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")");
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

function parseCapacity(context) {
  const normalized = context.replace(/[／]/g, "/");

  const triple = normalized.match(
    /限选\s*\/\s*已选\s*\/\s*可选\s*[:：]?\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d*)/
  );
  if (triple) {
    const limit = Number(triple[1]);
    const selected = Number(triple[2]);
    const availableText = triple[3];
    const available =
      availableText === "" ? Math.max(0, limit - selected) : Number(availableText);
    return {
      limit,
      selected,
      available,
      source: triple[0],
    };
  }

  const labeledTriple = normalized.match(
    /限选[^\d]{0,20}(\d+)[^\d]{0,20}已选[^\d]{0,20}(\d+)[^\d]{0,20}可选[^\d]{0,20}(\d+)/
  );
  if (labeledTriple) {
    return {
      limit: Number(labeledTriple[1]),
      selected: Number(labeledTriple[2]),
      available: Number(labeledTriple[3]),
      source: labeledTriple[0],
    };
  }

  const availability = normalized.match(
    /(?:余量|剩余名额|剩余|可选人数)\s*[:：]?\s*(\d+)/
  );
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

function getCourseContext(text, course) {
  const rawNeedles = [...course.strongKeywords, ...course.keywords].filter(Boolean);
  const indexes = rawNeedles
    .map((needle) => text.indexOf(needle))
    .filter((index) => index >= 0);

  if (indexes.length === 0) {
    return text.slice(0, 2500);
  }

  const start = Math.max(0, Math.min(...indexes) - 500);
  const end = Math.min(text.length, Math.max(...indexes) + 1000);
  return text.slice(start, end);
}

function analyzeCourse(text, course) {
  const normalizedPage = normalizeText(text);
  const matchedKeywords = course.keywords.filter((keyword) =>
    normalizedPage.includes(normalizeText(keyword))
  );
  const strongMatches = course.strongKeywords.filter((keyword) =>
    normalizedPage.includes(normalizeText(keyword))
  );

  const present = strongMatches.length >= 1 && matchedKeywords.length >= 2;
  if (!present) {
    return {
      course,
      status: "not_found",
      available: null,
      matchedKeywords,
      context: "",
      capacitySource: "",
      fingerprint: "not_found",
    };
  }

  const context = getCourseContext(text, course);
  const capacity = parseCapacity(context);
  let status = "uncertain";
  if (typeof capacity.available === "number") {
    status = capacity.available > 0 ? "open" : "full";
  }

  return {
    course,
    status,
    available: capacity.available,
    limit: capacity.limit,
    selected: capacity.selected,
    matchedKeywords,
    context,
    capacitySource: capacity.source,
    fingerprint: [
      status,
      capacity.available ?? "unknown",
      capacity.limit ?? "unknown",
      capacity.selected ?? "unknown",
      matchedKeywords.join("|"),
    ].join("::"),
  };
}

function shouldNotify(result, previous, config) {
  if (result.status === "not_found" || result.status === "full") return false;
  if (result.status === "uncertain" && !config.alertOnUncertain) return false;
  if (config.sendUnchangedAlerts) return true;
  return !previous || previous.fingerprint !== result.fingerprint;
}

function statusLabel(result) {
  if (result.status === "open") return `有可选名额：${result.available}`;
  if (result.status === "full") return "暂无余量";
  if (result.status === "uncertain") return "已匹配到课程，但未能解析可选人数，需要人工确认";
  return "本页未匹配到该课程";
}

function buildAlertText(result, screenshotPath, pageUrl) {
  const course = result.course;
  const lines = [
    "选课监控提醒",
    "",
    `课程：[${course.id}] ${course.name}`,
    `教师：${course.teacher || "未配置"}`,
    `教学班：${course.classCode || "未配置"}`,
    `状态：${statusLabel(result)}`,
    `时间：${formatTime()}`,
    `页面：${pageUrl}`,
    `截图：${screenshotPath}`,
  ];

  if (result.capacitySource) {
    lines.push(`识别字段：${result.capacitySource}`);
  }

  lines.push("", "请手动打开教务系统确认；脚本不会自动选课。");
  return lines.join("\n");
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

async function getAllPageText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    try {
      const text = await frame.locator("body").innerText({ timeout: 5000 });
      if (text.trim()) parts.push(text);
    } catch {
      // Some cross-origin or transient frames may not expose text. Ignore them.
    }
  }
  return parts.join("\n\n--- frame ---\n\n");
}

async function saveScreenshot(page) {
  await fs.mkdir(paths.screenshots, { recursive: true });
  const screenshotPath = path.join(paths.screenshots, `course-${fileTimestamp()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

async function runCheck(page, courses, config) {
  console.log(`\n[${formatTime()}] 开始刷新并检查页面...`);
  try {
    const refreshOutcome = await refreshCoursePage(page, config);
    console.log(`页面刷新策略：${refreshOutcome.mode} / ${refreshOutcome.action}`);
  } catch (error) {
    console.warn(`刷新页面数据时出现问题，继续尝试读取当前页面：${error.message}`);
  }

  const screenshotPath = await saveScreenshot(page);
  const text = await getAllPageText(page);
  const lastStatus = await readJson(paths.lastStatus, {});
  const nextStatus = { ...lastStatus };
  const results = courses.map((course) => analyzeCourse(text, course));

  for (const result of results) {
    const previous = lastStatus[result.course.id];
    const line = [
      `[${result.course.id}] ${result.course.name}`,
      statusLabel(result),
      result.capacitySource ? `(${result.capacitySource})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`- ${line}`);

    if (shouldNotify(result, previous, config)) {
      const alertText = buildAlertText(result, screenshotPath, page.url());
      await sendFeishu(config, alertText);
      console.log(`  已发送飞书提醒：${result.course.name}`);
    }

    nextStatus[result.course.id] = {
      fingerprint: result.fingerprint,
      status: result.status,
      available: result.available,
      checkedAt: new Date().toISOString(),
    };
  }

  await writeJson(paths.lastStatus, nextStatus);
  console.log(`截图已保存：${screenshotPath}`);
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
