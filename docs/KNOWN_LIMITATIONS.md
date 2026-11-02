# 已知限制

- 随附 `payload-lock.json` 仅覆盖官方 0.3.10 的 62 个文件；其他版本必须由用户自行生成并复核。清单来自本机官方安装与 `bundle.json` 的交叉校验，不是上游签名、背书或不可变 CDN 保证。
- Native Agent 不由本仓库安装或固定版本。官方安装脚本可能更新，版本漂移不受本项目控制。
- Codex 只支持手动 TOML 配置，不能自动写入。
- 卸载只移除 `current.json` 与 `previous.json` 引用的 payload。连续升级后更早的版本目录会保留，需要手动清理。
- 宿主配置写入只覆盖 `mcpServers` 下的 `kimi-cu` 节点；不会改动其他服务。
- 并发修改检测是大小与 mtime 的最佳努力，不构成完整的 compare-and-swap。
- 原子替换会创建新文件，原文件上的显式 ACL 不会保留。
- 备份是完整配置副本，可能包含其他 MCP 服务的密钥。
- Antigravity、WorkBuddy 已在本机确认路径；Claude Desktop 未安装，尚未真机验证。
- 不支持 ARM64、Server Core、锁屏或非交互式会话。
- 公开快照不包含 `npm run smoke` 所需的仓库内 runtime；真实桌面冒烟测试需在私有开发环境执行。
