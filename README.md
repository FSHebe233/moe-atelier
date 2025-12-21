# 萌图工坊（moe-atelier）

一个方便 **nano banana pro** 跑图的小工具。前端通过 OpenAI 兼容接口发起请求，自动从响应中解析 base64/URL 图片并展示。

## 功能特性
- 支持 OpenAI 兼容接口（`/v1` + `chat/completions`）。
- 自动解析图片结果（`data[0].b64_json`、`data[0].url`，以及消息文本中的 Markdown 图片）。
- 多任务并发生成、统计面板、失败自动重试。
- 前端 IndexedDB 缓存图片，降低重复加载。
- 一键下载并保存到项目目录 `saved-images/`（由本地服务写入）。

## 技术栈
- React + Vite + Ant Design
- Express（本地开发/生产一体服务）

## 快速开始
```bash
npm install
npm run dev
```
浏览器访问 `http://localhost:5173`。

## 生产构建与运行
```bash
npm run build
npm run preview
# 或
npm run start
```

## 配置说明（前端面板）
- **API 接口地址**：默认 `https://api.openai.com/v1`。使用其他兼容服务时，填写其 `/v1` 基础地址。
- **API Key**：你的密钥。
- **模型名称**：可点击刷新按钮拉取 `/models`。
- **流式开关**：开启后会解析流式文本中的 Markdown 图片链接。

## 公网访问
### 开发模式（Vite）
需要监听公网地址（`0.0.0.0`）：
```powershell
$env:VITE_HOST="0.0.0.0"
npm run dev
```
或：
```bash
VITE_HOST=0.0.0.0 npm run dev
```
然后放通端口（默认 5173）。

### 生产模式（Express）
默认端口 `5173`，可通过 `PORT` 指定：
```powershell
$env:PORT="8080"
npm run start
```
或：
```bash
PORT=8080 npm run start
```
如果用 Nginx/Caddy 反代到公网，请保证 HTTPS（因为要在浏览器里填写 API Key），并确保你的 OpenAI 兼容服务允许跨域访问。

## 目录结构
- `src/`：前端源码
- `server.mjs`：本地服务（开发中挂载 Vite，中生产提供静态资源与 `/api/save-image`）
- `dist/`：构建产物
- `saved-images/`：本地保存图片目录（自动创建）

## 注意事项
- 仅支持 OpenAI 兼容格式；响应中需包含 base64 或图片 URL。
- 如果只部署静态 `dist/` 而不跑 `server.mjs`，保存图片到 `saved-images/` 的功能不可用。
