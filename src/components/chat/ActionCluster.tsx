"use client";

import { memo } from "react";
import {
	IconEditOutline16,
	IconGlobeOutline14,
	IconSearchOutline16,
	IconSparkOutline14,
	IconTerminalOutline14,
} from "@/components/icons";
import type { ClusterKind } from "@/lib/process-phases";

function ClusterGlyph({ kind }: { kind: ClusterKind }) {
	switch (kind) {
		case "think":
			return <IconSparkOutline14 size={11} />;
		case "inspect":
			return <IconSearchOutline16 size={11} />;
		case "exec":
			return <IconTerminalOutline14 size={11} />;
		case "mutate":
			return <IconEditOutline16 size={11} />;
		case "web":
			return <IconGlobeOutline14 size={11} />;
	}
}

/** 行动簇微图标：最多叠放 3 个真实反映该组/该轮动作类型的低饱和微色小圆标 */
export const ActionCluster = memo(function ActionCluster({ kinds }: { kinds: ClusterKind[] }) {
	if (!kinds.length) return null;
	return (
		<span className="pw-cluster" aria-hidden="true">
			{kinds.map((kind) => (
				<span key={kind} className="pw-cluster-dot" data-cluster={kind}>
					<ClusterGlyph kind={kind} />
				</span>
			))}
		</span>
	);
});
