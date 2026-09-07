import { VERSION as PI_ENGINE_VERSION } from "@earendil-works/pi-coding-agent";
import appManifest from "../../package.json";

export function getRuntimeVersions(): Promise<{ piWeb: string; piEngine: string }> {
	return Promise.resolve({ piWeb: appManifest.version, piEngine: PI_ENGINE_VERSION });
}
