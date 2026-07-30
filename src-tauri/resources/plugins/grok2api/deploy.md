# Deploy: grok2api

## Strategy: Source (优先)

### Prerequisites

- Go >= 1.26 (安装方式: winget install GoLang.Go，或从 https://golang.google.cn/dl/ 下载 MSI)
- Node.js >= 18 (安装方式: winget install OpenJS.NodeJS)
- pnpm (安装方式: npm install -g pnpm)
- Git (安装方式: winget install Git.Git)

### Environment Variables

中国大陆网络环境需要设置：
- GOPROXY=https://goproxy.cn,direct (Go 模块代理)
- GOCACHE={installPath}\.gocache (Go 编译缓存目录，必须是绝对路径)

### Steps

#### 1. Clone Source
```bash
git clone https://github.com/chenyme/grok2api.git {installPath}
cd {installPath}
```
**验证**: `{installPath}\backend\go.mod` 文件存在

#### 2. Build Frontend
```bash
cd frontend
pnpm install
pnpm build
cd ..
```
**验证**: `{installPath}\frontend\dist\index.html` 文件存在

#### 3. Build Backend
**Windows:**
```bash
set GOPROXY=https://goproxy.cn,direct
set GOCACHE={installPath}\.gocache
cd backend
go build -o ..\grok2api.exe ./cmd/grok2api
cd ..
```
**macOS / Linux:**
```bash
export GOPROXY=https://goproxy.cn,direct
export GOCACHE={installPath}/.gocache
cd backend && go build -o ../grok2api ./cmd/grok2api && cd ..
```
**验证**: `{installPath}\grok2api{ext}` 文件存在

#### 4. Config
AnyBridge will auto-generate config.yaml via adapter.js generateConfig().
The config includes:
- port: {config.port} (default: 8000)
- adminPassword: auto-generated
- jwtSecret: auto-generated (32-char hex)
- encryptionKey: auto-generated (base64 32 bytes)

注意: encryptionKey 在首次写入账号后不可更改，否则已有凭据无法解密。

#### 5. Start & Verify
启动由 AnyBridge 插件管理器自动完成（plugin_start 命令）。
**验证**: 
- 进程启动成功
- GET http://127.0.0.1:{config.port}/healthz 返回 200

## Strategy: Docker (备选)

### Prerequisites
- Docker Desktop (安装方式: winget install Docker.DockerDesktop)

### Steps

#### 1. Prepare Config
AnyBridge will auto-generate config.yaml via adapter.js generateConfig().

#### 2. Start Container
```bash
cd {installPath}
docker compose up -d
```
**验证**: `docker compose ps` 显示 grok2api 运行中
**验证**: GET http://127.0.0.1:{config.port}/healthz 返回 200

## Notes

- GOPROXY 必须设置，否则 go mod download 会超时（proxy.golang.org 被墙）
- GOCACHE 必须是绝对路径，否则 Go 会报错
- SQLite 数据库自动创建在 {installPath}\data\backend.db
- 前端构建产物在 {installPath}\frontend\dist\，Go 二进制会读取此目录
- 首次启动会创建管理员账号（bootstrapAdmin），创建后建议删除配置中的 bootstrapAdmin 段

## Uninstall

Docker 方式：`docker compose down` 后删除 {installPath} 目录和 Docker volume `grok2api-data`（`docker volume rm grok2api_grok2api-data`）。
源码方式：直接删除 {installPath} 目录。
数据目录 {installPath}\data\ 包含 SQLite 数据库和媒体文件，如需保留数据请先备份。
