# Security Policy

## 报告渠道

请勿通过公开 issue 报告漏洞。请使用 GitHub 仓库的私密漏洞报告渠道（Private Vulnerability Reporting） 提交私下报告。

报告中请包含：受影响版本、Windows 版本、payload 版本与指纹、复现步骤、影响范围。不要附带凭证、密钥或个人隐私数据。

## 支持范围

预览期内只支持最新发布版本。

本仓库负责的范围：

- 安装器、宿主配置写入、MCP 客户端与测试

不负责的范围：

- 官方 KimiCU runtime、native agent、官方插件；这些问题请报告给上游

## 响应预期

这是社区项目，不提供漏洞赏金。我们力争 7 天内确认收到，30 天内给出处理状态。

## 已知限制

桌面控制可以读取屏幕并接管键鼠。请只在受控环境使用，并阅读 docs/KNOWN_LIMITATIONS.md。
