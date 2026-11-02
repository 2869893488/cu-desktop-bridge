# Antigravity 接入指南

推荐使用安装器把官方 payload 放到 `%LOCALAPPDATA%\KimiCU-Community`，再执行：

```powershell
node scripts/apply-host-config.mjs --host antigravity `
  --config-path "$env:USERPROFILE\.gemini\config\mcp_config.json" `
  --install-root "$env:LOCALAPPDATA\KimiCU-Community"
```

配置文件通常位于 `%USERPROFILE%\.gemini\config\mcp_config.json`；版本不同时先从 MCP 设置中确认路径。脚本只合并 `mcpServers` 下的 `kimi-cu` 节点，写入前备份，失败时不覆盖原文件。开发时也可以用 `node scripts/render-host-config.mjs --host antigravity --repo-root <仓库>` 生成 JSON 后手动合并。

接入后应看到 `js`、`js_reset`、`js_add_node_module_dir` 三个工具。

## 注意事项

- Antigravity 启动子进程时可能不继承完整 PATH，配置生成器会在 `env.PATH` 中写入 Node 目录与必要的 Windows 系统目录。
- 启动前可运行 `powershell.exe -NoProfile -File scripts/setup.ps1 -Doctor` 自检。
