# verify-evidence — 原始证据（对应 `verify-plugin-install.md`）

所有文件都是 2026-11-13 实跑时由临时 harness 写出、原样复制过来的；临时目录 `%TEMP%\piweb-verify-plugin\` 已清理。

## A. 插件安装端到端（`verify-plugin-install.md` §2）

| 文件 | 对应实验 | 关键内容 |
|---|---|---|
| `a1.json` | A1：`installPackage("npm:acme-pi-plugin")` | 安装前缀 `<agentDir>/npm`、settings `{"packages":["npm:acme-pi-plugin"]}`、postinstall marker 原文、`listPackages` 识别结果 |
| `a2.json` | A2：本地目录 source | 只写一条相对路径 settings；无 npm 目录、无 marker、无复制 |
| `a3.json` | A3：postinstall 失败 | 报错原文、marker 已写、settings 未创建、npm 前缀只剩 `package.json`+`.gitignore` |
| `a4.json` | A4：同 cwd 两路并发 | 两路 begin/end 毫秒，串行证据 |
| `a5.json` | A5：不同 cwd 两路并发 | 同上（共享 `<agentDir>/npm`） |
| `a6.json` | A6：project（local:true） | `<cwd>/.pi/settings.json` + `<cwd>/.pi/npm` |
| `a7-readonly-get-installs.json` | A7：只读列表触发安装（P2-75） | `listSkills` 2.58 s 内完成真实 npm 安装 + postinstall |
| `npm-argv.log` | PATH 垫片捕获的真实 npm argv | 无 `--ignore-scripts`；`--prefix` 路径按作用域不同 |
| `npm-registry-requests.log` | harness 内 127.0.0.1 临时 registry | 全程只有本机请求，无外网 |
| `vitest-plugin-install.log` | 完整 vitest 输出 | `7 passed` |

## B. 技能删除越界 P1-10（`verify-plugin-install.md` §3）

| 文件 | 对应实验 | 关键内容 |
|---|---|---|
| `b0-rm-junction.json` | B0：机制对照 | `fs.rm(junction)` 只删链接，目标文件仍在 |
| `b1-junction-dir.json` | B1：junction 技能目录 → 外部仓库 | `removed=外部目录`，删除后外部树为空，坏 junction 残留 |
| `b2-nested-skill.json` | B2：目标目录含嵌套技能 | `nestedSkillDiscovered=false`；整目录（含 `inner/SKILL.md`）被删 |
| `b3-others-block.json` | B3：第二个技能被单独发现 | `others` 生效，只删外部 `SKILL.md`，`.git`/`inner` 保留 |
| `vitest-skill-delete.log` | 完整 vitest 输出 | `4 passed` |

## 隔离证明

| 文件 | 内容 |
|---|---|
| `real-agent-before.json` / `real-agent-after.json` | 真实 `C:\Users\guica\.pi\agent` 前后快照：settings SHA256 一致、npm/skills 条目一致、无 fixture 包 |
