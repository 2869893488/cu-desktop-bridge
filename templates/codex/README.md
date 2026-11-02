# OpenAI Codex / CLI 接入指南

Codex 使用 TOML 配置 `%USERPROFILE%\.codex\config.toml`，不是 JSON。

1. 运行 `powershell.exe -NoProfile -File scripts/setup.ps1 -Doctor`，取得输出中的 `path`（payload 根目录）。
2. 在 `config.toml` 中添加：

   ```toml
   [mcp_servers.kimi-cu]
   type = "stdio"
   command = 'C:/<path>/runtime/node-repl.exe'
   args = []
   startup_timeout_sec = 120
   ```

   表名是 `mcp_servers`（下划线）。现有 Codex 条目未使用 `cwd`，确认目标版本支持前不要添加。
3. 重启 Codex，确认 `js` 工具已加载。

`apply-host-config.mjs` 会拒绝写入 Codex 配置，以免破坏已有 TOML 表。本目录的 `codex_mcp.json` 只用于展示字段结构，不能直接粘贴进 TOML。
