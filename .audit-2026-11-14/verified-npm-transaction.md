# npm 插件安装树事务核验与修复

日期：2026-11-14。依据 `rev-plugins.md:61`、已安装 pi SDK 1.5.2 和本机 npm 11.6.2。此项是真实问题，已经修复，不再列为未实现的边界。没有操作用户现有插件，没有重启在线 PiWeb，没有覆盖在线构建。

## 核验与处理

原 SDK 直接在用户 `agentDir/npm` 或项目 `.pi/npm` 修改依赖树。npm Arborist 先 reify，再保存 package.json / lock；后期写入失败并不保证还原整个旧树。测试使用真实离线 tarball 和 npm，在 PackageJson.save 注入 EACCES：失败发生时 stage 中已经是 2.0.0，证明该风险不只是模拟 npm 返回非零退出码。

现在 install、update、remove 在受管 prefix 的同级私有 stage 执行。stage 复制完整旧树、锁文件和包内修改，不通过重建 manifest 让无关依赖浮动。复制只遍历受管 npm prefix，不扫描整个工作区；不递归跟随外部符号链接，硬链接复制成独立文件，内部链接在提交时重新定位。操作前后比较内容摘要，发现旧树被其他写者修改便拒绝覆盖。

SDK 的 getNpmInstallRoot 在 ensureNpmProject 前即返回 stage，getManagedNpmInstallPath 也映射 stage。git/local 源及其作用域保持原语义；npm mutating 命令统一追加 `--ignore-scripts`。没有修改 node_modules 中的 SDK 或全局 process.env。安装后的资源刷新失败保留已经提交的安装，并返回 applied warning。

配置事务只管理本次 packages / disabledPackages 字段。SDK 写入前验证旧值，提交前核验持久化结果，回滚保留主题等无关配置。停用列表中存在、但 packages 字段原本缺省的包可以卸载，不制造无意义的 packages:[]。恢复入口在 SDK resolve 获取配置快照前运行，必要时 reload SettingsManager；所以卸载中断留下空列表也不会漏掉恢复。

## 中断与错误语义

- 共同提交决定持久化以前失败：保留原安装，恢复本次配置字段；失败 stage 保留以便诊断或恢复。
- 用户与项目同时更新时使用共同 decision 和每个 scope 的 journal。决定提交后不会再次翻转为回滚；目录提升、索引或记录清理中断时，下一次任意成员恢复入口完成整组提交。
- 提交未完成返回明确 pending 状态和恢复提示；已全部提交、仅清理记录失败返回 applied 警告。不能把“提交决定后的故障”描述为全部回到旧版本。
- 旧代与失败 stage 保留在 prefix 同级目录，恢复位置只追加到同级 backups/INDEX.md，不自动删除这些恢复材料。

Windows 使用内核独占 mutex，长异步复制/npm期间持续持有从盘符到安装父目录的句柄；进程退出后内核释放锁，无须靠 PID 存活推断或超时偷锁。同目录原生 rename 的共享错误带 Node error code，设置保存仍可有限重试；普通全局设置在原生能力不可用时保留普通文件系统回退。项目写入继续要求目录边界保护。

恢复只认可调用者提供的当前 user/project scopes，不信任磁盘声明的任意 root。协调文件父目录、peer journal ID、当前成员 ID、项目边界均验证；外部 scope、被替换成 junction 的 `.pi`、链接/硬链接 INDEX 均拒绝。INDEX 已存在时不使用 O_CREAT，缺省时 O_EXCL，打开后再核验 fd 与路径的 bigint 文件身份，不跟随竞态创建的链接写出内容。

## 验证证据

| 文件 | 结果及覆盖 |
|---|---|
| `npm-transaction-initial.json` | 初期 7 项通过；真实 npm late EACCES、真实进程退出、内容冲突和链接复制。 |
| `npm-transaction-integration-first.json` | 5 文件 68 项通过；SDK/service/scope/settings 初次集成。 |
| `npm-transaction-final-candidate.json` | 2 文件 18 项通过；共同提交恢复、settings 中断、同进程待恢复、伪造 scope/junction 拒绝、SDK install/update/remove。 |
| `npm-transaction-final.json` / `.log` | 8 文件 101 passed / 0 failed / 0 skipped，93.10 秒。包含事务、SDK集成、插件、safe manager、项目设置、提示词及设置作用域。 |
| `npm-transaction-closure.json` / `.log` | 最后改动后 3 文件 47 passed / 0 failed / 0 skipped，50.00 秒。真实双 scope 进程中断后仅从一个入口恢复两边；真实卸载中断后首次 SDK resolve 恢复旧技能；INDEX创建竞态；Windows异步阶段祖先改名拒绝和实际文件占用错误码；真实npm晚期保存失败。 |
| `npm-transaction-types-final.log` | 最后 `npx tsc --noEmit --incremental false` exit 0。 |

上述批次重叠，不相加当作整仓数量。`npm-transaction-index-final` 保留中间失败过程：最初竞争fixture试图在受保护父目录内新建硬链接，Windows先拒绝该操作；后改为实际可发生的普通INDEX创建竞争，最终47项已通过。真实文件硬链接攻击另由既有专项验证。测试自建目录均由 recycleFixture 送回收站，未清理用户原文件。

## 保留的边界

本机为 Windows，真实 Linux/macOS 恢复、POSIX flock 和同设备挂载攻击链尚未实机验证。当前 workspace 之外的历史跨 scope 事务不会根据磁盘声明擅自恢复，需重新打开原 workspace。受管 prefix 有 300,000 条目 / 20 GiB 复制上限，超过后拒绝并保留旧安装。阶段复制需要额外磁盘空间，恢复材料由用户决定清理。已持久化共同决定不等于所有外部读者能同时看到两次文件系统重命名；PiWeb 的受管入口会先完成恢复，其他绕过 PiWeb 的读者不在这个提交协调协议内。

源码已冻结，完整共享工作区 coverage、生产构建、搬迁安装及真实 HTTP 插件安装/更新/卸载验收由主 Agent 和发布 Agent继续执行。
