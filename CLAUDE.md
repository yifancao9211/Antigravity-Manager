# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Tools is a Tauri v2 desktop application for AI account management and API proxy/relay. It converts web-based AI sessions (Google/Anthropic) into standard API endpoints (OpenAI, Anthropic, Gemini formats) and intelligently routes requests across multiple accounts with automatic failover. Also runs in headless/Docker mode via `--headless` flag.

## Build & Development Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start Vite dev server only (port 1420) |
| `npm run build` | TypeScript check + Vite production build |
| `npx tauri dev` | Full Tauri dev mode (starts both Vite + Rust backend) |
| `npx tauri build` | Production build of the desktop app |
| `RUST_LOG=debug npx tauri dev` | Tauri dev with Rust debug logging |

There is no test runner, linter, or formatter configured in package.json. TypeScript checking is done via `tsc` as part of `npm run build`.

The Vite dev server proxies `/api/` requests to the Rust backend at `http://127.0.0.1:8045`.

## Architecture

### Two-Process Model (Tauri v2)

```
┌──────────────────────────────┐     ┌────────────────────────────────────┐
│     Frontend (WebView)       │     │        Rust Backend (Tauri)        │
│  React 19 + TypeScript       │◄───►│  Tauri commands (IPC)              │
│  Vite 7, port 1420           │     │  Axum HTTP server, port 8045       │
│  Zustand stores              │     │  SQLite databases (rusqlite)       │
│  Ant Design + Tailwind/Daisy │     │  Proxy engine (protocol adapters)  │
└──────────────────────────────┘     └────────────────────────────────────┘
```

**Frontend → Backend communication** uses two channels:
- **Tauri IPC** (`@tauri-apps/api invoke`): For desktop-native calls (account management, config, system operations). Wrapped via `src/utils/request.ts`.
- **HTTP `/api/`**: For proxied AI API requests. Vite proxies to port 8045 in dev; in production the Rust backend serves everything on 8045.

### Frontend (`src/`)

**State management**: Zustand stores in `src/stores/`:
- `useAccountStore` — account list, current account, quota data
- `useConfigStore` — app configuration (proxy settings, UI preferences)
- `useViewStore` — UI view state
- `useDebugConsole` — debug console toggle
- `networkMonitorStore` — network/proxy monitoring

**Routing** (React Router v7, defined in `App.tsx`):
- `/` — Dashboard
- `/accounts` — Account management
- `/api-proxy` — Proxy configuration
- `/monitor` — Request monitoring
- `/token-stats` — Token usage statistics
- `/user-token` — User token management
- `/security` — IP whitelist/blacklist, security config
- `/settings` — App settings

**UI stack**: Ant Design 5 components + `@lobehub/ui` + Tailwind CSS 3 with DaisyUI 5 custom themes. Dark mode via CSS class toggling. i18next for internationalization (locale files in `src/locales/`).

**Platform detection**: `src/utils/env.ts` exports `isTauri()` to branch between desktop (Tauri IPC) and web (HTTP API) modes.

### Backend (`src-tauri/src/`)

**Entry flow**: `main.rs` → `lib.rs::run()` which initializes databases, logger, tray, and starts the Axum server on port 8045.

**Module organization**:
- `commands/` — Tauri command handlers exposed to frontend via `#[tauri::command]`. Submodules: `proxy`, `proxy_pool`, `security`, `cloudflared`, `autostart`, `user_token`.
- `models/` — Data structures: `account`, `config`, `quota`, `token`.
- `modules/` — Core business logic: `account`, `account_service`, `config`, `db`, `device`, `oauth`, `quota`, `migration`, `security_db`, `token_stats`, `user_token_db`, `tray`, `log_bridge`, `scheduler`, `cloudflared`, `integration`, `cache`.
- `proxy/` — The API proxy engine (largest subsystem).

### Proxy Engine (`src-tauri/src/proxy/`)

This is the core subsystem that converts incoming API requests into upstream AI service calls:

- `handlers/` — Route handlers per API format: `openai`, `claude` (Anthropic), `gemini`, `cursor`, `mcp`, `audio`, `warmup`.
- `mappers/` — Protocol adapters that transform between formats. Each has `request`, `response`, `streaming`, `models`, and `collector` submodules. Key adapters: `openai/`, `claude/`, `gemini/`.
- `common/` — Shared utilities: `model_mapping`, `rate_limiter`, `session` management, `client_adapter`, `tool_adapter`, `schema_cache`.
- `middleware/` — HTTP middleware: `auth` (API key validation, IP-based auth).
- `config.rs` — Proxy configuration types including `ProxyAuthMode` (Off, Auto, Strict, AllExceptHealth).
- `cli_sync.rs`, `droid_sync.rs`, `opencode_sync.rs` — Sync proxy config to external CLI tools.
- `debug_logger.rs` — Request/response debug logging.

### Data Storage

SQLite databases (via `rusqlite` with bundled SQLite):
- Token statistics (`token_stats::init_db`)
- Security/IP data (`security_db::init_db`)
- User tokens (`user_token_db::init_db`)

App configuration stored as JSON (`gui_config.json`) in the platform data directory, managed by `modules/config.rs`.

### Headless Mode

The app can run without a GUI via `--headless` flag. In headless mode:
- No Tauri window or tray — runs a bare Tokio runtime
- Environment variables override config: `ABV_API_KEY`/`API_KEY`, `ABV_WEB_PASSWORD`/`WEB_PASSWORD`, `ABV_AUTH_MODE`/`AUTH_MODE`, `ABV_BIND_LOCAL_ONLY`
- Auth mode defaults to `AllExceptHealth` for security
- LAN access enabled by default (binds `0.0.0.0`) unless `ABV_BIND_LOCAL_ONLY=1`

## Key Conventions

- **TypeScript**: Strict mode with `noUnusedLocals` and `noUnusedParameters` enabled. ES2020 target, bundler module resolution.
- **Rust**: Edition 2021. Uses `thiserror` for error types, `tracing` for logging (not `log`), `tokio` for async, `axum` for HTTP.
- **Frontend-backend bridge**: The `src/utils/request.ts` utility auto-detects Tauri vs browser environment and routes calls accordingly (IPC vs HTTP).
- **Bilingual codebase**: Comments and some UI strings are in Chinese; code identifiers and public APIs are in English.
- **Tauri plugins**: autostart, dialog, fs, opener, process, updater, window-state, single-instance. Capabilities defined in `src-tauri/capabilities/`.
