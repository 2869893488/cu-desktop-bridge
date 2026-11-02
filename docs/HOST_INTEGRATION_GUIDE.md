# KimiCU Desktop Bridge 跨宿主接入指南与避坑手册

本文档为在不同智能体宿主环境中集成 **KimiCU Desktop Bridge** 提供标准步骤、环境变量规范与常见故障排查建议。

---

## 一、 支持的宿主全景

| 智能体宿主平台 | 配置文件位置 | 接入方式 | 推荐测试用例 |
|---|---|---|---|
| **Google Antigravity** | `%USERPROFILE%\.gemini\config\mcp_config.json` | stdio MCP (`node-repl.exe`) | `nodeRepl.write(42);` |
| **WorkBuddy** | `%USERPROFILE%\.workbuddy\mcp.json` | stdio MCP (`node-repl.exe`) | 查看运行窗口并获取标题 |
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` | stdio MCP (`node-repl.exe`) | 记事本自动输入与截图 |
| **OpenAI Codex / CLI** | `%USERPROFILE%\.codex\config.toml`（TOML） | stdio MCP (`node-repl.exe`) | 脚本化批量桌面交互 |
| **Kimi Code** | `.kimi-code\plugins\managed\kimi-cu-win` | 原生插件挂载 | 完整 Code Mode |

---

## 二、 关键系统环境变量配置清单

由于各个宿主在以子进程拉起 stdio MCP 服务时，对系统环境变量的继承行为各有不同（部分宿主会剥离用户级 PATH 或缺少 Windows 关键系统变量），配置时务必显式声明以下环境变量。宿主通常不展开 `%VAR%`；`apply-host-config.mjs` 会在生成时把 `PATH` 重写为运行生成器的 Node 目录加 Windows 系统目录，其余占位符由启动器自愈。

| 环境变量名 | 是否必须 | 推荐配置值 | 作用与说明 |
|---|---|---|---|
| `PATH` | **必须** | `<Node 目录>;C:\Windows\System32;C:\Windows` | 保证子进程能定位 Node.js 24+；生成器自动填入，不固化完整用户 PATH |
| `LOCALAPPDATA` | **必须** | `%LOCALAPPDATA%` | 供引导程序定位底层 `kimi-cu.exe` 守护进程的安装路径 |
| `USERPROFILE` | 推荐 | `%USERPROFILE%` | 确保沙箱能正确计算用户主目录 `nodeRepl.homeDir` |
| `SYSTEMROOT` | 推荐 | `%SYSTEMROOT%` | 确保 Windows 底层 API 与 Win32 DLL 加载正常 |
| `KIMI_CU_WINDOWS_EXE` | 可选 | 自定义 `kimi-cu.exe` 绝对路径 | 当守护进程未安装在默认目录时显式覆盖指定 |
| `KIMI_NODE_REPL_WORKSPACE` | 可选 | 任务工作区绝对路径 | 自定义单元格代码运行的工作目录 |

---

## 三、 各宿主接入实操步骤

### 0. 通用：从已安装 payload 写入

安装器把官方 payload 放到 `%LOCALAPPDATA%\KimiCU-Community\payloads\<name>-<version>-<fingerprint>`，并在 `state\current.json` 记录版本、路径和逐文件哈希。`apply-host-config.mjs` 会先复核这些信息，再只合并 `mcpServers` 下的 `kimi-cu` 节点：

```powershell
# 预览：校验状态和 payload，不写文件
node scripts/apply-host-config.mjs --host claude-desktop `
  --config-path "$env:APPDATA\Claude\claude_desktop_config.json" `
  --install-root "$env:LOCALAPPDATA\KimiCU-Community" --dry-run

# 正式写入：先备份，再原子替换
node scripts/apply-host-config.mjs --host claude-desktop `
  --config-path "$env:APPDATA\Claude\claude_desktop_config.json" `
  --install-root "$env:LOCALAPPDATA\KimiCU-Community"

# 卸载：只移除本项目节点
node scripts/apply-host-config.mjs --host claude-desktop `
  --config-path "$env:APPDATA\Claude\claude_desktop_config.json" --remove
```

行为边界：

- 现有文件不是合法 JSON、`mcpServers` 不是对象或配置文件是符号链接时，直接失败，不覆盖原文件。
- 写入前在同目录生成 `<文件名>.kimi-cu-backup-<时间戳>`；超过同秒冲突时追加序号。
- 使用同目录临时文件和原子替换，保留原缩进与换行风格，输出不含 BOM。
- 状态缺失、schema 不符、payload 路径逃逸、文件大小或 SHA-256 不符时停止，不写宿主配置。
- 拒绝写入 `%USERPROFILE%\.kimi-code\plugins\managed\`。
- `--repo-root` 仅用于开发，会把 `command` 指向仓库 `src/runtime` 并打印警告。
- Antigravity 和 WorkBuddy 在运行时会缓存配置，并可能在退出时整体回写。建议先退出宿主再写入，或写入后立即重启并确认配置仍然有效。
- 写入前生成的备份是原配置的完整副本，可能包含其他 MCP 服务的 env 密钥。请与主配置同等保护，确认无需恢复后自行删除。
- 原子替换会创建新文件，原文件上的显式 ACL 不会保留。若曾手动收紧权限，请在写入后重新设置。

### 1. Google Antigravity
1. 配置文件通常位于 `%USERPROFILE%\.gemini\config\mcp_config.json`（本机已验证）；版本不同时，从 MCP 设置中确认实际路径；
2. 用 `--host antigravity --config-path <该文件绝对路径>` 运行上面的命令；
3. 重启宿主后确认 `js`、`js_reset`、`js_add_node_module_dir` 三个工具已加载。

### 2. WorkBuddy
1. 配置文件位于 `%USERPROFILE%\.workbuddy\mcp.json`；
2. 运行 `--host workbuddy --config-path` 指向该文件；
3. 在 WorkBuddy 中重新加载 MCP 插件。

### 3. Claude Desktop
1. 配置文件通常位于 `%APPDATA%\Claude\claude_desktop_config.json`；
2. 运行 `--host claude-desktop --config-path` 指向该文件；
3. 退出所有 Claude Desktop 进程（包括系统托盘图标）并重新启动。

若该目录不存在（未安装，或 MSIX 版把配置放在 `LocalCache\Roaming\Claude` 下），脚本会因父目录缺失而拒绝写入，不会创建孤立配置。请先从宿主的设置界面确认实际路径。

本仓库模板保留 `cwd`。若你的 Claude Desktop 版本拒绝未知字段，请在写入后的配置中只保留 `command`、`args` 和 `env`，再重启验证。

### 4. OpenAI Codex
Codex 使用 TOML 配置 `%USERPROFILE%\.codex\config.toml`，表名是 `mcp_servers`（下划线），不是 JSON 的 `mcpServers`，因此 `apply-host-config.mjs` 不会自动改写，以免破坏已有 TOML 表。请先运行 `scripts/setup.ps1 -Doctor` 取得 payload 根目录，再手动添加：

```toml
[mcp_servers.kimi-cu]
type = "stdio"
command = 'C:/<payload>/runtime/node-repl.exe'
args = []
startup_timeout_sec = 120
```

现有 Codex 条目没有使用 `cwd`，在确认目标版本支持前不要添加。`templates/codex/codex_mcp.json` 仅作为字段参考。

### 5. 与官方 `kimi-cu-win` 并存
Antigravity 和 WorkBuddy 常已注册官方插件的 `kimi-cu-win`。本项目使用独立的 `kimi-cu` 键，不会覆盖官方条目，但两者同时启用会重复暴露同名工具。确认只保留一个，或只禁用其中一个。

---

## 四、 常见踩坑与故障排障（FAQ）

### Q1: 启动时报 `Node.js 24.15.0 or newer is required; found vXX.XX.X`
- **根本原因**：宿主启动子进程时优先匹配到了系统旧版本 Node（如 nvm、volta 或旧版安装包）。
- **解决办法**：在宿主配置的 `env.PATH` 最前面显式加上 Node 24 的绝对路径（如 `C:\Program Files\nodejs;...`）。

### Q2: 提示 `LOCALAPPDATA is unavailable; configure KIMI_CU_WINDOWS_EXE` 或误传字面量 `"%LOCALAPPDATA%"`
- **根本原因**：部分宿主在以空白环境 spawn 进程时丢失环境变量，或在 JSON 配置文件中直接写入字面量 `"%LOCALAPPDATA%"`（MCP 宿主通常直接将 JSON 字典传递给 `child_process.spawn`，不会像 cmd 批处理那样自动展开 `%VAR%`，导致路径被当作字面字符串）。
- **处理办法**：先退出宿主，再重新运行 `apply-host-config.mjs --install-root ...` 生成配置；该命令会写入绝对路径并构造最小 PATH。公开快照不修改官方启动器，环境变量兜底行为取决于官方版本；若仍报错，请核对官方组件安装与宿主环境，不要手工固化完整用户 PATH。

### Q3: 运行批处理文件时报错 `'畨瑁?' 不是内部或外部命令`
- **根本原因**：Windows 命令提示符（`cmd.exe`）在执行含有多字节中文的 UTF-8 批处理文件时产生字节错位截断。
- **规避规范**：本项目所有 `.cmd` / `.bat` 文件严格遵循全 ASCII 纯英文规范；复杂逻辑统一使用 PowerShell（显式 UTF-8）组织。

### Q4: 提示 `KimiCU native runtime is not installed`
- **根本原因**：尚未安装官方底层 Native Agent 守护进程。
- **解决办法**：从官方分发端点获取安装脚本：
  `https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd`
  安装位置、版本与运行行为以官方分发为准。
