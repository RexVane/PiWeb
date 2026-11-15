# 第三方组件与许可证说明（THIRD-PARTY NOTICES）

PiWeb 本体以 MIT 许可证发布，全文见仓库根目录的 [LICENSE](./LICENSE)。
本文件列出分发包（npm 包 `@rexvane/piweb`：`src/`、`bin/`、`scripts/`、`public/`、`assets/`、预构建 `.next/` 及其依赖声明）
中使用到的第三方组件，以及它们的许可证、来源与获取方式。

> 本文件是合规信息汇总，不构成法律意见；最终使用以各组件自身的许可证原文为准。
> 数据基线：仓库 HEAD 的 `package-lock.json`（lockfileVersion 3，508 个包条目），
> 由审计脚本逐包读取 `node_modules/<pkg>/package.json` 的 `license` 字段与 lock 字段核对；
> 审计证据目录已随 2026-11-15 收尾清理移出工作区，结论见 [审计归档](docs/audit/2026-11-15/report-final.md)。

## 1. 总体情况

- PiWeb 自身：MIT（`package.json` 的 `"license": "MIT"`，`LICENSE` 首行为 `MIT License`）。
- 依赖树许可证分布（按包条目计）：MIT 357、Apache-2.0 78、BSD-3-Clause 17、ISC 17、MPL-2.0 12、
  LGPL-3.0-or-later 10、Apache-2.0 AND LGPL-3.0-or-later 3、BlueOak-1.0.0 3、MIT-0 2、0BSD 2、
  BSD-2-Clause 2、Apache-2.0 AND LGPL-3.0-or-later AND MIT 1、CC-BY-4.0 1、
  (BSD-3-Clause AND Apache-2.0) 1、Unlicense 1、CC0-1.0 1；无 GPL/AGPL，无未知/缺失许可证条目。
- 绝大多数依赖的许可证原文随包分发在 `node_modules/<包名>/LICENSE*`（或 `COPYING`/`NOTICE`）中；
  也可以按下文“获取方式”从 npm registry 或上游仓库取得。

## 2. 需要随分发提供说明的组件（copyleft / 数据许可）

### 2.1 LGPL-3.0-or-later：sharp 的 libvips 原生库

`next` 的图片优化依赖 `sharp`，其预编译原生库以独立可选包按平台安装（lock 版本）：

| 包 | 版本 | 许可证 |
|---|---|---|
| `@img/sharp-libvips-darwin-arm64` / `-darwin-x64` | 1.3.4 | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-arm` / `-arm64` / `-ppc64` / `-riscv64` / `-s390x` / `-x64` | 1.3.4 | LGPL-3.0-or-later |
| `@img/sharp-libvips-linuxmusl-arm64` / `-x64` | 1.3.4 | LGPL-3.0-or-later |
| `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT |
| `@img/sharp-win32-arm64` / `-win32-ia32` / `-win32-x64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later |

- 来源：sharp-libvips（https://github.com/lovell/sharp-libvips）、libvips（https://github.com/libvips/libvips）；
  sharp 预编译包发布在 npm（`https://registry.npmjs.org/@img/sharp-libvips-<platform>/1.3.4`）。
- PiWeb 不修改这些原生库；它们是动态链接的共享库，由 Node 在运行时按需加载。
- 对应源码获取：上述上游仓库的对应 tag/版本，或 npm 包内 `versions.json` 记录的
  libvips 版本（含依赖与构建选项）——可从 https://github.com/lovell/sharp-libvips/releases 下载。
- LGPL 权利：如果安装环境需要自行替换/重新链接 libvips，可直接用自建的同 ABI 共享库替换
  `node_modules/@img/sharp-libvips-<platform>/lib/` 下的库文件，或重新安装由发行版/自建的 `sharp`；
  PiWeb 不阻止该替换。恢复原状只需重新执行 `npm install`。

### 2.2 MPL-2.0：lightningcss

Tailwind CSS v4 / PostCSS 构建链使用 `lightningcss`（及其平台二进制，lock 版本 1.33.0）：

- `lightningcss`、`lightningcss-android-arm64`、`-darwin-arm64`、`-darwin-x64`、`-freebsd-x64`、
  `-linux-arm-gnueabihf`、`-linux-arm64-gnu`、`-linux-arm64-musl`、`-linux-x64-gnu`、`-linux-x64-musl`、
  `-win32-arm64-msvc`、`-win32-x64-msvc`：MPL-2.0。
- 来源：https://github.com/parcel-bundler/lightningcss ；npm：`https://registry.npmjs.org/lightningcss/1.33.0`。
- MPL-2.0 只覆盖其源文件本身；PiWeb 没有修改它们。被 MPL 覆盖文件的源码即上述上游仓库对应版本，
  可从 npm tarball 或上游 tag 取得。发布物中的许可证原文见 `node_modules/lightningcss/LICENSE`。

### 2.3 CC-BY-4.0：caniuse-lite

`caniuse-lite`（lock 版本 1.0.30001826，浏览器兼容性数据，经 browserslist 供 Tailwind 使用）：

- 许可证：CC-BY-4.0（数据许可，不是代码 copyleft）。
- 来源：https://github.com/browserslist/caniuse-lite ，数据源自 https://caniuse.com ；
  npm：`https://registry.npmjs.org/caniuse-lite/1.0.30001826`。
- 归属声明：浏览器兼容性数据 © caniuse.com 贡献者，以 CC-BY-4.0 发布；PiWeb 原样使用、未修改。
  许可证原文：https://creativecommons.org/licenses/by/4.0/legalcode 。

### 2.4 其它 permissive 组件

其余依赖为 MIT / Apache-2.0 / BSD / ISC / 0BSD / MIT-0 / Unlicense / CC0-1.0 / BlueOak-1.0.0 等宽松许可证，
其许可证文本随 npm 包分发，无需额外随附声明，但保留版权与许可声明（见各包 `LICENSE`）。
其中 Apache-2.0 组件（如 `next` 自身、`@earendil-works/*` 的部分传递依赖）如需 `NOTICE` 文件，
可在对应包目录中查看。

## 3. 获取方式（复核与再生成）

1. 许可证原文：安装后直接读取 `node_modules/<包名>/LICENSE*`；或从 npm registry 下载对应版本的
   tarball：`https://registry.npmjs.org/<包名>/-/<包名>-<版本>.tgz`（完整性哈希见 `package-lock.json`
   的 `integrity` 字段，本项目 lock 中全部 https 依赖都有 integrity）。
2. 版本清单：以 `package-lock.json` 为唯一事实来源；升级依赖时本文件需同步更新。
3. 重新生成许可证清单（不新增依赖）：
   ```bash
   node -e "const l=require('./package-lock.json');for(const[k,v]of Object.entries(l.packages||{}))if(v.license)console.log(k,v.version,v.license)"
   ```
4. 如分发形式包含完整 `node_modules`（例如离线安装包），上述许可证原文会随之分发；
   npm 包本体（`.next` 预构建）不再重复内联这些文本，但保留本文件作为指引。

---

维护提示：新增/升级依赖时检查是否引入 copyleft（GPL/AGPL/LGPL/MPL/EPL 等）或数据许可（CC-BY 等），
有则在第 2 节补一行，并确认发布物（npm 包/离线包/二进制分发）满足对应许可证的源码与声明要求。
