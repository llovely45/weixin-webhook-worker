# 微信 Worker 多账号后台设计

日期：2026-09-27

## 目标

将已部署的 `weixin-webhook-notify` Worker 扩展为一个可管理多个微信连接的服务。管理员可以登录后台，通过微信扫码连接账号；连接凭证和提醒正文加密后存入 Cloudflare D1；外部系统通过 Webhook 发送即时通知或创建定时提醒。发送链路直接调用腾讯微信插件当前使用的 iLink HTTP 接口，不依赖常驻 OpenClaw Gateway。

## 方案比较

1. **一个 Worker + D1（当前方案）**：账号密文、轮询游标和上下文令牌放 D1；临时扫码状态用短期签名票据传递；管理员 UI 和通知 API 同 Worker。账号数量较少、状态会周期性更新，D1 的索引查询和一致性更适合该读写模式。
2. **Worker + Durable Objects + D1**：只有未来需要单账号串行处理或 WebSocket 常驻会话时才需要增加 Durable Objects；当前轮询频率和账号规模不需要额外状态服务。
3. **Worker 转发 OpenClaw Gateway**：Worker 只接收 Webhook，微信账号和消息仍由 Gateway 处理。它复用现有插件，但不是 Worker 直接向微信发送，也需要 Gateway 长期运行，因此不符合本次目标。

## 架构与认证

- 保留一个 Cloudflare Worker，提供 `/admin`、`/api/*` 和 `/notify`。
- 后台首次使用时允许设置至少 8 个字符、同时包含英文字母、数字和标点或符号的管理员密码；D1 只保存带随机盐的 HMAC 验证摘要。成功写入后初始化入口关闭。登录后发放带 HMAC 签名的 HttpOnly、Secure、SameSite=Strict Cookie；后台写操作校验 Origin。
- 使用独立 `DATA_ENCRYPTION_KEY` Worker Secret，通过 AES-GCM 加密整个账号记录后写入 D1。D1 主键沿用账号 ID 的 SHA-256 摘要，避免账号 ID 出现在存储键中。
- 账号记录保存必要字段：iLink bot token、API base URL、bot ID、扫码用户 ID、后台配置的默认收件人、加密存储的 `get_updates_buf` 与收件人 `context_token`、每账号 Webhook 密钥的 SHA-256 摘要及创建时间。Webhook 密钥只在生成或轮换时向管理员显示一次。
- 管理员和每个账号的 Webhook 密钥分开。外部调用方只能使用单个账号的密钥，不能查看账号列表或凭证。

## 扫码登录

1. 管理员在后台点击“连接微信”。Worker 调用 `POST /ilink/bot/get_bot_qrcode?bot_type=3`，并将已有账号中最多 10 个 bot token 按插件当前流程作为 `local_token_list` 提供；token 不进入浏览器票据。
2. Worker 将微信返回的 `qrcode_img_content` 在 Worker 内转换为 QR SVG，页面展示二维码；不把扫码内容发给第三方二维码服务。
3. Worker 返回绑定当前管理员会话的短期 HMAC 签名票据，含二维码值和当前 API base URL，5 分钟过期。浏览器顺序轮询状态，不并行堆积请求；Worker 按插件状态处理等待、已扫码、验证码、过期、`redirect_host` 和已绑定情况。
4. 微信确认登录后，Worker 从响应中取得 `bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id`，为账号生成独立 Webhook 密钥，将账号记录 AES-GCM 加密写入 D1，并在成功响应中仅显示一次 Webhook 密钥。
5. 二维码过期后，管理员重新发起连接。删除账号时，从 D1 删除加密记录。

## 后台页面与 API

- `GET /admin`：登录页和账号管理页面。
- `POST /api/admin/login`、`POST /api/admin/logout`：管理员会话管理。
- `GET /api/accounts`：列出账号 ID、展示名和默认收件人，不返回 token。
- `GET /api/admin/status`、`POST /api/admin/setup`：查询是否完成初始化并设置管理员密码；使用 D1 原子插入防止重复初始化，成功后拒绝再次设置。
- `POST /api/admin/login`：与 D1 中保存的密码验证摘要比对，成功后发放管理员会话。
- `POST /api/login/start`、`POST /api/login/poll`：生成二维码和推进扫码状态；支持验证码，轮询票据绑定当前管理员会话并在 5 分钟后过期。
- `PATCH /api/accounts/:id`：修改展示名、默认收件人或轮换 Webhook 密钥。
- `POST /api/accounts/:id/test-message`：管理员会话鉴权并校验同源后，向账号默认收件人发送固定测试文本。
- `DELETE /api/accounts/:id`：删除连接。
- `GET /api/reminders`、`POST /api/reminders`：后台查询或创建提醒。
- `PATCH /api/reminders/:id`、`DELETE /api/reminders/:id`：后台编辑或删除提醒，包括更换绑定账号；请求要求管理员会话并校验同源。
- `POST /notify`：以每账号密钥鉴权，接收 `{ "accountId": "...", "text": "..." }` 即时发送；带 `reminder: { "at": "YYYY-MM-DDTHH:mm", "frequency": "once|daily|monthly|yearly", "timezone": "Asia/Shanghai" }` 则创建提醒并返回 `202`。Webhook 调用方不能传入任意收件人、提醒正文或任务绑定账号。
- 每 5 分钟 Cron 调用 iLink `getupdates`，保存游标和默认收件人的上下文令牌，并领取到期提醒发送；不转发或处理入站消息内容。

提醒保存在 `reminder_tasks` 表中；提醒正文使用 AES-GCM 加密，排期元数据用于 D1 到期索引。一次性提醒发送成功后删除，重复提醒成功后推进到下一次未来周期；发送失败时清除租约并保留错误码，等待后续 Cron 重试。月度及年度日期按月底夹取，例如月末 31 日在短月按最后一天提醒，非闰年的 2 月 29 日按 2 月 28 日提醒。重复任务错过多个周期时只发送一次，不逐次补发。

## iLink 发送行为

Worker 保持当前已部署实现的文字消息协议：`POST /ilink/bot/sendmessage`，使用扫码登录取得的 bearer bot token、账号返回的 base URL、版本编码请求头、`X-WECHAT-UIN`，以及 `message_type=2`、`message_state=2`、文本 `item_list`。账号默认收件人初始设为扫码用户 ID；管理员可在后台改为实际会话中的目标用户 ID。

发送消息时附带加密保存的 `context_token`。新连接或更换默认收件人后，需由该收件人先给微信 OpenClaw 账号发一条消息，等待 Cron 获取上下文后才能发送通知。当前只处理连接游标和上下文，不提供 OpenClaw 对话回复。

## D1 一致性与轮询频率

账号记录、游标和上下文令牌保存在 D1 中，通过摘要主键进行账号查找；凭证字段仍以 AES-GCM 密文保存。单区域主库可提供直接的读写路径，避免 KV `list` 配额耗尽和边缘缓存传播延迟。每 5 分钟轮询可降低空闲时的上游调用与状态写入，但新收件人发消息后上下文捕获最长延迟约 5 分钟。

## 部署与运维

- Wrangler 绑定 `WEIXIN_ACCOUNTS` D1 数据库；账号、管理员和提醒表通过 `migrations/` 下的顺序迁移创建。旧 KV 已在导入、比对和新版本部署验证后删除；本地保留一份仅含 AES-GCM 密文的备份。
- 通过 Wrangler Secret 设置 `DATA_ENCRYPTION_KEY`；不得写入仓库或 Worker 静态变量。
- Worker URL 继续使用 `workers.dev`；`/notify` 只接受 POST、JSON 和每账号 Bearer 密钥；不开放 CORS，不在错误响应或日志中返回 bot token、扫码值或完整上游响应。后台 UI 的脚本、样式和二维码生成不依赖第三方服务。
- 纯文字通知外的图片、语音、文件、视频和入站消息处理不在此版本范围内。

## 风险与限制

- iLink 协议说明基于插件客户端代码，不等于完整、稳定的外部服务端契约；上游接口变化时需要更新 Worker。
- Cron 每 5 分钟长轮询，在线状态由微信服务端判定；需观察上下文捕获延迟和不同 Cloudflare 账号计划下的 Cron 行为。
- 单账号 Webhook 密钥只在创建/轮换时展示；丢失后需由后台轮换。
- 后台首次初始化页面公开，任何先访问并提交的人都能创建管理员密码；部署后应立即由管理员设置。重新部署 Worker 不会清空 D1；重置管理员密码时只删除 `admin_credentials` 中的行，不删除 `accounts` 表。
