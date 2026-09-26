import { describe, expect, it } from "vitest";
import { beginActivity, beginMaintenance, RuntimeBusyError } from "../src/lib/runtime-activity";

describe("runtime maintenance gate", () => {
  it.each(["session", "swarm", "tests"] as const)("blocks maintenance while %s work is active", (kind) => {
    const release = beginActivity(kind);
    try { expect(() => beginMaintenance()).toThrow(RuntimeBusyError); }
    finally { release(); }
    const finish = beginMaintenance();
    finish();
  });

  it("atomically prevents every work kind and a second update during maintenance", () => {
    const release = beginMaintenance();
    try {
      for (const kind of ["session", "swarm", "tests"] as const) expect(() => beginActivity(kind)).toThrow(RuntimeBusyError);
      expect(() => beginMaintenance()).toThrow(RuntimeBusyError);
    } finally { release(); }
    const activity = beginActivity("tests");
    activity();
  });

  it("keeps leases independent and makes old release callbacks idempotent", () => {
    const first = beginActivity("session");
    const second = beginActivity("session");
    first();
    first();
    expect(() => beginMaintenance()).toThrow(RuntimeBusyError);
    second();
    const finish = beginMaintenance();
    finish();
    const next = beginMaintenance();
    finish();
    try { expect(() => beginActivity("swarm")).toThrow(RuntimeBusyError); }
    finally { next(); }
  });
});
