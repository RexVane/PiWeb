/**
 * opencode：`~/.local/share/opencode/opencode.db`（与 ZCode 同源的表结构）。
 */
import { opencodeDb } from "./paths";
import { createOcFamilySource } from "./oc-family";

export const opencodeSource = createOcFamilySource("opencode", opencodeDb);
