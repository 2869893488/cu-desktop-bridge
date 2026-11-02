# 支持矩阵

本表只记录已实际验证或明确不支持的范围。未验证的宿主不会被标记为支持。

| 项目 | 状态 | 说明 |
|---|---|---|
| Windows 10/11 x64 | 实验性 | 当前开发机通过；干净 VM 待验证 |
| Windows ARM64 | 不支持 | 未验证 |
| Windows Server Core | 不支持 | 未验证 |
| 锁屏或非交互式会话 | 不支持 | 安装前检测并拒绝 |
| Node.js 24.15.0+ x64 | 支持 | 安装前检查版本与架构 |
| PowerShell 5.1 | 支持 | 测试通过 |
| PowerShell 7 | 支持 | 手动验证 |
| Antigravity | 实验性 | JSON 合并；配置路径已在本机确认，干净用户待验证 |
| WorkBuddy | 实验性 | JSON 合并；配置路径已在本机确认 |
| Claude Desktop | 未验证 | 未安装；配置路径与字段需真机确认 |
| OpenAI Codex | 手动 | 使用 TOML，不由本仓库自动写入 |
| Kimi Code 原生插件 | 不支持 | 不写入官方 managed 插件目录 |

未列入表中的宿主或版本不视为支持。
