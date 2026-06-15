# 河南大学选课余量监控

这是一个本地运行的选课余量提醒脚本。它会打开浏览器，由你手动登录教务系统，然后定时检查页面上的课程余量，并通过飞书自定义机器人提醒你。

它只做被动监控：

- 不保存教务系统账号或密码。
- 不自动点击“选课”或“提交”。
- 不绕过验证码、登录限制或系统风控。
- 默认每 1 分钟检查一次。
- 默认不保存截图，只读取页面文字。
- 默认会快速滚动页面和可滚动列表，尽量读取不在当前屏幕内的课程。

## 适用场景

第二轮、第三轮选课是先到先得。如果你不方便一直盯着电脑，可以让这个脚本在电脑上监控指定课程；一旦页面上疑似出现余量，它会通过飞书提醒你，再由你自己手动去选。

## 准备环境

需要提前安装：

- Node.js 20 或更新版本
- Microsoft Edge 或 Google Chrome
- 一个飞书账号

安装依赖：

```powershell
npm install
```

## 配置飞书提醒

建议新建一个只有自己的飞书群，然后添加“自定义机器人”。

把 `.env.example` 复制为 `.env`：

```powershell
copy .env.example .env
```

编辑 `.env`，把 `FEISHU_WEBHOOK` 改成你的机器人 Webhook：

```env
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/你的地址
```

如果你的机器人开启了“签名校验”，把密钥填到：

```env
FEISHU_SECRET=你的签名密钥
```

如果机器人只开启“自定义关键词”，建议关键词设置为：

```text
选课
```

测试飞书：

```powershell
npm run test-feishu
```

手机飞书收到测试消息后，再继续配置课程。

如果想测试“真的抓到余量时”的提醒格式，可以先配置好 `courses.json`，再运行：

```powershell
npm run test-alert
```

这个命令会读取 `courses.json` 里的第一门课，构造一条模拟“检测到可选名额”的提醒，通过脚本自己的通知逻辑发送到飞书。它不会打开教务系统，也不会选课。

## 配置要监控的课程

把示例课程配置复制为本地配置：

```powershell
copy courses.example.json courses.json
```

编辑 `courses.json`。每个课程对象格式如下：

```json
{
  "id": "课程代码",
  "name": "课程名称",
  "teacher": "任课教师",
  "classCode": "教学班号",
  "keywords": ["课程代码", "课程名称", "任课教师", "教学班号"]
}
```

`keywords` 用来匹配页面文本。建议至少填写：

- 课程代码
- 课程名称
- 任课教师
- 教学班号
- 方向、班级名称或其他能区分教学班的文字

多个课程就写多个对象。`courses.json` 是本地私有配置，已经被 Git 忽略，不会提交到仓库。

## 运行一次检查

```powershell
npm run once
```

脚本会打开浏览器。你需要手动登录教务系统，进入选课页面，然后回到终端按回车。脚本会检查一次并读取页面文字。

## 持续监控

```powershell
npm run monitor
```

浏览器打开后，手动登录教务系统并进入选课页面，再回到终端按回车。之后脚本会按 `.env` 中的 `REFRESH_INTERVAL_MINUTES` 定时检查。

默认刷新方式是：

```env
REFRESH_MODE=soft
```

这个模式不会按浏览器刷新按钮，而是在教务系统页面内尝试点击“选课(按开课计划)”和“检索/查询/搜索”来更新数据，避免刷新后回到主控首页。

如果课程列表很长，脚本默认会自动滚动页面和可滚动列表，把滚动过程中出现的文字合并后再匹配课程。这个过程通常只需要几秒，不需要人工滚轮。

## 常用配置

`.env` 里可以改：

```env
COURSE_PAGE_URL=https://xk.henu.edu.cn
REFRESH_INTERVAL_MINUTES=1
REFRESH_MODE=soft
SAVE_SCREENSHOTS=false
AUTO_SCROLL=true
AUTO_SCROLL_STEP_PIXELS=900
AUTO_SCROLL_DELAY_MS=50
AUTO_SCROLL_MAX_STEPS=20
AUTO_SCROLL_MAX_CONTAINERS=3
BROWSER_CHANNEL=msedge
HEADLESS=false
SEND_UNCHANGED_ALERTS=false
ALERT_ON_UNCERTAIN=true
```

说明：

- `REFRESH_INTERVAL_MINUTES`：检查间隔，默认 1 分钟。
- `REFRESH_MODE`：刷新方式，默认 `soft`。
- `SAVE_SCREENSHOTS`：是否保存截图，默认 `false`。
- `AUTO_SCROLL`：是否自动滚动扫描页面，默认 `true`。
- `AUTO_SCROLL_STEP_PIXELS`：每次滚动的像素距离。
- `AUTO_SCROLL_DELAY_MS`：每次滚动后等待页面更新的时间。
- `AUTO_SCROLL_MAX_STEPS`：每个可滚动区域最多滚动多少步。
- `AUTO_SCROLL_MAX_CONTAINERS`：最多扫描多少个可滚动区域。
- `BROWSER_CHANNEL`：默认 `msedge`，也可以改成 `chrome`。
- `SEND_UNCHANGED_ALERTS`：默认只在状态变化时提醒，改成 `true` 会每次都提醒。
- `ALERT_ON_UNCERTAIN`：页面匹配到课程但没解析出余量时是否提醒。

## 本地文件

这些文件不会提交到 Git：

- `.env`：你的飞书 Webhook 和本地配置。
- `courses.json`：你要监控的课程。
- `browser-profile/`：浏览器登录会话。
- `screenshots/`：仅当 `SAVE_SCREENSHOTS=true` 时保存的截图。
- `last-status.json`：上一次检查状态，用来减少重复提醒。

## 注意事项

- 电脑不要休眠，不要关闭脚本打开的浏览器。
- 如果教务系统登录过期，需要重新登录。
- 脚本只能根据页面文字判断，不能保证 100% 准确。
- 收到提醒后，仍然需要你自己打开教务系统确认并手动选课。
