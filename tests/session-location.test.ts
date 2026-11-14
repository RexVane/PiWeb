// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { savedSessionLocation, storeSessionLocation } from "../src/lib/chat/session-location";

beforeEach(() => { sessionStorage.clear(); history.replaceState(null, "", "/"); });
it("uses a unicode deep link independently of the first sidebar page", () => {
	storeSessionLocation("D:\\项目\\very-old-session.jsonl");
	expect(savedSessionLocation(false)).toBe("D:\\项目\\very-old-session.jsonl");
});
it("does not revive the saved session when navigating back to the home URL", () => {
	storeSessionLocation("D:\\a.jsonl");
	history.replaceState(null, "", "/");
	expect(savedSessionLocation(false)).toBeNull();
	expect(savedSessionLocation()).toBe("D:\\a.jsonl");
});
it("rejects invalid URL data without falling back to another session", () => {
	sessionStorage.setItem("piweb.currentSession", "D:\\a.jsonl"); history.replaceState(null, "", "/?session=invalid%25");
	expect(savedSessionLocation()).toBeNull();
});
