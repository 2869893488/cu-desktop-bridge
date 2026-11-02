# CU Desktop Bridge

> 预览版本 `0.1.0-preview.1`：接口和安装流程可能变化。

非官方社区项目，与 Moonshot AI、Kimi、Google Antigravity、Anthropic、OpenAI 不存在隶属、授权或背书关系。

本仓库不包含、也不分发官方 KimiCU 运行时、EXE、ZIP 或官方插件源码。它只提供：

- 本地已安装官方 payload 的哈希锁定与事务化安装脚本
- 把缓存 payload 安全写入宿主 MCP 配置的适配器
- 不依赖真实桌面的自动化测试

## 风险

桌面控制会读取屏幕内容、激活窗口并接管键盘鼠标。截图可能包含敏感信息。请仅在受控环境或独立测试账户中使用，并在执行前审查模型生成的代码。本项目不提供任何担保。

## 要求

- Windows 10/11 x64，已解锁的交互式桌面
- Node.js 24.15.0 或更新版本，x64
- PowerShell 5.1 或 7
- 用户自行安装的官方 KimiCU payload。仓库附带基于官方 0.3.10 本地安装生成的 `payload-lock.json`；哈希只证明文件集内容，不证明上游身份。其他版本必须自行生成并复核清单。

## 安装

```powershell
# 1. 预览，不写入状态
powershell.exe -NoProfile -File scripts/setup.ps1 -SourcePath "<官方 payload 目录>" -LockPath "<payload-lock.json>" -DryRun

# 2. 校验并安装到 %LOCALAPPDATA%\KimiCU-Community
powershell.exe -NoProfile -File scripts/setup.ps1 -SourcePath "<官方 payload 目录>" -LockPath "<payload-lock.json>"

# 3. 诊断
powershell.exe -NoProfile -File scripts/setup.ps1 -Doctor
```

```powershell
# 4. 写入宿主配置（示例：WorkBuddy）
node scripts/apply-host-config.mjs --host workbuddy `
  --config-path "$env:USERPROFILE\.workbuddy\mcp.json" `
  --install-root "$env:LOCALAPPDATA\KimiCU-Community"
```

JSON 合并适配器覆盖 Antigravity、WorkBuddy 和 Claude Desktop。Antigravity 与 WorkBuddy 为实验性，Claude Desktop 尚未真机验证；Codex 使用 TOML，需要手动配置。详见 docs/SUPPORT_MATRIX.md 与 docs/HOST_INTEGRATION_GUIDE.md。

## 测试

```powershell
npm test
```

默认测试不访问真实桌面，不要求已安装 payload。

## 文档

- 安装、升级、回滚、卸载：docs/INSTALL_UPGRADE_ROLLBACK.md
- 支持矩阵：docs/SUPPORT_MATRIX.md
- 已知限制：docs/KNOWN_LIMITATIONS.md
- 安全报告：SECURITY.md
- 发布与撤回：docs/RELEASE_PROCESS.md

## 许可证

本仓库原创代码使用 MIT。官方组件不包含在本仓库中，继续受其原始许可证和条款约束；本仓库不对官方组件授予任何许可。
