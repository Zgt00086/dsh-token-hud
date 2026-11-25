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
- 输出速度 / 总 tokens / 缓存命中（一行一项，含实测时刻）
- 上下文占用
- MIKU 账户：今日/累计消耗、今日/累计 Token、今日输入/输出/缓存命中、累计请求
- 本站模型列表（实时拉 `/api/models`，不预设）+ 倍率与单价
- 明细：未缓存输入/缓存读取/缓存写入/输出、高峰/空闲 tokens、计费请求、缓存节省

## 口径

- 官方与中转分开计价：provider 含 `mikumc`/`miku` → 中转；含 `deepseek` → 官方；其余按模型是否在本站列表判断
- 中转价取 `/api/models` 实时倍率；旧站已下架模型**不虚构价格**，单独标「未计价」
- 峰谷时段读 `/api/site-config` 的 `peakWindow`（默认北京时间工作日 09–12、14–18）
- 输出速度 = 官方 `outputTokens` ÷ **真实耗时**（`step/start` → 消息落盘，含首字延迟 TTFT）；重试从重试点重新计时，超过 90 秒的排队样本丢弃
- 不用 `dt[]` 跨度：那只覆盖首字之后的流式段，漏掉 2–8 秒的 TTFT，小消息会算出 400–580 tok/s 的假速度（637 条真实回答回放：dt 法中位 101.6，真实耗时法中位 22.2、大输出 47）

## 已知问题（不在插件范围内）

状态条由 App 在多个插件之间**轮流显示**（App 说明书写明「多个插件轮流显示」）。同时注册状态条的插件有 `local-shizuku-bridge`、`local-root-bridge` 和本插件，切换时两条底色不同的胶囊交叉淡入淡出，看起来会闪一下半黑灰。

插件只能控制自己的文字/图标/语气/推送频率（已做到内容不变不推，实测 6.5 秒 1 次），无法消除切换动画。要完全不闪，只能在 App 的插件详情里关掉另外两个插件的「状态条」位置，只留一条。

## 开发

```sh
npm test                                                        # 速度口径回归
node ~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs . --load --app 1.2.0
```

`lib/` 改动后在 App「引擎」页重启引擎生效。
