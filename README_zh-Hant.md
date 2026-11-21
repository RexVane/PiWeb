# PiWeb — Pi Coding Agent 網頁介面與 AI 程式設計助手

<p align="center">
  <a href="https://www.npmjs.com/package/@rexvane/piweb"><img src="https://img.shields.io/npm/v/@rexvane/piweb.svg" alt="npm 版本" /></a>
  <a href="https://github.com/RexVane/PiWeb/actions/workflows/check.yml"><img src="https://github.com/RexVane/PiWeb/actions/workflows/check.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT 授權" /></a>
</p>

<p align="center">
  <strong>可自行部署的 AI 程式設計智慧體 Web 介面，支援桌面與手機瀏覽器。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README_zh.md">简体中文</a> | <strong>繁體中文</strong> | <a href="README_ja.md">日本語</a> | <a href="README_ru.md">Русский</a>
</p>

**PiWeb** 是 [Pi Coding Agent](https://github.com/earendil-works/pi) 的開源、自架網頁介面。用 npm 安裝，在自己的電腦或伺服器上執行，就能在桌面或手機瀏覽器中追蹤工具呼叫、審閱程式碼變更，並接著之前的會話繼續工作。

它內建官方 `@earendil-works/pi-*` SDK，沿用已有的 pi 設定、模型、技能、擴充功能和 MCP（Model Context Protocol）配置。

<p align="center">
  <img src="assets/readme-chat.jpg" alt="PiWeb：可自架的 Pi Coding Agent 網頁介面，展示專案工作區、AI 對話和工具呼叫" width="840" />
</p>

## 目錄

- [特色功能](#特色功能)
- [快速開始](#快速開始)
- [使用與遠端連線](#使用與遠端連線)
- [配置](#配置)
- [工作原理](#工作原理)
- [說明文件](#說明文件)
- [貢獻](#貢獻)
- [致謝](#致謝)
- [授權條款](#授權條款)

## 特色功能

- **對話與上下文** — 流式顯示 Markdown、思考過程和工具呼叫。透過對話大綱跳轉，執行時可補充指示或排隊傳送訊息，也能在上下文用量指示中檢視 token 用量。
- **工作區與會話** — 按專案資料夾組織會話。支援重新命名、分支、封存、恢復草稿，以及匯出為 JSONL 或 HTML。
- **會話匯入** — 搜尋並匯入 Claude Code、Codex、OpenCode、Grok、ZCode、dsh、Kimi Code、WorkBuddy、Antigravity、Antigravity CLI、Qwen Code 和 Cursor 的本機歷史。PiWeb 就地讀取原始檔案。
- **檔案與改動** — 在專案生長樹中按輪檢視改動，包括 `SKILL.md` 讀取步驟和 codemode 內的呼叫。支援原始碼、Markdown 預覽、統一或並排 Diff，以及在對話中引用選取的行。
- **模型、技能與擴充功能** — 配置模型供應商，使用 Pi 的 MCP 工具並管理 Pi 包。[安裝已有資源或自行設計](docs/resources.md)，透過 JSON UI 或獨立網頁介面接入，無需重新建置 PiWeb。
- **提示詞來源** — 檢視專案指令、技能、模板和工具定義及其資源來源。
- **可選問答資源** — 從 [piweb-ask-user](https://github.com/RexVane/piweb-ask-user) 單獨安裝。目前原始碼的資源 API v1 取代了原本的內建問答工具；重新整理舊 npm 安裝不會啟用新架構。
- **手機訪問與語言** — 在「設定 → 遠端連線」掃碼連線。介面支援英語、簡體中文、繁體中文、日語和俄語。

<details>
<summary>更多截圖（桌面端與手機端）</summary>

以下截圖使用舊版英文介面和範例資料；問答現在由可選資源提供。

<table>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-project.jpg" alt="桌面端專案檔案" /><br /><strong>專案檔案</strong></td>
    <td width="50%"><img src="assets/readme-desktop-files.jpg" alt="桌面端並排 Diff" /><br /><strong>並排 Diff</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-import.jpg" alt="桌面端會話匯入" /><br /><strong>會話匯入</strong></td>
    <td width="50%"><img src="assets/readme-desktop-models.jpg" alt="桌面端模型供應商選擇" /><br /><strong>模型供應商</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-context.jpg" alt="桌面端上下文用量明細" /><br /><strong>上下文用量</strong></td>
    <td width="50%"><img src="assets/readme-desktop-skills.jpg" alt="桌面端技能工作區" /><br /><strong>技能</strong></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="assets/readme-mobile.jpg" width="50%" alt="手機端對話" /><br /><strong>手機端對話</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-mobile-workspaces.jpg" alt="手機端工作區側欄" /><br /><strong>工作區</strong></td>
    <td width="50%"><img src="assets/readme-mobile-import.jpg" alt="手機端會話匯入" /><br /><strong>手機端匯入</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-mobile-files.jpg" alt="手機端檔案檢視器" /><br /><strong>檔案檢視器</strong></td>
    <td width="50%"><img src="assets/readme-mobile-models.jpg" alt="手機端模型供應商選擇" /><br /><strong>模型供應商</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-mobile-context.jpg" alt="手機端上下文用量明細" /><br /><strong>上下文用量</strong></td>
    <td></td>
  </tr>
</table>

</details>

## 快速開始

需要 **Node.js ≥ 22.19.0**（`package.json` 中的 `engines`），推薦 Node 24。專案生長曆史功能需要 Git。

```bash
npm install -g @rexvane/piweb
piweb
```

PiWeb 預設開啟帶認證的 `http://127.0.0.1:30141` 頁面（連接埠被佔用時自動遞增）。在設定中配置模型供應商，或沿用既有的 pi 設定。發布套件只註冊 `piweb` 命令，不會與官方 `pi` CLI 衝突。包內已包含封存的生產構建；如果安裝時跳過了生命週期腳本，第一次啟動會先構建一次再提供服務。詳見[安裝與建置](docs/operations/install-and-build.md)。

## 使用與遠端連線

```bash
piweb                    # http://127.0.0.1:30141
piweb -p 30143 --no-open # 指定連接埠，不自動開啟瀏覽器
piweb -H 0.0.0.0         # 同時把主服務綁到區域網（認證仍然開啟）
```

| 選項 | 說明 |
| --- | --- |
| `-p, --port <port>` | 監聽連接埠（預設 30141，環境變數 `PORT`） |
| `-H, --hostname <host>` | 繫結地址（預設 127.0.0.1，環境變數 `PI_WEB_HOSTNAME`） |
| `--public-url <url>` | 公開地址，用於登入連結，並自動加入 Host 白名單（環境變數 `PI_WEB_PUBLIC_URL`） |
| `--dev` | 開發模式（僅迴環） |
| `--no-open` | 不自動開啟瀏覽器 |
| `-h, --help` | 顯示用法 |

在本機上，啟動器會用私有登入憑據開啟瀏覽器，並且不會把該憑據列印出來。再次執行 `piweb` 會重新開啟已有例項並登入。

更新：`npm install -g @rexvane/piweb@latest`，然後重啟 `piweb`。解除安裝：`npm uninstall -g @rexvane/piweb` —— agent 資料和已匯入的工具歷史不會被改動。降級見[發布、降級與回滾](docs/operations/release-and-rollback.md)。

連線手機或其他裝置時，開啟 **設定 → 遠端連線**，掃描 QR Code（或複製連結）。同一張碼在同一 Wi-Fi 和區域網外都可以用，客戶端無需額外軟體。這是一個 256 位一次性憑據，有效期 120 秒。生產啟動會準備 `0.0.0.0:30142` 上的手機排版代理，以及 Cloudflare 快速隧道（`cloudflared`）。QR Code使用隧道的 HTTPS 地址，只有該地址可達後才會出現。本機的 `127.0.0.1:30141` 提供桌面頁面。開發模式保持本機訪問。

直連區域網的 HTTP 不加密。QR Code地址的 TLS 在 Cloudflare 終止。重啟後隧道地址可能變化。

### 安全說明

- 在 `piweb` 啟動器接受的所有啟動方式中，認證預設開啟（`PI_WEB_AUTH=1`）。
- `PI_WEB_AUTH=0` 只允許繫結迴環，且不能設定 `--public-url` / `PI_WEB_PUBLIC_URL`。其他組合會被啟動器拒絕。關閉認證時，不會準備內建區域網代理和 Cloudflare 隧道。
- 開發模式（`--dev` / `PI_WEB_DEV=1`）只允許迴環繫結，因為 Next.js 開發端點不受啟動令牌保護。
- 啟動令牌透過 `GET /?token=…` 兌換一張經 HMAC 簽名的 HttpOnly 會話 Cookie（有效期 30 天；在 HTTPS 下設定 `Secure`）。它不能用在 API 路徑或 `Authorization` 頭中。沒有密碼登入；設定 `PI_WEB_PASSWORD` 會使啟動器拒絕啟動。
- 「讓所有裝置重新登入」會使現有 Cookie 和配對碼失效。
- 自建反向代理或隧道時，將代理指向 `127.0.0.1:30142`（手機排版）或 `127.0.0.1:30141`（桌面），保持認證開啟，並把外部主機名加入白名單（`PI_WEB_TRUSTED_HOSTS=<your-domain>` 或 `--public-url`）。否則請求會返回 403 `untrusted host`。`PIWEB_REMOTE_LAN=0` 會關閉內建代理和快速隧道的自動準備。

## 配置

取值來自程序環境。命令列引數會覆蓋對應的環境變數。含作業系統路徑約定的維護文件見[環境變數參考](docs/operations/environment.md)。

| 變數 | 預設值 | 含義 |
| --- | --- | --- |
| `PORT` | `30141` | 主監聽連接埠。`piweb -p` 優先；連接埠被佔用時啟動器會按 `+1` 重試。 |
| `PI_WEB_HOSTNAME` | `127.0.0.1` | 主繫結地址（等同 `-H`）。非迴環繫結仍會保持認證開啟。 |
| `PI_WEB_AUTH` | `1` | 認證開關。`0` 僅在繫結迴環且沒有公開地址時被接受。 |
| `PI_WEB_PUBLIC_URL` | 未設定 | 公開地址（等同 `--public-url`）。其主機名會加入 Host 白名單。 |
| `PI_WEB_TRUSTED_HOSTS` | 空 | 自建反代或命名隧道的 Host 白名單，逗號分隔。 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi / PiWeb 共用的 agent 目錄。它不是唯一資料根，見[資料與隱私](docs/operations/data-and-privacy.md)。 |
| `PIWEB_REMOTE_LAN` | 啟用 | `0` / `false` / `off` / `no` 關閉區域網代理和 Cloudflare 快速隧道的自動準備。 |
| `PIWEB_REMOTE_LAN_PORT` | `30142` | 內建區域網 / 手機代理的監聽連接埠。 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 未設定 | 模型請求使用的代理。設定 → 通用 → 網路代理（`httpProxy`）會覆蓋它。 |
| `PI_WEB_UPDATE_CHECK` | `1` | 設為 `0` 時跳過啟動時的更新檢查。設定 → 檢查更新仍可用。 |
| `PI_OFFLINE` | 未設定 | `1` / `true` / `yes` 跳過 PiWeb / SDK 的聯網動作，例如更新檢查。 |

<details>
<summary>全部環境變數</summary>

下表列出了在 `src/`、`scripts/` 和 `bin/` 中找到的全部 PiWeb 專用變數。內部程序變數在部署中不要設定。

#### 服務與網路

| 變數 | 預設值 | 含義 |
| --- | --- | --- |
| `PORT` | `30141` | 主監聽連接埠。`piweb -p` 優先；連接埠被佔用時啟動器會按 `+1` 重試。 |
| `PI_WEB_HOSTNAME` | `127.0.0.1` | 主繫結地址（等同 `-H` / `--hostname`）。非迴環繫結仍會保持認證開啟。 |
| `PI_WEB_PUBLIC_URL` | 未設定 | 公開地址（等同 `--public-url`）。其主機名會加入 Host 白名單，並用於開啟登入頁。 |
| `PI_WEB_TRUSTED_HOSTS` | 空 | 逗號分隔的 Host 白名單。自建反代或命名隧道必須列入，否則返回 403 `untrusted host`。 |
| `PI_WEB_ALLOWED_HOSTS` | 空 | 上游 `agegr/pi-web` 的舊變數名，與 `PI_WEB_TRUSTED_HOSTS` 合併生效。 |
| `PI_WEB_AUTH` | `1` | 認證開關。`0` 僅在繫結迴環且沒有公開地址時被接受；關閉認證時不會準備區域網/隧道入口。 |
| `PI_WEB_UPDATE_CHECK` | `1` | 設為 `0` 時跳過啟動時的一次性更新檢查。**設定 → 檢查更新** 仍可用。 |
| `PI_WEB_NO_OPEN` | 未設定 | `1` 表示啟動後不自動開啟瀏覽器（等同 `--no-open`）。 |
| `PI_WEB_DEV` | 未設定 | `1` 以開發模式啟動（等同 `--dev`）。開發模式只允許迴環繫結。 |
| `PI_WEB_ROOT` | 安裝根目錄 / `cwd` | 應用根目錄覆蓋，供啟動器和發布腳本使用。普通部署不要改。 |
| `PIWEB_REMOTE_LAN` | 啟用 | `0` / `false` / `off` / `no` 關閉內建區域網代理和 Cloudflare 快速隧道的自動準備。 |
| `PIWEB_REMOTE_LAN_PORT` | `30142` | 內建區域網 / 手機代理的監聽連接埠。 |
| `PIWEB_REMOTE_LAN_BIND` | `0.0.0.0` | 內建區域網 / 手機代理的繫結地址，例如只綁某塊網絡卡。 |
| `PIWEB_CLOUDFLARED` | 未設定 | `cloudflared` 可執行檔案路徑。查詢順序：本變數 → `<agent 目錄>/web-bin/cloudflared{,.exe}` → `PATH`。 |
| `PIWEB_SKIP_WARMUP` | 未設定 | `1` 跳過生產首屏預熱（僅排障用，首次開啟會變慢）。 |

#### 代理

| 變數 | 預設值 | 含義 |
| --- | --- | --- |
| `HTTP_PROXY` / `HTTPS_PROXY`（及小寫形式） | 未設定 | 模型請求使用的代理。未設定時，若當前使用者啟用了 Windows 系統代理則使用它。 |
| `NO_PROXY` / `no_proxy` | 本機地址繞過 | 代理繞過列表。Windows 的精確主機和域名字尾例外會繼承；PAC/WPAD 以及 `<local>`、`192.168.*` 等 Windows 專用規則不會被執行。 |
| `NODE_USE_ENV_PROXY` | 在支援時由啟動器設為 `1` | 讓 Node 的 `fetch` / `http` 認代理環境變數。支援 Node 24+ 或 22.21+；使用者顯式設定的值會被保留。 |

設定 → 通用 → 網路代理中的值（`settings.json` 的 `httpProxy`）優先於環境變數和系統代理；留空則回到自動檢測。修改後請重啟 `piweb`。

#### 認證與金鑰

| 變數 | 預設值 | 含義 |
| --- | --- | --- |
| `PI_WEB_SECRET_FILE` | `<agent 目錄>/web-secret` | 用於 Cookie 和配對碼 HMAC 簽名的金鑰檔案。 |
| `PI_WEB_SECRET` | 未設定（讀金鑰檔案） | 簽名金鑰，格式為 **32 位元組的 base64url 編碼**。設定後不再讀檔案。非法值會報錯，而不是靜默輪換金鑰。 |
| `PI_WEB_PASSWORD` | 已移除 | 密碼登入已刪除。若設定此變數，啟動器會**拒絕啟動**。 |

#### 資料、工具與留存

| 變數 | 預設值 | 含義 |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi / PiWeb 共用的 agent 目錄：設定、模型與憑據、會話、上傳。它不是唯一資料根，見[資料與隱私](docs/operations/data-and-privacy.md)。 |
| `PI_WEB_EDITOR` | `code` | 「在編輯器中開啟」使用的本機編輯器命令，僅對本機操作者有意義。 |
| `PI_WEB_UPLOAD_RETENTION` | `30`（天） | `web-uploads` 中未被引用檔案的後臺清掃閾值。`0` 關閉該清掃。清掃會先複製到 `~/.agents/backups/`，並記入 `INDEX.md`。 |
| `PI_WEB_DELETE_ATTACHMENT_CLEANUP` | 啟用 | 刪除會話時，一併清理僅被該會話引用的上傳檔案（先備份再刪除）。`0` 保留這些上傳。 |
| `PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY` | 關閉 | `1` 允許模型發現探測私網地址（本地推理常用）。預設關閉，以限制 SSRF。 |
| `PI_OFFLINE` | 未設定 | `1` / `true` / `yes` 跳過 PiWeb / SDK 的聯網動作，例如更新檢查、gh 身份查詢和安裝遙測。這不是作業系統級斷網。 |
| `PI_TELEMETRY` | 未設定 | Pi SDK 的安裝遙測開關（`1` / `true` / `yes` 開啟，`0` / `false` / `no` 關閉）。未設定時由 SDK 的 `enableInstallTelemetry`（預設開啟）決定。PiWeb 原始碼本身不讀取該變數，由捆綁的 SDK 消費。 |

#### 建置與發布

| 變數 | 預設值 | 含義 |
| --- | --- | --- |
| `PIWEB_BUILD_DIR` | 由 `.next-releases/active.json` 決定 | 只接受 `.next` 或 `.next-releases/<安全 id>`。與當前作用中的發布衝突時拒絕啟動。 |
| `PIWEB_MAX_RETAINED_RELEASES` | `10`（範圍 2–100） | 保留的成功發布構建數量上限。達到上限時拒絕新構建，不會自動刪除舊構建。 |
| `PIWEB_MAX_FAILED_RELEASES` | `3`（範圍 1–100） | 未完成或失敗的發布目錄上限，同樣會拒絕新構建。 |
| `PIWEB_SKIP_INSTALL_BUILD` | 未設定 | `1` 跳過生產安裝的首次自愈構建。只給已經自帶封存構建的部署使用。 |
| `PIWEB_BUILD_VERBOSE` | 未設定 | `1` / `true` / `yes` 列印完整構建輸出。 |

#### 可選限制

這些開關預設關閉或上限較寬鬆，不設定時不會改變既有行為。

| 變數 | 預設值 | 含義 |
| --- | --- | --- |
| `PIWEB_FS_STRICT_WORKSPACES` | 關閉 | `1` / `true` / `yes` 將已認證的檔案介面限制在已註冊工作區或 `PIWEB_FS_ALLOWED_ROOTS` 之內。 |
| `PIWEB_FS_ALLOWED_ROOTS` | 空 | 嚴格模式額外允許的根目錄，Windows 用 `;` 分隔，POSIX 用 `:`。 |
| `PIWEB_MAX_SESSION_SUBSCRIBERS` | 不限制 | 每個會話的 SSE 訂閱者上限（正整數）；超出後新訂閱改為快照模式。 |
| `PIWEB_SSE_MAX_BUFFERED_BYTES` | `4MiB` | 單條 SSE 連線的未讀緩衝上限；慢客戶端會被斷開，隨後應重連並走快照。 |
| `PIWEB_SHUTDOWN_TIMEOUT_MS` | `8000` | 收到 SIGINT / SIGTERM / SIGHUP 後等待停機鉤子的預算。第二次訊號會立即退出。 |
| `PIWEB_GRACEFUL_STOP_TIMEOUT_MS` | `10000` | 啟動器等待自己拉起的子行程退出的時間，超時後結束行程樹。 |
| `PIWEB_AGENT_MAX_STEPS` | 不限制 | 單回合最多模型步數。 |
| `PIWEB_AGENT_MAX_DURATION_MS` | 不限制 | 單回合最長執行時間（毫秒）。 |
| `PIWEB_AGENT_TOKEN_BUDGET` | 不限制 | 單回合累計 token 上限（input + output + cache）。 |
| `PIWEB_MOBILE_PROXY_MAX_HTML_BYTES` | `16MiB` | 手機代理 HTML 注入緩衝上限；超過則改為不注入、直接流式透傳。 |
| `PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES` | `64MiB` | 手機代理解壓輸出上限；更大的響應返回 502。 |
| `PIWEB_MOBILE_PROXY_TIMEOUT_MS` | `30000` | 手機代理等待上游 HTML 響應的時間，超時後改為不注入、直接流式透傳。 |
| `PIWEB_AGENT_CONFIG_CACHE_MAX` | `512` | agent 配置快取條目上限。 |
| `PIWEB_AGENT_CONFIG_CACHE_TTL_MS` | `1800000`（30 分鐘） | 上述快取中失敗或缺失條目的 TTL。 |
| `PIWEB_PI_CACHE_MAX` | `512` | SettingsManager / 資源載入器 / 包管理器的快取條目上限。 |

#### 測試、CI 與內部變數

不要在部署中使用這些變數。`CI`、`PIWEB_COVERAGE`、`PIWEB_COVERAGE_REPORT_DIR`、`PIWEB_TEST_REPORT`、`PIWEB_TEST_TUNNEL` 和 `PIWEB_LINT_SKIP_INSTALL` 僅用於測試和 CI。

啟動器、鎖和測試還會注入：`PI_WEB_LAUNCH_TOKEN`（一次性本機登入令牌，每次啟動重新生成）、`PIWEB_PORT`（寫入子行程的實際連接埠）、`PIWEB_HTTP_GUARD`、`PIWEB_BUILD_LOCK_FILE` / `PIWEB_BUILD_LOCK_TOKEN`、`PIWEB_PROCESS_LOCK_FILE` / `PIWEB_PROCESS_LOCK_TOKEN`、`PIWEB_PROXY_SOURCE`、`PIWEB_INHERITED_HTTP_PROXY` / `PIWEB_INHERITED_HTTPS_PROXY`、`PIWEB_MANAGED_NODE_USE_ENV_PROXY`、`PIWEB_MANAGED_NO_PROXY`、`PIWEB_DEV_ASSET_ID`、`PIWEB_DISABLE_GRACEFUL_SHUTDOWN`、`PIWEB_DEBUG_PROMPT`，以及 `PIWEB_BROWSER_URL`（在 Windows 上開啟本機瀏覽器時的臨時地址）。`PYTHONUTF8` / `PYTHONIOENCODING`、`NODE_OPTIONS`、`NEXT_PHASE`、`NEXT_RUNTIME` 和 `NEXT_TELEMETRY_DISABLED` 屬於程序或 Next.js 約定（建置腳本會關閉 Next 遙測）。

PiWeb 還會讀取 `HOME`、`USERPROFILE`、`TEMP` / `TMP`、`APPDATA`、`LOCALAPPDATA` 等作業系統路徑變數，以及可選的 `WORKBUDDY_CONFIG_DIR` 和 `QWEN_HOME`（用於對應的會話匯入來源）。

</details>

## 工作原理

PiWeb 是基於 Next.js 16 + React 19 的 TypeScript 應用，封裝了官方 `@earendil-works/pi-*` SDK。`piweb` 命令（`bin/piweb.js` → `scripts/launcher.mjs`）會選擇空閒連接埠、生成一次性啟動令牌、拉起 Next.js 服務，並開啟本機登入地址。服務將令牌兌換為經 HMAC 簽名的會話 Cookie；在生產模式且認證開啟時，還會準備區域網入口和 Cloudflare 快速隧道。

PiWeb 不會取代單獨安裝的 `pi` CLI。兩者**共用同一個 agent 目錄**（預設 `~/.pi/agent`，或由 `PI_CODING_AGENT_DIR` 指定）。該目錄是主要儲存，但不是唯一資料根——會話匯入會讀取家目錄下其他工具的歷史，全域性技能可能位於 `~/.agents/skills`。詳見[資料、隱私與留存](docs/operations/data-and-privacy.md)。

## 說明文件

- [安裝與建置](docs/operations/install-and-build.md)
- [環境變數參考](docs/operations/environment.md)
- [資料、隱私與留存](docs/operations/data-and-privacy.md)
- [發布、降級與回滾](docs/operations/release-and-rollback.md)
- [擴充功能 Web UI](docs/extension-web-ui.md) 與[擴充功能範例](examples/piweb-extensions/README.md)
- 文件導覽：[docs/README.md](docs/README.md)

## 貢獻

歡迎在 [github.com/RexVane/PiWeb](https://github.com/RexVane/PiWeb) 提交 issue 和 pull request。開發環境、專案結構、提交前檢查和問題反饋方式見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 致謝

天青、粉霞配色感謝 [@webkubor](https://github.com/webkubor)。上游專案與參考來源見 [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)。依賴許可證見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 授權條款

[MIT](LICENSE)
