/**
 * 服务启动钩子：「远程连接」内置插件的局域网入口在这里拉起。
 *
 * 为什么必须在这里：局域网入口要「默认就在跑」（手机连同一个 WiFi 就能用），
 * 而 Next 的请求处理里没有「服务刚起来」这个时机 —— instrumentation 的 register()
 * 是官方给的入口，而且它返回前服务不会开始处理请求。
 *
 * Next 会把本文件按 nodejs 和 edge 各编译一份。Node 专用的代码只能写在
 * `=== "nodejs"` 的分支里再 import：edge 那份里条件是常量 false，webpack 整段跳过。
 * 写成「不是 nodejs 就 return，后面再 import」不行 —— webpack 照样解析后面的 import，
 * edge 编译碰到 node:child_process 就报错，dev 下所有页面跟着 500。
 */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { registerNode } = await import("./instrumentation-node");
		await registerNode();
	}
}
