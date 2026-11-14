import { describe, expect, it, beforeEach } from "vitest";
import { PAIR_TTL_MS, PairingError, issuePairCode, pendingPairCount, refreshPairCode, resetPairingState, verifyPairCode } from "@/lib/remote/pairing";

beforeEach(() => resetPairingState());

describe("pairing codes", () => {
	it("issues a 256-bit random credential that can be redeemed exactly once", () => {
		const { code, expiresAt } = issuePairCode(1_000);
		expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(code, "base64url")).toHaveLength(32);
		expect(expiresAt).toBe(1_000 + PAIR_TTL_MS);
		expect(verifyPairCode(code, 2_000)).toEqual({ ok: true });
		expect(verifyPairCode(code, 2_000)).toEqual({ ok: false, reason: "unknown" });
		expect(pendingPairCount()).toBe(0);
	});

	it("expires after the TTL", () => {
		const { code } = issuePairCode(1_000);
		expect(verifyPairCode(code, 1_000 + PAIR_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
	});

	it("rejects malformed input without touching state", () => {
		expect(verifyPairCode("", 0)).toEqual({ ok: false, reason: "unknown" });
		expect(verifyPairCode("12345", 0)).toEqual({ ok: false, reason: "unknown" });
		expect(verifyPairCode("abcdef", 0)).toEqual({ ok: false, reason: "unknown" });
	});

	it("rate-limits issuing and caps pending codes", () => {
		// 同一时间窗内最多发 6 个（每发一个就兑换掉，pending 不会先顶到上限）
		for (let index = 0; index < 6; index += 1) {
			const { code } = issuePairCode(1_000 + index);
			expect(verifyPairCode(code, 1_000 + index)).toEqual({ ok: true });
		}
		expect(() => issuePairCode(2_000)).toThrow(PairingError);
		// 待兑换数量到上限（3 个）时直接拒绝，不用等到限流
		resetPairingState();
		issuePairCode(1_000);
		issuePairCode(1_000);
		issuePairCode(1_000);
		expect(() => issuePairCode(1_000)).toThrow(/too-many-pending/);
	});

	it("drops expired codes on the next issue", () => {
		issuePairCode(1_000);
		issuePairCode(1_000);
		issuePairCode(1_000);
		expect(pendingPairCount()).toBe(3);
		issuePairCode(1_000 + PAIR_TTL_MS + 1);
		expect(pendingPairCount()).toBe(1);
	});

	it("reuses a visible QR credential during polling and replaces it after use or expiry", () => {
		const first = refreshPairCode(undefined, 1_000);
		for (let index = 0; index < 30; index += 1) expect(refreshPairCode(first.code, 2_000 + index)).toEqual(first);
		for (let index = 0; index < 20; index += 1) expect(refreshPairCode(undefined, 2_100 + index)).toEqual(first);
		expect(pendingPairCount()).toBe(1);
		expect(verifyPairCode(first.code, 3_000)).toEqual({ ok: true });
		const second = refreshPairCode(first.code, 4_000);
		expect(second.code).not.toBe(first.code);
		const third = refreshPairCode(second.code, second.expiresAt);
		expect(third.code).not.toBe(second.code);
		expect(pendingPairCount()).toBe(1);
	});

	it("throttles invalid guesses without letting anonymous traffic lock out a valid QR", () => {
		const current = issuePairCode(1_000);
		for (let index = 0; index < 30; index += 1) expect(verifyPairCode("000000", 2_000)).toEqual({ ok: false, reason: "unknown" });
		expect(verifyPairCode("000001", 2_001)).toMatchObject({ ok: false, reason: "rate-limited", retryAfterSeconds: 60 });
		expect(verifyPairCode(current.code, 2_002)).toEqual({ ok: true });
		expect(verifyPairCode("000001", 62_000)).toEqual({ ok: false, reason: "unknown" });
	});
	it("rejects pending credentials issued before another process committed all-device logout", () => {
		const old = issuePairCode(1_000);
		expect(verifyPairCode(old.code, 2_000, 1_500)).toMatchObject({ ok: false });
		const current = issuePairCode(2_000, 1_500);
		expect(verifyPairCode(current.code, 2_001, 1_500)).toEqual({ ok: true });
	});
	it("does not reuse a prior generation and preserves issue and anonymous attempt limits", () => {
		const previous = issuePairCode(1_000);
		for (let index = 0; index < 30; index++) verifyPairCode("bad", 1_001);
		const current = refreshPairCode(previous.code, 2_000, 1_500);
		expect(current.code).not.toBe(previous.code);
		expect(refreshPairCode(undefined, 2_001, 1_500)).toEqual(current);
		expect(pendingPairCount()).toBe(1);
		expect(verifyPairCode("bad", 2_001, 1_500)).toMatchObject({ ok: false, reason: "rate-limited" });
		expect(verifyPairCode(current.code, 2_002, 1_500)).toEqual({ ok: true });
		for (let index = 0; index < 4; index++) {
			const next = issuePairCode(3_000 + index, 1_500);
			expect(verifyPairCode(next.code, 3_001 + index, 1_500)).toEqual({ ok: true });
		}
		expect(() => issuePairCode(4_000, 1_500)).toThrow("rate-limited");
	});
	it("binds codes issued during a pending logout to the older generation", () => {
		const inFlight = issuePairCode(2_000, 0);
		expect(verifyPairCode(inFlight.code, 2_001, 1_500)).toMatchObject({ ok: false });
		const sameMillisecond = refreshPairCode(undefined, 2_000, 2_001);
		expect(verifyPairCode(sameMillisecond.code, 2_000, 2_001)).toEqual({ ok: true });
	});
});
