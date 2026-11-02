# Claude Desktop 接入指南

配置文件位于 `%APPDATA%\Claude\claude_desktop_config.json`。执行：

```powershell
node scripts/apply-host-config.mjs --host claude-desktop `
  --config-path "$env:APPDATA\Claude\claude_desktop_config.json" `
  --install-root "$env:LOCALAPPDATA\KimiCU-Community"
```

若 `%APPDATA%\Claude` 不存在（未安装，或 MSIX 版配置位于 `LocalCache\Roaming\Claude` 下），脚本会拒绝写入而不是创建目录；请先从宿主设置确认实际路径。

然后彻底退出并重新启动 Claude Desktop。右下角小锤子图标中应包含 `js`、`js_reset`、`js_add_node_module_dir`。

卸载时追加 `--remove`，只移除本项目节点。

## 技巧提示

- 可将已安装官方 payload 中 `skills/kimi-cu/SKILL.md` 的内容加入 Claude Project 的 Project Instructions，获得更稳定的调用模式。
