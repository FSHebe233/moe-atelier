# 萌图工坊（moe-atelier）

一个方便 **nano banana pro** 跑图的小工具。前端通过 OpenAI 兼容接口发起请求，自动从响应中解析 base64/URL 图片并展示。

## 功能特性
- 支持 OpenAI 兼容接口（`/v1` + `chat/completions`），解析 `data[0].b64_json` / `data[0].url` / Markdown 图片（含流式）。
- 多任务并发（1-10）+ 任务拖拽排序 + 自动重试/暂停/继续 + 单任务与全局统计。
- 支持上传参考图（多模态输入），后端模式下自动缓存。
- 内置「提示词广场」：默认拉取 nanobanana-website 数据源，支持自定义 URL、标签筛选、收藏。
- 前端 IndexedDB 缓存图片、localStorage 保存配置与任务。
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

## Docker（可选）
```bash
docker build -t moe-atelier .
docker run --rm -p 5173:5173 -v ${PWD}/saved-images:/app/saved-images -v ${PWD}/server-data:/app/server-data moe-atelier
```
或使用 `docker-compose`：
```bash
docker compose up --build
```
`docker-compose` 已包含 `server-data/` 挂载；使用 `docker run` 时也请挂载该目录以持久化后端模式数据。

## 配置说明（前端面板）
- **API 接口地址**：默认 `https://api.openai.com/v1`。使用其他兼容服务时，填写其 `/v1` 基础地址。
- **API Key**：你的密钥。
- **模型名称**：可点击刷新按钮拉取 `/models`。
- **流式开关**：开启后会解析流式文本中的 Markdown 图片链接。
- **提示词数据源**：在「提示词广场」里可切换为自定义 URL。

## 后端模式（可选）
开启后端模式后，配置、任务与图片缓存会保存到服务器端，并通过 SSE 实时同步，适合多端协作或长时间跑图。

1) 在项目根目录创建 `.env`（可参考 `.env.example`）：
```bash
BACKEND_PASSWORD=你的密码
BACKEND_LOG_REQUESTS=0
BACKEND_LOG_OUTBOUND=0
BACKEND_LOG_RESPONSE=0
```
2) 启动 `server.mjs`（`npm run dev` / `npm run start`）。
3) 打开前端「系统配置」里的「后端模式」，输入上面的密码即可。

后端数据会存放在 `server-data/`（任务信息、上传图与生成图、全局状态）。
注意：后端模式会把 API Key 等配置写入 `server-data/state.json`，请妥善保管服务器。

## 环境变量
- `BACKEND_PASSWORD`：启用后端模式所需密码（必填）。
- `BACKEND_LOG_REQUESTS`：打印请求日志（`1/true/yes` 开启）。
- `BACKEND_LOG_OUTBOUND`：打印后端到模型服务的请求日志。
- `BACKEND_LOG_RESPONSE`：打印模型响应（会截断长内容）。
- `PORT`：服务监听端口，默认 `5173`。
- `VITE_HOST`：开发模式下的 Vite Host，外网访问时可设为 `0.0.0.0`。

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
- `server.mjs`：本地服务（开发中挂载 Vite，生产提供静态资源与 `/api/save-image`）
- `server-data/state.json`：后端配置与全局统计（后端模式）
- `server-data/tasks/`：任务缓存（后端模式）
- `server-data/images/`：上传/生成图片缓存（后端模式）
- `dist/`：构建产物
- `saved-images/`：本地保存图片目录（自动创建）

## 注意事项
- 仅支持 OpenAI 兼容格式；响应中需包含 base64 或图片 URL。
- 如果只部署静态 `dist/` 而不跑 `server.mjs`，保存图片到 `saved-images/` 与后端模式不可用。
- 后端模式会在服务器保存配置与 API Key，共享或公网环境请注意安全。

## 致谢
感谢 [nanobanana-website](https://github.com/unknowlei/nanobanana-website) 提供的数据源。
