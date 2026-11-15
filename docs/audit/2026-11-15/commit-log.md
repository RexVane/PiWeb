# 修复轮提交记录（仅提交修复轮新增/修改且修复前无旧改动的文件）

- 当前 HEAD：`4a6a59e2941eac2047f94a9eea8d5caac0226f9b`
- 可提交文件（ours）：73；未提交混合文件：136；删除但未提交：0

## G1 — `5e7c2544c7e4a0fca55fb7150154b3aa940f63e9` — fix(security): redact exports, harden auth, input validation and child-process env
- files: 22
  - `.gitignore`
  - `src/app/api/config/route.ts`
  - `src/app/api/fs/route.ts`
  - `src/app/api/git/route.ts`
  - `src/app/api/sessions/[id]/export/route.ts`
  - `src/lib/api-error.ts`
  - `src/lib/child-process-env.ts`
  - `src/lib/pi-settings.ts`
  - `src/lib/secret-redaction.ts`
  - `src/lib/settings-write-lock.ts`
  - `tests/api/config-route.test.ts`
  - `tests/api/fs-validation.test.ts`
  - `tests/api/git-route-guard.test.ts`
  - `tests/api/pi-settings-concurrency.test.ts`
  - `tests/api/session-export-redaction.test.ts`
  - `tests/api/session-export.test.ts`
  - `tests/api/workspaces-validation.test.ts`
  - `tests/auth.test.ts`
  - `tests/lib/api-error.test.ts`
  - `tests/lib/child-process-env.test.ts`
  - `tests/lib/secret-redaction.test.ts`
  - `tests/settings-write-lock.test.ts`

## G2 — `3d64847eb6fb789b99e87704ab785f0e080131b1` — fix(stability): durable writes, graceful shutdown, bounded caches, SSE backpressure and readiness
- files: 30
  - `bin/pi.js`
  - `scripts/process-runner.mjs`
  - `src/app/api/agent/[id]/events/route.ts`
  - `src/app/api/health/readiness/route.ts`
  - `src/lib/agent-config.ts`
  - `src/lib/atomic-file.ts`
  - `src/lib/git-service.ts`
  - `src/lib/graceful-shutdown.ts`
  - `src/lib/jsonc-settings-storage.ts`
  - `src/lib/npm-install-transaction.ts`
  - `src/lib/path-boundary.ts`
  - `src/lib/path-security.ts`
  - `src/lib/pi.ts`
  - `src/lib/remote/supervisor.ts`
  - `tests/agent-config-cache.test.ts`
  - `tests/agent-manager-budget.test.ts`
  - `tests/api/health-readiness.test.ts`
  - `tests/api/session-delete-attachments.test.ts`
  - `tests/events-backpressure.test.ts`
  - `tests/files-service-editor-env.test.ts`
  - `tests/git-service-env.test.ts`
  - `tests/launcher-graceful-stop.test.ts`
  - `tests/lib/atomic-file-durability.test.ts`
  - `tests/lib/path-security-boundary.test.ts`
  - `tests/models-service-configured-credential-signal.test.ts`
  - `tests/pi-supervise.test.ts`
  - `tests/remote-mobile-proxy-limits.test.ts`
  - `tests/remote-supervisor.test.ts`
  - `tests/session-reader-pagination.test.ts`
  - `tests/update-service-process.test.ts`

## G3 — `91c6b3699273c453b04787bdcf25df4bed3ecead` — test(ci): repair test baseline, add pinned lint toolchain and CI gates
- files: 15
  - `.github/workflows/check.yml`
  - `.github/workflows/publish.yml`
  - `.github/workflows/remote-e2e.yml`
  - `eslint.config.mjs`
  - `package.json`
  - `scripts/build.mjs`
  - `scripts/testing/check-skips.mjs`
  - `scripts/testing/lint/eslint.config.mjs`
  - `scripts/testing/lint/package-lock.json`
  - `scripts/testing/lint/package.json`
  - `scripts/testing/lint/run.mjs`
  - `tests/api/github-version-routes.test.ts`
  - `tests/check-skips.test.ts`
  - `tests/i18n.test.ts`
  - `tests/package-files-policy.test.ts`

## G4 — `ceb4de203cfadbf23f7c31bfd58e4e440b5ac348` — docs: align guides with current behavior, add operations runbooks and third-party notices
- files: 11
  - `.github/RELEASING.md`
  - `THIRD-PARTY-NOTICES.md`
  - `docs/README.md`
  - `docs/operations/README.md`
  - `docs/operations/data-and-privacy.md`
  - `docs/operations/environment.md`
  - `docs/operations/install-and-build.md`
  - `docs/operations/release-and-rollback.md`
  - `docs/planning/requirements.md`
  - `docs/planning/technical-design.md`
  - `docs/workspace-isolation.md`

## G5 — `86c5f177cc6a303d88625f563dc2499460ac8d92` — chore: remove unreachable skills/prompts workspace views and market copy
- files: 1
  - `tests/components/workspace-resource-lifecycle.test.tsx`

## 未提交（按用户选择保留在工作区待 review）

- 修复前已有旧改动、本轮又修改过的文件（混合）：136
  - `?? .audit-2026-11-14/growth-recording/`
  - `?? .audit-2026-11-15/`
  - ` D AGENTS.md`
  - ` M README.md`
  - ` M README_zh.md`
  - ` M backups/INDEX.md`
  - ` M docs/state/progress.md`
  - ` M next.config.ts`
  - ` M scripts/launcher.mjs`
  - `?? scripts/proxy-env.d.mts`
  - `?? scripts/proxy-env.mjs`
  - ` M scripts/release.mjs`
  - ` M src/app/api/agent/new/route.ts`
  - ` M src/app/api/growth/route.ts`
  - ` M src/app/api/models/route.ts`
  - ` M src/app/api/pi-settings/route.ts`
  - ` D src/app/api/plugins/marketplace/route.ts`
  - ` M src/app/api/sessions/[id]/route.ts`
  - ` M src/app/api/sessions/route.ts`
  - ` M src/app/api/web-auth/route.ts`
  - ` M src/app/api/workspaces/route.ts`
  - ` M src/app/globals.css`
  - ` M src/app/layout.tsx`
  - ` M src/app/login/page.tsx`
  - ` M src/app/pair/route.ts`
  - ` M src/components/AppShell.tsx`
  - ` M src/components/ChatInput.tsx`
  - ` M src/components/ChatWindow.tsx`
  - ` M src/components/ConfirmDialog.tsx`
  - ` M src/components/ContextMeter.tsx`
  - ` M src/components/CustomSelect.module.css`
  - ` M src/components/DrawerPanel.tsx`
  - ` M src/components/FileViewer.tsx`
  - ` M src/components/GitPanel.tsx`
  - ` M src/components/ModelSelector.module.css`
  - ` M src/components/ProjectPanel.tsx`
  - ` M src/components/RemoteSection.tsx`
  - ` M src/components/SessionSidebar.tsx`
  - ` M src/components/SettingsPanel.tsx`
  - `?? src/components/chat/web-sources.tsx`
  - ` M src/components/composer/PermissionSelector.module.css`
  - ` M src/components/icons.tsx`
  - ` M src/components/settings/GeneralSection.tsx`
  - ` M src/components/settings/ModelsSection.tsx`
  - ` D src/components/settings/PluginMarketplace.tsx`
  - ` M src/components/settings/PluginsSection.tsx`
  - ` M src/components/settings/SharedControls.tsx`
  - ` M src/components/settings/SkillsSection.tsx`
  - ` M src/components/workspace/AutomationModal.tsx`
  - ` M src/components/workspace/AutomationsWorkspaceView.tsx`
  - ` M src/components/workspace/SkillsPluginsViews.tsx`
  - ` M src/components/workspace/WorkspaceViewShell.tsx`
  - `?? src/hooks/useAttentionNotifications.ts`
  - ` M src/hooks/useFileViewer.ts`
  - ` M src/hooks/usePiWeb.ts`
  - ` M src/i18n.tsx`
  - ` M src/lib/agent-manager.ts`
  - `?? src/lib/archived-sessions-sort.ts`
  - `?? src/lib/attention-notify.ts`
  - ` M src/lib/auth.ts`
  - ` M src/lib/automations/runner.ts`
  - ` M src/lib/automations/store.ts`
  - ` M src/lib/automations/types.ts`
  - ` M src/lib/execution-guidance.ts`
  - ` M src/lib/files-service.ts`
  - ` M src/lib/growth-service.ts`
  - ` M src/lib/growth-tracker.ts`
  - ` M src/lib/models-service.ts`
  - ` D src/lib/plugins-marketplace.ts`
  - ` M src/lib/remote/mobile-proxy.ts`
  - `?? src/lib/runtime-proxy.ts`
  - ` M src/lib/sandbox/windows-acl.ts`
  - ` M src/lib/session-reader.ts`
  - ` D src/lib/session-retention.ts`
  - ` M src/lib/theme.ts`
  - ` M src/lib/types.ts`
  - ` M src/lib/web-auth.ts`
  - `?? src/lib/web-search.ts`
  - ` M src/lib/workspace-store.ts`
  - ` M src/proxy.ts`
  - ` M tests/agent-prompt-acceptance.test.ts`
  - `?? tests/api/agent-new-options.test.ts`
  - ` M tests/api/pi-settings-refresh.test.ts`
  - ` M tests/api/read-route-errors.test.ts`
  - ` M tests/api/resource-route-errors.test.ts`
  - ` M tests/api/session-workspaces.test.ts`
  - `?? tests/cold-session-thinking.test.ts`
  - ` M tests/components/app-shell-composer-isolation.test.tsx`
  - `?? tests/components/app-shell-file-tabs.test.tsx`
  - `?? tests/components/attention-notifications.test.tsx`
  - ` M tests/components/chatwindow-compaction.test.tsx`
  - `?? tests/components/chatwindow-web-search.test.tsx`
  - ` M tests/components/context-meter.test.tsx`
  - `?? tests/components/file-viewer-session-state.test.tsx`
  - ` M tests/components/general-settings-retry.test.tsx`
  - ` M tests/components/growth-project-panel.test.tsx`
  - ` M tests/components/login-page.test.tsx`
  - `?? tests/components/new-session-options.test.tsx`
  - `?? tests/components/optimistic-prompt-and-new-session.test.tsx`
  - ` D tests/components/plugin-marketplace-lifecycle.test.tsx`
  - ` M tests/components/plugins-section-state.test.tsx`
  - ` M tests/components/remote-section.test.tsx`
  - `?? tests/components/session-archive-time-state.test.tsx`
  - ` M tests/components/session-model-catalog.test.tsx`
  - ` M tests/components/settings-confirm-dialog.test.tsx`
  - ` M tests/components/settings-dialog-keyboard.test.tsx`
  - ` M tests/components/settings-model-roundtrip.test.tsx`
  - ` M tests/components/settings-tools-session.test.tsx`
  - ` M tests/components/settings-typography.test.tsx`
  - ` M tests/components/settings-usage-card.test.tsx`
  - `?? tests/components/sidebar-archive-time.test.tsx`
  - ` M tests/components/sidebar-menus.test.tsx`
  - ` M tests/components/workspace-nav-automations.test.tsx`
  - ` D tests/components/workspace-views-prompts-market.test.tsx`
  - ` M tests/compose-prompt.test.ts`
  - ` M tests/growth-service.test.ts`
  - ` M tests/growth-tracker-failures.test.ts`
  - ` M tests/growth-tracker.test.ts`
  - ` M tests/launcher.test.ts`
  - `?? tests/lib/sandbox/desktop-and-denial-fallback.test.ts`
  - ` M tests/models-service-auth.test.ts`
  - ` D tests/plugins-marketplace.test.ts`
  - ` M tests/plugins-npm-transaction.test.ts`
  - ` M tests/proxy-auth.test.ts`
  - ` M tests/remote-pair.test.ts`
  - `?? tests/runtime-proxy.test.ts`
  - ` M tests/session-import-service.test.ts`
  - ` M tests/session-model-runtime.test.ts`
  - ` M tests/session-reader.test.ts`
  - ` M tests/session-retention-scheduler.test.ts`
  - ` M tests/session-retention.test.ts`
  - ` M tests/source-encoding.test.ts`
  - ` M tests/use-piweb-events.test.ts`
  - `?? tests/web-search.test.ts`
  - ` M tests/workspace-store.test.ts`
  - ` M tsconfig.json`
- 删除但未提交：0
- 未分组 leftover：1
  - `tests/api/sessions-pagination.test.ts`

- 提交后 HEAD：`86c5f177cc6a303d88625f563dc2499460ac8d92`；工作区剩余状态条数：137

## 修订（2026-11-15 22:14，amend 后最终状态）

- G5 已 amend 为 `687e44c9a...`（完整：`687e44c692c18fe2d41baefb450b5da62ae3e181`），并入 `tests/api/sessions-pagination.test.ts`，共 2 个文件；原 `86c5f17...` 不再存在于历史。
- 上面“未分组 leftover”小节已失效：sessions-pagination 测试已随 G5 提交，当前无 clean leftover。
- 最终 5 个 commit：`5e7c254`、`3d64847`、`91c6b36`、`ceb4de2`、`687e44c`，合计 80 个文件。
- 提交后 HEAD：`687e44c692c18fe2d41baefb450b5da62ae3e181`；工作区剩余状态 136 条 = 修复前既有改动（含 23 个“混合文件”）+ C5 源文件改动（SkillsPluginsViews/i18n/删除的 prompts 测试）。

## 追加提交（2026-11-15 22:22，用户确认后提交剩余工作区）

用户确认 review 后“一起提交”，把剩余 135 条工作区改动提交为 2 个 commit，工作区变干净：

| commit | 主题 | 文件数 |
|---|---|---|
| `2ba56ee392601f094b1c8b91b39cd262259159bb` | fix(audit): land remaining audit fixes in files that also carried pre-existing edits | 25（23 个混合文件 + SkillsPluginsViews + 删除的 prompts 死视图测试） |
| `66c7c4482c082b2763c194743e59e18db641b890` | chore: commit remaining pre-existing working-tree changes | 160（既有 WIP 功能/测试、.audit 证据目录、市场与 session-retention 删除等） |

- 提交后 `git status --short` = **0 条**（工作区干净）；`tsc` exit 0；`npm run lint` exit 0（0 error / 29 warning）。
- 已 push 到 `fork/main`（RexVane/PiWeb）：`1d4efba..66c7c44 main -> main`，共 13 个本地 commit 推送（含此前 6 个未推的本地提交 + 本轮 7 个）。
- 推送触发的 GitHub Actions：check run `43724228000`（https://github.com/RexVane/PiWeb/actions/runs/43724228000）、remote connection run `43724227991`；windows-latest 复跑记录见 `ci-windows-acl.md` / `ci-windows-acl-status.log`。
