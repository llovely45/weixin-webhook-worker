# 微信 Webhook 通知 Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/llovely45/weixin-webhook-worker)

把 HTTP Webhook 通知转发到微信的 Cloudflare Worker。支持多个微信账号、扫码连接和管理后台；微信账号凭证以 AES-GCM 加密后保存到 Cloudflare D1。服务不需要常驻 OpenClaw Gateway。

## 功能

- 在管理后台扫码连接多个微信账号，并分别管理 Webhook 密钥和默认收件人。
- 每个账号卡片提供“一键发送测试消息”，向该账号的默认收件人发送 `你好！这里是Cloudflare事务宣传部！`。
- 外部服务调用 `POST /notify`，Worker 直接通过 iLink 协议向微信发送纯文本；也可在请求中创建一次性或重复提醒。
- 管理后台的“待办事项”分栏可新增、编辑、删除提醒并更换提醒账号。
- D1 保存加密后的账号凭证和提醒正文，以及 Webhook 密钥摘要和管理员凭据；源码中不保存密码或加密密钥。
- Cron 默认每 5 分钟轮询一次 iLink，维护连接、更新收件人的会话上下文并发送到期提醒。微信消息内容不会转发或处理；这不是完整的 OpenClaw 对话机器人。

## 部署到 Cloudflare

需要一个 Cloudflare 账号和一个 GitHub 账号。点击 README 顶部的 **Deploy to Cloudflare** 按钮，登录并授权后，Cloudflare 会将项目复制到你的 GitHub 账号，自动创建和绑定 D1 数据库，并构建部署 Worker。按页面提示生成并设置 `DATA_ENCRYPTION_KEY`；也可以用 `openssl rand -base64 32` 生成随机密钥。请把密钥保存在安全的密码管理器中。

部署完成后，打开 Cloudflare 给出的 Worker 地址并访问 `/admin`，立即设置管理员密码。密码至少 8 个字符，并且包含英文字母、数字和标点或符号。初始化页面没有额外初始化码；设置完成前，访问后台的任何人都可以先完成初始化。

按钮部署会运行 D1 迁移并部署 Worker。若想手动部署，或 Cloudflare 页面没有提示设置密钥，可按下面步骤操作。

### 手动部署：克隆并登录 Cloudflare

需要 Node.js 22 或更新版本。

```sh
git clone https://github.com/llovely45/weixin-webhook-worker.git
cd weixin-webhook-worker
npm install
npx wrangler login
```

### 手动部署：创建 D1 数据库并填写绑定

```sh
npx wrangler d1 create weixin-accounts-db
```

命令会创建数据库并返回数据库 ID。打开 `wrangler.toml`，将 `[[d1_databases]]` 中的 `database_name` 和 `database_id` 改为命令输出的值。`binding` 保持为 `WEIXIN_ACCOUNTS`。

### 手动部署：创建数据库表

```sh
npx wrangler d1 migrations apply weixin-accounts-db --remote
```

该命令会应用 `migrations/` 中尚未执行的迁移，创建账号、管理员凭据和定时提醒表。

### 手动部署：设置账号加密密钥

生成一条随机密钥：

```sh
openssl rand -base64 32
```

复制输出，然后运行下面的命令，并在提示时粘贴密钥：

```sh
npx wrangler secret put DATA_ENCRYPTION_KEY
```

请将密钥保存在密码管理器或其他安全位置。账号数据依赖此密钥解密；丢失或更换密钥会导致已保存的微信账号凭证无法解密。不要将密钥写入源码、`wrangler.toml`、公开仓库或普通环境变量。

### 手动部署：部署 Worker

```sh
npx wrangler deploy
```

Wrangler 会输出 Worker URL。打开 `https://<你的 Worker 域名>/admin` 并立即设置管理员密码。

### 6. 连接微信账号

1. 在后台登录并点击“连接微信”，使用微信扫描二维码；如果页面要求验证码，在页面中输入。
2. 连接成功后，立即保存页面显示的账号 ID 和 Webhook 密钥。密钥只显示一次，遗失后需要在后台轮换。
3. 让该微信账号的目标收件人先给机器人发一条消息，然后在后台确认“默认收件人 ID”。
4. Worker 默认每 5 分钟轮询一次；首次获取会话上下文可能需要等待下一次轮询。若 Webhook 返回 `weixin_context_missing`，先确认目标收件人发过消息，再等待并重试。

## 发送通知

把 URL、账号 ID 和密钥替换成部署后台中的值：

```sh
curl -X POST 'https://<你的 Worker 域名>/notify' \
  -H 'Authorization: Bearer <ACCOUNT_WEBHOOK_SECRET>' \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"<ACCOUNT_ID>","text":"这是一条微信通知"}'
```

成功时返回：

```json
{"ok":true,"messageId":"..."}
```

每个账号使用自己的 Webhook 密钥。接口只会向后台为该账号设置的默认收件人发送纯文本，不接受调用方覆盖收件人；单条消息最多 4000 个字符。轮换密钥后，旧密钥立即失效；删除账号也会撤销对应密钥。

### 创建定时提醒

在请求中加入 `reminder` 对象时，Worker 会创建待办任务并在到期后的最近一次 Cron 扫描中发送。当前 Cron 间隔是 5 分钟，因此正常情况下会在设定时间后的 5 分钟内发送。此时接口返回 `202 Accepted`；不带 `reminder` 的请求仍会立即发送并返回 `200 OK`。

```sh
curl -X POST 'https://<你的 Worker 域名>/notify' \
  -H 'Authorization: Bearer <ACCOUNT_WEBHOOK_SECRET>' \
  -H 'Content-Type: application/json' \
  -d '{
    "accountId":"<ACCOUNT_ID>",
    "text":"每日上午提醒我检查工单",
    "reminder":{
      "at":"2026-10-02T09:30",
      "frequency":"daily",
      "timezone":"Asia/Shanghai"
    }
  }'
```

`reminder.at` 必填，格式为 `YYYY-MM-DDTHH:mm`，并按 `timezone` 解释为当地时间。字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `at` | 是 | 首次提醒时间，例如 `2026-10-02T09:30`。 |
| `frequency` | 否 | `once`、`daily`、`monthly` 或 `yearly`，默认 `once`。 |
| `timezone` | 否 | IANA 时区，例如 `Asia/Shanghai`；默认 `Asia/Shanghai`。 |

Webhook 凭据中的账号就是任务绑定的微信账号，调用方不能在 `reminder` 中更换账号或正文。创建成功返回示例：

```json
{
  "ok": true,
  "status": "scheduled",
  "reminderId": "<REMINDER_ID>",
  "nextRunAt": "2026-10-02T01:30:00.000Z",
  "frequency": "daily",
  "timezone": "Asia/Shanghai"
}
```

一次性提醒发送成功后会从 D1 删除；重复提醒成功后会推进到下次时间。发送失败会保留任务并在后续 Cron 重试，错误状态也会显示在后台。月度提醒遇到不存在的日期（如每月 31 日）时使用当月最后一天；年度提醒在非闰年遇到 2 月 29 日时使用 2 月最后一天。若 Cron 错过多个周期，重复提醒只补发一次，然后推进到下一个未来周期。

后台“待办事项”可编辑提醒时间、频率、时区、正文和绑定账号，也可删除任务。删除微信账号时，该账号下的提醒会一并删除。

## 管理员密码重置

如果忘记管理员密码，可以删除 D1 中的管理员凭据行，然后重新打开后台设置密码。此操作会保留已连接的微信账号：

```sh
npx wrangler d1 execute weixin-accounts-db --remote --command="DELETE FROM admin_credentials WHERE id = 1"
```

## 存储与安全

- D1 中的账号记录整体使用 `DATA_ENCRYPTION_KEY` 派生的 AES-GCM 密钥加密；管理员密码只保存带随机盐的 HMAC 验证摘要。
- 管理后台登录 Cookie 使用 HttpOnly、Secure、SameSite=Strict 属性，有效期为 8 小时；后台写操作校验请求来源。
- Webhook 密钥仅在创建或轮换时显示。请勿将账号 ID 与密钥一起提交到公开仓库、日志或截图中。
- Worker 按腾讯 `openclaw-weixin` 插件当前公开代码实现二维码登录和 `sendmessage` 协议。这是客户端实现，不是独立稳定的服务端 API 契约；上游协议变化时可能需要同步调整。
- 当前仅支持纯文本出站通知，不支持图片或文件发送。

## 配置

- `wrangler.toml`：Worker 名称、D1 绑定、静态后台资源和 Cron 频率。可调整 Cron 表达式以降低轮询频率；频率降低后，首次捕获会话上下文以及重连等待时间也会相应变长。Cloudflare Cron 修改在部署后生效。
- `DATA_ENCRYPTION_KEY`：必须通过 `wrangler secret put` 设置的 Worker Secret。
- `WEIXIN_CHANNEL_VERSION` 和 `WEIXIN_APP_ID`：已在 `wrangler.toml` 中提供默认值，通常无需修改。

## 本地开发

```sh
npm install
npx wrangler dev
```

本地开发需要先创建 `.dev.vars`，内容格式如下。请使用本地测试专用的随机值，不要提交此文件：

```dotenv
DATA_ENCRYPTION_KEY=replace-with-a-random-local-secret
```

Cloudflare D1 的本地开发和远程部署使用不同数据库；要测试完整扫码流程，请配置并使用远程 D1。

## 参考

- [Cloudflare D1 Wrangler 命令](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cloudflare D1 数据库迁移](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [腾讯 openclaw-weixin 二维码登录流程](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts)
- [腾讯 openclaw-weixin 消息发送流程](https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/send.ts)
