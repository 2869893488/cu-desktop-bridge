# 发布与撤回流程

## 发布前

1. 来源矩阵没有“待确认”，公开白名单经负责人签字
2. 项目名称、插件 ID、仓库 URL、作者、许可证与安全联系人已确定
3. 公开快照不包含官方 EXE、ZIP、源码、衍生 launcher、日志、本机路径或凭证
4. `payload-lock.json` 与 Native Agent 策略已明确
5. 默认 CI 在 GitHub 托管 runner 通过，且不调用真实桌面测试
6. 干净 VM 完成从零安装、MCP 握手、重复安装、升级、回滚、卸载和至少一个宿主的真实接入
7. 匿名克隆者能按 README 原样操作

## 生成候选

```powershell
node scripts/release/build-snapshot.mjs `
  --out "C:\release\cu-desktop-bridge" `
  --identity "release/identity.json" `
  --git --commit
```

清单与哈希写在快照目录外的 `<out>.manifest.json`。

## 发布

1. 在私有仓库先推送候选，等待托管 CI 通过
2. 由外部人员在干净 VM 按 README 复核
3. 生成 release 校验和，使用签名 tag
4. 发布说明列出固定 payload 版本、支持范围、已知限制、升级与回滚方式
5. 不上传官方 ZIP、EXE 或未经授权文件到 release、Actions artifact 或缓存
6. 先向小范围测试者开放，再公开仓库地址

## 撤回

1. 下架 release 与相关制品
2. 保留安全说明与迁移指引
3. 通知已知用户，说明影响范围和替代版本
4. 必要时撤销 tag，并在仓库首页更新状态
5. 记录事件、原因和后续动作

安全联系人：GitHub 仓库的私密漏洞报告渠道（Private Vulnerability Reporting）
