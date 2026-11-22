"use client";
import { ResourceFrame } from "@/components/resources/ResourceFrame";
import { useResourceRegistry, type ResourceRegistry } from "@/hooks/useResourceRegistry";
import { useI18n } from "@/i18n";
import type { ResourceScope, WebResourceView } from "@/lib/resources/protocol";

interface SettingsPackage {
	source: string;
	scope: ResourceScope;
	installedPath?: string;
	disabled?: boolean;
}
interface SettingsExtension {
	path: string;
	disabled?: boolean;
	error?: string;
	sourceInfo?: { source: string; scope: string; origin: string };
}

function ownsExtension(item: SettingsPackage, member: ResourceRegistry["packages"][number], extension: SettingsExtension): boolean {
	if (extension.sourceInfo?.source !== item.source || extension.sourceInfo.scope !== item.scope || extension.sourceInfo.origin !== "package") return false;
	const windowsPath = /^[a-z]:[\\/]/i.test(item.installedPath ?? extension.path) || /^\\\\/.test(item.installedPath ?? extension.path);
	const normalize = (value: string) => {
		const result = value.replaceAll("\\", "/").replace(/\/+$/, "");
		return windowsPath ? result.toLowerCase() : result;
	};
	const path = normalize(extension.path);
	return member.extensionPaths.some(relative => item.installedPath
		? path === normalize(`${item.installedPath}/${relative}`)
		: path.endsWith(`/${normalize(relative)}`));
}

/** Package identity is Pi's configured source and scope, including collection members. */
export function packageSettingsViews(item: SettingsPackage, registry: Pick<ResourceRegistry, "packages" | "views">, extensions: SettingsExtension[]): WebResourceView[] {
	if (item.disabled) return [];
	const members = registry.packages.filter(member => member.source === item.source && member.scope === item.scope && member.enabled && !member.error);
	return members.flatMap(member => {
		const owned = extensions.filter(extension => ownsExtension(item, member, extension));
		if (owned.some(extension => extension.error) || (owned.length > 0 && owned.every(extension => extension.disabled))) return [];
		return registry.views.filter(view => view.resourceId === member.id && view.scope === member.scope && view.placement === "settings" && !view.preview);
	});
}

export function PackageResourceSettings(props: { item: SettingsPackage; extensions: SettingsExtension[]; cwd: string }) {
	return <PackageResourceSettingsBody key={`${props.cwd}:${props.item.scope}:${props.item.source}`} {...props} />;
}

function PackageResourceSettingsBody({ item, extensions, cwd }: { item: SettingsPackage; extensions: SettingsExtension[]; cwd: string }) {
	const registry = useResourceRegistry(cwd);
	const { lang } = useI18n();
	if (!registry.loaded || registry.registryCwd !== cwd || registry.error) return null;
	const views = packageSettingsViews(item, registry, extensions);
	if (views.length === 0) return null;
	return <div className="mt-2 flex min-w-0 flex-col gap-3">
		{views.map(view => <section key={view.id} className="min-w-0" aria-label={view.titles?.[lang] ?? view.title}>
			<ResourceFrame key={`${cwd}:${view.id}:${view.url}`} view={view} cwd={cwd} />
		</section>)}
	</div>;
}
