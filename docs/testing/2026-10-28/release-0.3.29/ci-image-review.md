# 发布 PR #49 的图片接口回归

第一轮同一提交 `84e2f1e` 的 push／PR 两套 CI 共 8 项检查，7 项通过；PR 的 Ubuntu / Node 24 在伪装 PNG 用例中实际返回 500，预期 400。[原始 CI 日志](ci-first-ubuntu24-failure.log)未打印响应正文，因此单凭它不能断定具体错误码。

后续排查确认一个能够产生相同结果的进程竞态：普通目录中的 `git check-ignore` 可以先关闭 stdin，再以 128 退出并写出 `not a git repository`。原 `close` 处理优先抛出管道 EPIPE，掩盖 Git 的真实错误；图片入口因此不能识别普通目录，正常 PNG 也可能失败。

仅调整 `files-service.ts` 的错误优先级：Git 非 0／1 退出保留 stderr；成功的 0／1 退出仍要求 stdin 完整。没有把未知失败当作“未忽略”，没有放宽路径、内容签名、大小、Git 隐藏项或 SVG 限制。

新增可控子进程时序并配合真实文件／接口调用的回归：修前正常 PNG 应 200 实 500、伪装 PNG 应 400 实 500、仓库权限错误正文被 EPIPE 盖住，共 3 失败、9 通过；修后图片接口 12 项和既有子进程测试 2 项全部通过，类型检查通过。原有真实 Git 忽略项和真实文件验证仍保留，0／1 退出但输入不完整继续返回 500，unsafe repository 仍返回 500 并报告真实原因。

- [修前失败](image-git-pipe-red.log)
- [相关 14 项通过](image-git-pipe-green.log)
- [类型检查](image-git-pipe-typecheck.log)
- [修复后完整 check](check-ci-final.log)
- [带真实 fd 的最终完整测试](test-ci-final-with-fd.log)
- [最终构建安装验证](verify-package-ci-final.log)

首个修复后 check 未把隔离下载的 fd 加入 PATH，因此真实 fd 对照额外跳过了一项；最终补上 PATH 后重新运行全部测试，不把该跳过算作通过。最终数字和安装包以[版本验收记录](README.md)为准。
