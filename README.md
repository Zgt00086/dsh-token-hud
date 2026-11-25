# 用量与费用（本地插件 local-token-hud）

dsh-go 手机原生插件：本会话费用 / tokens / 输出速度 + MIKU 中转余额与官方 DeepSeek 分开记账。

**装在本地目录并用 link 方式安装，pnpm 重装依赖不会覆盖代码。**

- 目录：`~/.dsh/dsh-go/plugins/local-token-hud/`
- 安装：`dsh plugin --profile web add ~/.dsh/dsh-go/plugins/local-token-hud`
- 主站 `http://mikumc.com:8888`，备用 `http://47.100.106.67:8888`，主站不通自动切

## 登录（一次）

对话详情 / 侧边栏 → **插件** → **用量与费用** → 展开「登录 / 切换账号」→ 填用户名密码 → 登录。
**密码只用于这次登录请求，不保存**；存下的是 session token（AES-256-GCM，`~/.dsh/dsh-go/private/token-hud/miku-token.bin`，0600）。

## 面板内容

- **官方 DeepSeek**：余额 / 本轮消耗 / 本会话消耗（按官方价）
- **MIKU 中转**：余额 / 本轮消耗 / 本会话消耗（按本站实价）
- 总 tokens · 缓存命中、输出速度（含实测时刻）
- 上下文占用
- MIKU 账户：今日/累计消耗、今日/累计 Token、今日输入/输出/缓存命中、累计请求
- 本站模型列表（实时拉 `/api/models`，不预设）+ 倍率与单价
- 明细：未缓存输入/缓存读取/缓存写入/输出、高峰/空闲 tokens、计费请求、缓存节省

## 口径

- 官方与中转分开计价：provider 含 `mikumc`/`miku` → 中转；含 `deepseek` → 官方；其余按模型是否在本站列表判断
- 中转价取 `/api/models` 实时倍率；旧站已下架模型**不虚构价格**，单独标「未计价」
- 峰谷时段读 `/api/site-config` 的 `peakWindow`（默认北京时间工作日 09–12、14–18）
- 输出速度 = 官方 `outputTokens` ÷ 该步实际流式时长（含思考与工具调用块）

## 开发

```sh
node ~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs . --load --app 1.2.0
```

`lib/` 改动后在 App「引擎」页重启引擎生效。
