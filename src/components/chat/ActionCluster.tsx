"use client";

import { memo } from "react";
import type { ClusterKind } from "@/lib/process-phases";

/** 阶段动作微点：最多 3 枚间距排布的低饱和 6px 语义色点（无重叠叠圆） */
export const ActionCluster = memo(function ActionCluster({ kinds, compact = false }: { kinds: ClusterKind[]; compact?: boolean }) {
	if (!kinds.length) return null;
	return (
		<span className="pw-cluster" data-compact={compact || undefined} aria-hidden="true">
			{kinds.map((kind) => (
				<span key={kind} className="pw-cluster-dot" data-cluster={kind} />
			))}
		</span>
	);
});
