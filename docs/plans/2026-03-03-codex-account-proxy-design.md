# Codex Account Proxy Design

## 概述

在 Antigravity Tools 中增加 Codex（OpenAI）账户支持，使用户可以通过 Antigravity 代理将 Codex 账户中转给 Claude Code 和 Cursor 使用。

**方案选择**：方案 A — 在现有 Account 模型上添加 `AccountProvider` 枚举字段，按 provider 分发路由。

---

## 第一部分：数据模型变更

### 1.1 新增 AccountProvider 枚举

`src-tauri/src/models/account.rs`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AccountProvider {
    Google,  // 现有的 Google/Gemini 账户
    Codex,   // OpenAI Codex 账户 (sess-... 或 sk-...)
}

impl Default for AccountProvider {
    fn default() -> Self {
        AccountProvider::Google
    }
}
```

### 1.2 Account 结构体添加 provider 字段

```rust
pub struct Account {
    // ... 现有字段不变
    #[serde(default)]  // 反序列化旧数据时自动填充 Google
    pub provider: AccountProvider,
}
```

### 1.3 TokenData 适配

复用现有 `TokenData`，字段映射：

| TokenData 字段 | Google 用途 | Codex 用途 |
|---|---|---|
| `access_token` | Google OAuth access token | `sess-...` token 或 `sk-...` API key |
| `refresh_token` | Google refresh token | `ref-...` refresh token（API key 模式为空字符串） |
| `expires_in` | 过期秒数 | 过期秒数（API key 模式设为极大值） |
| `expiry_timestamp` | UTC 时间戳 | UTC 时间戳（API key 模式设为远未来） |
| `project_id` | GCP project ID | 不使用，设为 `None` |

---

## 第二部分：OAuth 认证与账户导入

### 2.1 三种导入方式

**方式一：OAuth 网页登录**

- 新建 `src-tauri/src/modules/codex_oauth.rs`，实现 OpenAI 的 OAuth PKCE 流程
- OAuth 端点：`https://auth.openai.com`
- 从 openai/codex 开源代码中提取 `client_id`
- 复用 `oauth_server.rs` 的 TcpListener 回调模式，参数化 `OAuthFlowState` 添加 provider 标识
- 成功后拿到 `sess-...` access_token + `ref-...` refresh_token，构造 `TokenData`

**方式二：手动导入 token/key**

- 前端新增导入对话框，支持粘贴 `sess-...` token 或 `sk-...` API key
- 后端新增 Tauri command：`add_codex_account_manual(token, refresh_token?)`
- 通过 token 调用 OpenAI userinfo 端点获取账户显示名

**方式三：从 ~/.codex/auth.json 导入**

- 读取 `~/.codex/auth.json`，解析 `access_token`、`refresh_token`、`expires_at`
- 新增 Tauri command：`import_codex_from_file()`

### 2.2 Token 刷新

- 新建 `codex_oauth::refresh_codex_token(refresh_token)` 函数
- `ensure_fresh_token` 根据 `account.provider` 分发到 Google 或 Codex 的刷新逻辑
- `sk-...` API key 不过期，跳过刷新

### 2.3 OAuthFlowState 改造

```rust
pub struct OAuthFlowState {
    pub provider: AccountProvider,  // 新增
    pub state: String,
    pub code_rx: mpsc::Receiver<String>,
    pub cancel_tx: watch::Sender<bool>,
    // ...
}
```

---

## 第三部分：代理引擎（Proxy Engine）

### 3.1 请求路由

不需要新增独立的 handler 模块。在现有 OpenAI/Claude handler 中，根据选中账户的 provider 切换上游：

```
来自 Claude Code / Cursor 的请求
    → 选择可用账户（现有轮询/sticky session 逻辑）
    → account.provider == Google → Google 上游
    → account.provider == Codex  → OpenAI 上游 (api.openai.com)
```

### 3.2 Mapper 层

复用现有 OpenAI mapper（`mappers/openai/`），不需要 Codex 专用 mapper：

- Claude Code → Codex 上游：经 `mappers/claude/` 转内部格式，再经 `mappers/openai/` 转 OpenAI Chat Completions 格式
- Cursor → Codex 上游：已是 OpenAI 格式，直接经 `mappers/openai/` 转发

### 3.3 上游请求构建

在上游请求构建逻辑中按 provider 分支：

```rust
match account.provider {
    AccountProvider::Google => { /* 现有 Google 逻辑 */ }
    AccountProvider::Codex => {
        url = "https://api.openai.com/v1/chat/completions";
        auth = format!("Bearer {}", account.token.access_token);
    }
}
```

### 3.4 模型映射

模型路由优先级：
- `claude-*` / `gemini-*` → 优先选 Google 账户
- `gpt-*` / `o1-*` / `o3-*` / `o4-*` → 优先选 Codex 账户
- 其他 → 按可用账户轮询

### 3.5 Client Adapter

新增 `proxy/common/client_adapters/codex.rs`：
- `matches()` 匹配 Codex CLI User-Agent
- `supported_protocols()` 返回 `[Protocol::OpenAI, Protocol::OACompatible]`
- 注册到 `CLIENT_ADAPTERS`

---

## 第四部分：前端 UI 变更

### 4.1 账户列表

- 每个账户卡片增加 provider 标签（Google 图标 / OpenAI 图标）
- 支持按 provider 筛选
- 配额显示适配：Google 显示配额等级，Codex 显示 "API Key" / "OAuth Session" 标识

### 4.2 添加账户对话框

先选择 provider（Google / Codex），再进入对应导入流程：
- Google → 现有 OAuth 流程
- Codex → OAuth 网页登录 / 手动输入 / 从文件导入

### 4.3 Zustand Store

`useAccountStore` 新增 actions：`addCodexAccountManual()`, `importCodexFromFile()`

### 4.4 TypeScript 类型

```typescript
export type AccountProvider = 'google' | 'codex';
export interface Account {
    // ...现有字段
    provider: AccountProvider;
}
```

### 4.5 国际化

各语言文件新增 Codex 相关翻译键。

### 4.6 Dashboard

账户统计按 provider 分组显示。

---

## 第五部分：CLI 同步、错误处理与兼容性

### 5.1 CLI 同步

- Claude Code / Cursor 同步：代理 URL 不变，客户端不感知底层 provider
- Codex CLI 同步：保持 `cli_sync.rs` 现有 `CliApp::Codex` 逻辑

### 5.2 错误处理

| 错误场景 | 处理方式 |
|---|---|
| `sess-...` token 过期 | 自动 refresh；失败标记需重新登录 |
| `sk-...` API key 无效 | 标记 disabled，通知用户 |
| OpenAI 429 限流 | 走现有 retry + 账户轮换 |
| OpenAI 401 认证失败 | 尝试 refresh，失败则 rotate |
| OAuth 登录取消 | 复用 `cancel_oauth_flow` |

### 5.3 配额查询

- Google：现有逻辑不变
- Codex：初期简化为仅显示连接状态，不查询配额

### 5.4 向后兼容

- `#[serde(default)]` 确保旧数据兼容，无需迁移
- 前端 API 不变，`provider` 是新增可选字段
- 代理行为对客户端透明

### 5.5 不在本期实现

- Codex Warmup（OpenAI 无需预热）
- Codex Device Profile（OpenAI 不使用设备指纹）
- OpenAI Responses API（`/v1/responses`）——初期用 Chat Completions 即可
