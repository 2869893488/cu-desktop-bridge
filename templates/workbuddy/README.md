# WorkBuddy 接入指南

配置文件位于 `%USERPROFILE%\.workbuddy\mcp.json`。执行：

```powershell
node scripts/apply-host-config.mjs --host workbuddy `
  --config-path "$env:USERPROFILE\.workbuddy\mcp.json" `
  --install-root "$env:LOCALAPPDATA\KimiCU-Community"
```

然后在 WorkBuddy 中点击“重新载入 MCP 插件”，确认出现 `js` 工具。

卸载时追加 `--remove`，脚本只删除 `kimi-cu` 节点，不影响其他 MCP 服务。

## 常见排障

- `KimiCU native runtime is not installed` 表示尚未安装官方守护进程。
