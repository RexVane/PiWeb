/**
 * ZCode：`~/.zcode/cli/db/db.sqlite`（session / message / part 三表）。
 * 与 opencode 共用适配器，差异只在库路径与排序字段。
 */
import { zcodeDb } from "./paths";
import { createOcFamilySource } from "./oc-family";

export const zcodeSource = createOcFamilySource("zcode", zcodeDb);
