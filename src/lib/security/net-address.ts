/**
 * 公网地址判断（模型目录探测与浏览器工具共用）：
 * IPv4 排除回环 / 私网 / 运营商 NAT / 链路本地 / 文档 / 组播等保留网段；IPv6 只认全球单播 2000::/3，并排除文档、6to4 等。
 */
import { BlockList, isIP } from "node:net";

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
	["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(address, prefix, "ipv4");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const blockedIpv6 = new BlockList();
for (const [address, prefix] of [
	["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
] as const) blockedIpv6.addSubnet(address, prefix, "ipv6");

/** 字面 IP 是否公网地址；不是合法 IP（主机名等）一律返回 false */
export function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !blockedIpv4.check(address, "ipv4");
	if (family === 6) return globalIpv6.check(address, "ipv6") && !blockedIpv6.check(address, "ipv6");
	return false;
}
