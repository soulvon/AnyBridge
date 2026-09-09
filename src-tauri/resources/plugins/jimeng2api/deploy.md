# Deploy: jimeng2api

## Strategy: Source (源码构建，推荐)

### Prerequisites

- Node.js >= 22 (安装方式: winget install OpenJS.NodeJS，或从 https://nodejs.org/ 下载安装)
- Git (安装方式: winget install Git.Git)

### Steps

#### 1. Clone Source
```bash
git clone https://github.com/zhizinan1997/jimeng-free-api-all.git {installPath}
cd {installPath}
```
**验证**: `{installPath}\package.json` 文件存在

#### 2. Install Dependencies
```bash
cd {installPath}
npm install
```
**验证**: `{installPath}\node_modules` 目录存在

#### 3. Build Project
```bash
cd {installPath}
npm run build
```
**验证**: `{installPath}\dist\index.js` 文件存在

#### 4. Config
AnyBridge 将自动根据表单配置生成 .env 环境变量文件，包含端口与账号池主加密密钥。
配置包含：
- port: {config.port} (默认: 5566)
- accountPoolKey: 自动生成高强度 32 字节 Base64 密钥
- timezone: Asia/Shanghai

注意: accountPoolKey 在首次存入即梦账号后不可随意更改，否则无法解密已保存的 Cookie。

#### 5. Start & Verify
启动由 AnyBridge 插件管理器自动完成（plugin_start 命令）。
**验证**:
- 进程启动成功
- GET http://127.0.0.1:{config.port}/v1/models 返回 200

## Notes

- 项目依赖 better-sqlite3 原生模块，因此源码编译必须使用 Node.js >= 22
- SQLite 数据库及历史数据自动存储在 {installPath}\data 目录
- 首次访问 Web 控制台可直接在浏览器打开 http://127.0.0.1:{config.port}

## Uninstall

直接停止服务并删除 {installPath} 目录。
若需保留账号池历史与配置，请先备份 {installPath}\data 目录。
