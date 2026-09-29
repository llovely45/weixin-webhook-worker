const $ = (selector) => document.querySelector(selector);
const loginPanel = $("#loginPanel");
const setupPanel = $("#setupPanel");
const dashboardPanel = $("#dashboardPanel");
const loginMessage = $("#loginMessage");
const loginForm = $("#loginForm");
const passwordInput = $("#passwordInput");
const setupForm = $("#setupForm");
const setupPasswordInput = $("#setupPasswordInput");
const setupConfirmInput = $("#setupConfirmInput");
const setupMessage = $("#setupMessage");
const accountList = $("#accountList");
const emptyState = $("#emptyState");
const accountsView = $("#accountsView");
const remindersView = $("#remindersView");
const dashboardTitle = $("#dashboardTitle");
const dashboardDescription = $("#dashboardDescription");
const accountsTab = $("#accountsTab");
const remindersTab = $("#remindersTab");
const reminderList = $("#reminderList");
const reminderEmptyState = $("#reminderEmptyState");
const reminderForm = $("#reminderForm");
const reminderFormTitle = $("#reminderFormTitle");
const reminderFormMessage = $("#reminderFormMessage");
const reminderAccountInput = $("#reminderAccountInput");
const reminderTextInput = $("#reminderTextInput");
const reminderAtInput = $("#reminderAtInput");
const reminderFrequencyInput = $("#reminderFrequencyInput");
const reminderTimezoneInput = $("#reminderTimezoneInput");
const saveReminderButton = $("#saveReminderButton");
const addReminderButton = $("#addReminderButton");
const cancelReminderButton = $("#cancelReminderButton");
const notice = $("#notice");
const logoutButton = $("#logoutButton");
const qrDialog = $("#qrDialog");
const qrImage = $("#qrImage");
const qrStatus = $("#qrStatus");
const qrCountdown = $("#qrCountdown");
const verifyForm = $("#verifyForm");
const verifyCodeInput = $("#verifyCodeInput");
const retryQrButton = $("#retryQrButton");
const secretDialog = $("#secretDialog");
const secretAccountId = $("#secretAccountId");
const secretValue = $("#secretValue");
const secretMessage = $("#secretMessage");

let activeTicket = "";
let qrExpiresAt = 0;
let qrPollTimer = 0;
let qrCountdownTimer = 0;
let currentPollController = null;
let pollBusy = false;
let qrImageUrl = "";
let pendingVerifyCode = "";
let connectedAccounts = [];
let editingReminder = null;

const ERROR_TEXT = {
  invalid_credentials: "密码不正确。",
  admin_already_initialized: "管理员密码已经设置，请刷新页面后登录。",
  admin_setup_required: "请先完成后台初始化。",
  invalid_admin_password: "密码需至少 8 个字符，并包含英文字母、数字和标点或符号。",
  admin_login_required: "登录已过期，请重新登录。",
  data_encryption_key_not_configured: "后台尚未配置数据加密密钥。",
  account_store_unavailable: "账号存储暂不可用，请检查 D1 数据库绑定。",
  account_record_unreadable: "账号数据无法解密，请确认 DATA_ENCRYPTION_KEY 未变更。",
  invalid_or_expired_qr_ticket: "二维码会话已过期，请重新生成。",
  weixin_qr_start_failed: "暂时无法向微信申请二维码，请稍后重试。",
  weixin_qr_upstream_http_error: "微信接口返回 HTTP 状态码 {status}，请稍后重试。",
  weixin_qr_poll_failed: "查询微信扫码状态失败，请稍后重试。",
  weixin_upstream_unreachable: "暂时无法连接微信服务。",
  weixin_upstream_timeout: "连接微信服务超时，请稍后重试。",
  invalid_weixin_response: "微信服务返回了无法识别的响应。",
  weixin_send_failed: "微信没有接受这条消息。",
  account_send_not_configured: "账号缺少发送所需配置，请重新连接微信账号。",
  weixin_context_missing: "还没有该收件人的微信会话上下文。请先在微信里给 OpenClaw 发一条消息，等待同步后再发送通知。",
  account_not_found: "绑定的微信账号不存在，请选择一个已连接账号。",
  invalid_reminder_schedule: "提醒参数不完整或包含不支持的字段。",
  invalid_reminder_time: "提醒时间无效，请选择有效的日期和时间。",
  invalid_reminder_frequency: "提醒频率无效。",
  invalid_reminder_timezone: "时区无效，请填写 IANA 时区，例如 Asia/Shanghai。",
  invalid_reminder_account: "请选择一个已连接的微信账号。",
  unsupported_reminder_field: "提醒中包含不支持的字段。",
  empty_reminder_update: "没有可保存的提醒变更。",
  text_required: "请填写提醒内容。",
  text_too_long: "提醒内容不能超过 4000 个字符。",
  reminder_in_progress: "该提醒正在投递，请稍后再修改或删除。",
  reminder_not_found: "提醒任务不存在或已完成。",
  same_origin_required: "请求来源校验失败，请刷新后台后重试。",
  network_error: "网络请求失败，请检查连接后重试。",
  internal_error: "服务暂时不可用，请稍后重试。",
};

class RequestError extends Error {
  constructor(code, status, upstreamStatus) {
    super(code);
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
      redirect: "error",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new RequestError("network_error", 0);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new RequestError("internal_error", response.status);
  }
  if (!response.ok || result.ok === false) {
    throw new RequestError(result.error || "internal_error", response.status, result.upstreamStatus);
  }
  return result;
}

function errorText(error) {
  if (error?.code === "weixin_qr_upstream_http_error") {
    return ERROR_TEXT.weixin_qr_upstream_http_error.replace("{status}", String(error.upstreamStatus || "未知"));
  }
  return ERROR_TEXT[error?.code || error?.message] || "操作失败，请稍后重试。";
}

function showLogin(message = "") {
  stopQrSession();
  connectedAccounts = [];
  editingReminder = null;
  accountList.replaceChildren();
  reminderList.replaceChildren();
  reminderForm.hidden = true;
  reminderForm.reset();
  populateReminderAccounts("");
  setupPanel.hidden = true;
  dashboardPanel.hidden = true;
  loginPanel.hidden = false;
  logoutButton.hidden = true;
  loginMessage.textContent = message;
  passwordInput.value = "";
}

function showSetup(message = "") {
  stopQrSession();
  loginPanel.hidden = true;
  dashboardPanel.hidden = true;
  setupPanel.hidden = false;
  logoutButton.hidden = true;
  setupMessage.textContent = message;
  setupPasswordInput.value = "";
  setupConfirmInput.value = "";
}

function showDashboard() {
  setupPanel.hidden = true;
  loginPanel.hidden = true;
  dashboardPanel.hidden = false;
  logoutButton.hidden = false;
  setDashboardView("accounts");
}

function formatReminderTime(timestamp, timezone) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function reminderFrequencyLabel(frequency) {
  return ({ once: "一次性", daily: "每天", monthly: "每月", yearly: "每年" })[frequency] || frequency;
}

function setReminderFormMessage(message = "") {
  reminderFormMessage.textContent = message;
}

function handleReminderError(error, inForm = false) {
  if (error?.code === "admin_login_required") {
    showLogin(errorText(error));
    return;
  }
  const message = errorText(error);
  if (inForm) setReminderFormMessage(message);
  else showNotice(message, true);
}

function populateReminderAccounts(selectedId = reminderAccountInput.value) {
  const options = [document.createElement("option")];
  options[0].value = "";
  options[0].textContent = connectedAccounts.length ? "请选择微信账号" : "请先连接微信账号";
  options[0].disabled = true;
  options[0].selected = true;
  for (const account of connectedAccounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = `${account.displayName}（${account.id.slice(0, 8)}）`;
    options.push(option);
  }
  reminderAccountInput.replaceChildren(...options);
  if (connectedAccounts.some((account) => account.id === selectedId)) {
    reminderAccountInput.value = selectedId;
  }
  addReminderButton.disabled = connectedAccounts.length === 0;
}

function renderReminder(reminder) {
  const card = document.createElement("article");
  card.className = "reminder-card";

  const head = document.createElement("div");
  head.className = "reminder-head";
  const details = document.createElement("div");
  details.className = "reminder-details";
  const account = document.createElement("p");
  account.className = "reminder-account";
  account.textContent = reminder.accountName;
  const nextRun = document.createElement("p");
  nextRun.className = "reminder-next-run";
  nextRun.textContent = `下次发送：${formatReminderTime(reminder.nextRunAt, reminder.timezone)}（${reminder.timezone}）`;
  details.append(account, nextRun);

  const badge = document.createElement("span");
  badge.className = `reminder-badge${reminder.lastError ? " reminder-badge-error" : ""}`;
  badge.textContent = reminder.isSending ? "正在发送" : reminder.lastError ? "待重试" : reminderFrequencyLabel(reminder.frequency);
  head.append(details, badge);

  const text = document.createElement("p");
  text.className = "reminder-text";
  text.textContent = reminder.text;

  const meta = document.createElement("p");
  meta.className = "reminder-meta";
  meta.textContent = `计划：${reminder.at.replace("T", " ")} · ${reminderFrequencyLabel(reminder.frequency)}`;

  card.append(head, text, meta);
  if (reminder.lastError) {
    const error = document.createElement("p");
    error.className = "reminder-error";
    error.textContent = `上次发送失败：${ERROR_TEXT[reminder.lastError] || reminder.lastError}；下次 Cron 将重试。`;
    card.append(error);
  }

  const actions = document.createElement("div");
  actions.className = "reminder-actions";
  const editButton = makeButton("编辑", "button-secondary", () => openReminderForm(reminder));
  const deleteButton = makeButton("删除", "button-danger", async () => {
    if (!window.confirm(`确定删除这条提醒吗？\n\n${reminder.text}`)) return;
    deleteButton.disabled = true;
    try {
      await api(`/api/reminders/${encodeURIComponent(reminder.id)}`, { method: "DELETE" });
      showNotice("提醒已删除。");
      await refreshReminders();
    } catch (error) {
      handleReminderError(error);
      deleteButton.disabled = false;
    }
  });
  editButton.disabled = reminder.isSending;
  deleteButton.disabled = reminder.isSending;
  actions.append(editButton, deleteButton);
  card.append(actions);
  return card;
}

function openReminderForm(reminder = null) {
  if (!connectedAccounts.length) {
    showNotice("请先连接至少一个微信账号，再创建提醒。", true);
    return;
  }
  editingReminder = reminder;
  reminderFormTitle.textContent = reminder ? "编辑提醒" : "添加提醒";
  saveReminderButton.textContent = reminder ? "保存修改" : "保存提醒";
  reminderTextInput.value = reminder?.text || "";
  reminderAtInput.value = reminder?.at || "";
  reminderFrequencyInput.value = reminder?.frequency || "once";
  reminderTimezoneInput.value = reminder?.timezone || "Asia/Shanghai";
  populateReminderAccounts(reminder?.accountId || connectedAccounts[0].id);
  reminderForm.hidden = false;
  setReminderFormMessage("");
  reminderTextInput.focus();
}

function closeReminderForm() {
  reminderForm.hidden = true;
  reminderForm.reset();
  reminderFrequencyInput.value = "once";
  reminderTimezoneInput.value = "Asia/Shanghai";
  editingReminder = null;
  setReminderFormMessage("");
  populateReminderAccounts(connectedAccounts[0]?.id || "");
}

function setDashboardView(view) {
  const showAccounts = view === "accounts";
  accountsView.hidden = !showAccounts;
  remindersView.hidden = showAccounts;
  dashboardTitle.textContent = showAccounts ? "微信账号" : "待办事项";
  dashboardDescription.textContent = showAccounts
    ? "扫码连接账号，为每个账号配置收件人并生成独立 Webhook 密钥。"
    : "管理即将发送和重复发送的微信提醒。";
  $("#connectButton").hidden = !showAccounts;
  accountsTab.classList.toggle("active", showAccounts);
  remindersTab.classList.toggle("active", !showAccounts);
  if (showAccounts) {
    accountsTab.setAttribute("aria-current", "page");
    remindersTab.removeAttribute("aria-current");
  } else {
    remindersTab.setAttribute("aria-current", "page");
    accountsTab.removeAttribute("aria-current");
  }
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.hidden = false;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => { notice.hidden = true; }, 6000);
}

function makeButton(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function makeField(labelText, value, maxLength) {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const label = document.createElement("span");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.value = value || "";
  input.maxLength = maxLength;
  wrapper.append(label, input);
  return { wrapper, input };
}

function renderAccount(account) {
  const card = document.createElement("article");
  card.className = "account-card";

  const head = document.createElement("div");
  head.className = "account-head";
  const identity = document.createElement("div");
  const title = document.createElement("h2");
  title.className = "account-title";
  title.textContent = account.displayName;
  const id = document.createElement("code");
  id.className = "account-id";
  id.textContent = account.id;
  identity.append(title, id);
  const badge = document.createElement("span");
  badge.className = "account-badge";
  badge.textContent = "已连接";
  head.append(identity, badge);

  const fields = document.createElement("div");
  fields.className = "account-fields";
  const displayName = makeField("展示名称", account.displayName, 80);
  const recipient = makeField("默认收件人 ID", account.defaultRecipient, 512);
  fields.append(displayName.wrapper, recipient.wrapper);

  const actions = document.createElement("div");
  actions.className = "account-actions";
  const testMessageButton = makeButton("一键发送测试消息", "button-primary", async () => {
    testMessageButton.disabled = true;
    testMessageButton.textContent = "正在发送测试消息…";
    try {
      await api(`/api/accounts/${encodeURIComponent(account.id)}/test-message`, {
        method: "POST",
        body: {},
      });
      showNotice(`已向“${account.displayName}”发送测试消息：你好！这里是Cloudflare事务宣传部！`);
    } catch (error) {
      if (error.code === "admin_login_required") showLogin(errorText(error));
      else showNotice(errorText(error), true);
    } finally {
      testMessageButton.disabled = false;
      testMessageButton.textContent = "一键发送测试消息";
    }
  });
  actions.append(
    testMessageButton,
    makeButton("保存设置", "button-secondary", async () => {
      try {
        const result = await api(`/api/accounts/${encodeURIComponent(account.id)}`, {
          method: "PATCH",
          body: { displayName: displayName.input.value, defaultRecipient: recipient.input.value },
        });
        showNotice(`已保存“${result.account.displayName}”的设置。`);
        await refreshAccounts();
      } catch (error) {
        if (error.code === "admin_login_required") showLogin(errorText(error));
        else showNotice(errorText(error), true);
      }
    }),
    makeButton("轮换 Webhook 密钥", "button-secondary", async () => {
      try {
        const result = await api(`/api/accounts/${encodeURIComponent(account.id)}`, {
          method: "PATCH",
          body: { rotateWebhookSecret: true },
        });
        showSecret(result.account.id, result.webhookSecret);
        showNotice("Webhook 密钥已轮换，旧密钥立即失效。");
      } catch (error) {
        if (error.code === "admin_login_required") showLogin(errorText(error));
        else showNotice(errorText(error), true);
      }
    }),
    makeButton("删除账号", "button-danger", async () => {
      if (!window.confirm(`确定删除“${account.displayName}”吗？该账号的 Webhook 密钥将立即失效。`)) return;
      try {
        await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
        showNotice(`已删除“${account.displayName}”。`);
        await Promise.all([refreshAccounts(), refreshReminders()]);
      } catch (error) {
        if (error.code === "admin_login_required") showLogin(errorText(error));
        else showNotice(errorText(error), true);
      }
    }),
  );
  card.append(head, fields, actions);
  return card;
}

async function refreshAccounts() {
  const result = await api("/api/accounts");
  if (dashboardPanel.hidden) showDashboard();
  connectedAccounts = result.accounts;
  accountList.replaceChildren(...result.accounts.map(renderAccount));
  emptyState.hidden = result.accounts.length !== 0;
  accountList.hidden = result.accounts.length === 0;
  populateReminderAccounts();
}

async function refreshReminders() {
  const result = await api("/api/reminders");
  reminderList.replaceChildren(...result.reminders.map(renderReminder));
  reminderEmptyState.hidden = result.reminders.length !== 0;
  reminderList.hidden = result.reminders.length === 0;
}

async function refreshDashboard() {
  await Promise.all([refreshAccounts(), refreshReminders()]);
}

function setQrStatus(message) {
  qrStatus.textContent = message;
}

function stopQrSession() {
  activeTicket = "";
  pendingVerifyCode = "";
  pollBusy = false;
  window.clearTimeout(qrPollTimer);
  window.clearInterval(qrCountdownTimer);
  if (currentPollController) currentPollController.abort();
  currentPollController = null;
  if (qrImageUrl) URL.revokeObjectURL(qrImageUrl);
  qrImageUrl = "";
  qrImage.removeAttribute("src");
  qrImage.hidden = true;
  verifyForm.hidden = true;
  retryQrButton.hidden = true;
  verifyCodeInput.value = "";
}

function showQrTerminal(message, allowRetry = false) {
  activeTicket = "";
  pendingVerifyCode = "";
  pollBusy = false;
  window.clearTimeout(qrPollTimer);
  window.clearInterval(qrCountdownTimer);
  if (currentPollController) currentPollController.abort();
  currentPollController = null;
  verifyForm.hidden = true;
  retryQrButton.hidden = !allowRetry;
  setQrStatus(message);
}

function updateCountdown() {
  const seconds = Math.max(0, Math.ceil((qrExpiresAt - Date.now()) / 1000));
  qrCountdown.textContent = seconds > 0 ? `二维码剩余有效时间 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "二维码已过期";
  if (seconds === 0 && activeTicket) {
    if (currentPollController) currentPollController.abort();
    showQrTerminal("二维码已过期，请重新生成。", true);
  }
}

function scheduleQrPoll(delay = 700) {
  window.clearTimeout(qrPollTimer);
  if (activeTicket) qrPollTimer = window.setTimeout(() => pollQr(), delay);
}

async function pollQr(verifyCode) {
  if (!activeTicket || pollBusy) return;
  if (Date.now() >= qrExpiresAt) {
    showQrTerminal("二维码已过期，请重新生成。", true);
    return;
  }
  if (verifyCode !== undefined) pendingVerifyCode = verifyCode;
  pollBusy = true;
  const controller = new AbortController();
  currentPollController = controller;
  let nextPollDelay = null;
  try {
    const result = await api("/api/login/poll", {
      method: "POST",
      body: { ticket: activeTicket, ...(pendingVerifyCode ? { verifyCode: pendingVerifyCode } : {}) },
      signal: controller.signal,
    });
    if (result.status === "wait") {
      setQrStatus("等待手机微信扫码…");
      nextPollDelay = 400;
    } else if (result.status === "scaned") {
      pendingVerifyCode = "";
      setQrStatus("已扫码，正在等待微信确认…");
      nextPollDelay = 400;
    } else if (result.status === "redirect") {
      activeTicket = result.ticket;
      setQrStatus("微信正在切换登录节点…");
      nextPollDelay = 400;
    } else if (result.status === "need_verifycode") {
      pendingVerifyCode = "";
      verifyForm.hidden = false;
      verifyCodeInput.focus();
      setQrStatus("请在微信中查看验证码并在此输入。");
    } else if (result.status === "verify_code_blocked") {
      pendingVerifyCode = "";
      showQrTerminal("验证码多次错误，微信暂时阻止了本次连接。请稍后重新扫码。", true);
    } else if (result.status === "expired") {
      showQrTerminal("微信二维码已失效，请重新生成。", true);
    } else if (result.status === "binded_redirect") {
      showQrTerminal("这个微信账号已绑定其他 OpenClaw 实例，微信没有返回新的连接凭证。", false);
    } else if (result.status === "already_connected") {
      showQrTerminal("这个微信账号已经在后台连接。", false);
      await refreshAccounts();
    } else if (result.status === "confirmed") {
      showQrTerminal("微信连接成功。", false);
      await refreshAccounts();
      showSecret(result.account.id, result.webhookSecret);
      showNotice(`已连接“${result.account.displayName}”。请保存新生成的 Webhook 密钥。`);
      if (qrDialog.open) qrDialog.close();
    } else {
      showQrTerminal("收到未知的微信登录状态，请重新生成二维码。", true);
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (error.code === "admin_login_required") {
      stopQrSession();
      if (qrDialog.open) qrDialog.close();
      showLogin(errorText(error));
      return;
    }
    setQrStatus(`${errorText(error)} 正在重试…`);
    nextPollDelay = 2500;
  } finally {
    if (currentPollController === controller) {
      pollBusy = false;
      currentPollController = null;
    }
  }
  if (nextPollDelay !== null) scheduleQrPoll(nextPollDelay);
}

async function startQrSession() {
  stopQrSession();
  setQrStatus("正在向微信申请二维码…");
  qrCountdown.textContent = "";
  retryQrButton.hidden = true;
  verifyForm.hidden = true;
  if (!qrDialog.open) qrDialog.showModal();
  try {
    const result = await api("/api/login/start", { method: "POST", body: {} });
    activeTicket = result.ticket;
    qrExpiresAt = result.expiresAt;
    const blob = new Blob([result.qrSvg], { type: "image/svg+xml" });
    qrImageUrl = URL.createObjectURL(blob);
    qrImage.src = qrImageUrl;
    qrImage.hidden = false;
    setQrStatus("请使用手机微信扫描二维码。连接仅在本页面有效。 ");
    updateCountdown();
    qrCountdownTimer = window.setInterval(updateCountdown, 1000);
    scheduleQrPoll(300);
  } catch (error) {
    if (error.code === "admin_login_required") {
      qrDialog.close();
      showLogin(errorText(error));
      return;
    }
    showQrTerminal(errorText(error), true);
  }
}

function showSecret(accountId, secret) {
  secretAccountId.textContent = accountId;
  secretValue.textContent = secret;
  secretMessage.textContent = "";
  secretDialog.showModal();
}

$("#copySecretButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`accountId: ${secretAccountId.textContent}\nBearer: ${secretValue.textContent}`);
    secretMessage.textContent = "已复制。请将密钥保存到安全的密码管理器或调用方配置中。";
    secretMessage.style.color = "#28724e";
  } catch {
    secretMessage.textContent = "复制失败，请手动保存上方两项。";
    secretMessage.style.color = "#b84747";
  }
});

secretDialog.addEventListener("close", () => {
  secretAccountId.textContent = "";
  secretValue.textContent = "";
  secretMessage.textContent = "";
});

qrDialog.addEventListener("close", stopQrSession);
$("#connectButton").addEventListener("click", startQrSession);
$("#emptyConnectButton").addEventListener("click", startQrSession);
retryQrButton.addEventListener("click", startQrSession);

accountsTab.addEventListener("click", () => setDashboardView("accounts"));
remindersTab.addEventListener("click", async () => {
  setDashboardView("reminders");
  try {
    await refreshReminders();
  } catch (error) {
    handleReminderError(error);
  }
});

addReminderButton.addEventListener("click", () => openReminderForm());
cancelReminderButton.addEventListener("click", closeReminderForm);

reminderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setReminderFormMessage("");
  const body = {
    accountId: reminderAccountInput.value,
    text: reminderTextInput.value,
  };
  if (!editingReminder || reminderAtInput.value !== editingReminder.at) body.at = reminderAtInput.value;
  if (!editingReminder || reminderFrequencyInput.value !== editingReminder.frequency) {
    body.frequency = reminderFrequencyInput.value;
  }
  if (!editingReminder || reminderTimezoneInput.value.trim() !== editingReminder.timezone) {
    body.timezone = reminderTimezoneInput.value.trim();
  }
  const originalLabel = editingReminder ? "保存修改" : "保存提醒";
  saveReminderButton.disabled = true;
  saveReminderButton.textContent = "正在保存…";
  try {
    if (editingReminder) {
      await api(`/api/reminders/${encodeURIComponent(editingReminder.id)}`, { method: "PATCH", body });
      showNotice("提醒已更新。");
    } else {
      await api("/api/reminders", { method: "POST", body });
      showNotice("提醒已创建。");
    }
    closeReminderForm();
    await refreshReminders();
  } catch (error) {
    handleReminderError(error, true);
  } finally {
    saveReminderButton.disabled = false;
    saveReminderButton.textContent = originalLabel;
  }
});

verifyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = verifyCodeInput.value.trim();
  if (!/^\d{1,12}$/u.test(code)) {
    setQrStatus("请输入微信显示的数字验证码。");
    return;
  }
  verifyForm.hidden = true;
  setQrStatus("正在验证…");
  await pollQr(code);
  verifyCodeInput.value = "";
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "";
  const password = passwordInput.value;
  try {
    await api("/api/admin/login", { method: "POST", body: { password } });
    passwordInput.value = "";
    await refreshDashboard();
  } catch (error) {
    passwordInput.value = "";
    loginMessage.textContent = errorText(error);
  }
});

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setupMessage.textContent = "";
  const password = setupPasswordInput.value;
  const confirmation = setupConfirmInput.value;
  if (password !== confirmation) {
    setupConfirmInput.value = "";
    setupMessage.textContent = "两次输入的密码不一致。";
    return;
  }
  if (password.length < 8 || !/[A-Za-z]/u.test(password) || !/[0-9]/u.test(password) || !/[\p{P}\p{S}]/u.test(password)) {
    setupPasswordInput.value = "";
    setupConfirmInput.value = "";
    setupMessage.textContent = errorText({ code: "invalid_admin_password" });
    return;
  }
  try {
    await api("/api/admin/setup", { method: "POST", body: { password } });
    setupPasswordInput.value = "";
    setupConfirmInput.value = "";
    await refreshDashboard();
  } catch (error) {
    if (error.code === "admin_already_initialized") {
      await initialize();
      return;
    }
    setupPasswordInput.value = "";
    setupConfirmInput.value = "";
    setupMessage.textContent = errorText(error);
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST", body: {} });
  } catch {
    // The local view is cleared even if the network request failed.
  }
  if (secretDialog.open) secretDialog.close();
  showLogin("已退出登录。");
});

async function initialize() {
  try {
    const status = await api("/api/admin/status");
    if (!status.initialized) {
      showSetup();
      return;
    }
    await refreshDashboard();
  } catch (error) {
    if (error.code === "admin_login_required") showLogin();
    else showLogin(errorText(error));
  }
}

initialize();
