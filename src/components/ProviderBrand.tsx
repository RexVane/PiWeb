import { providerIconSlug, providerInitials } from "@/lib/provider-display";

export function ProviderBrand({ id, name, size = 36 }: { id: string; name: string; size?: number }) {
	const slug = providerIconSlug(id);
	return (
		<span
			aria-hidden="true"
			className="inline-flex flex-none items-center justify-center overflow-hidden"
			style={{
				width: size,
				height: size,
				borderRadius: Math.max(10, Math.round(size * 0.3)),
				background: "#f7f7f5",
				border: "0.5px solid rgba(0,0,0,.09)",
				color: "#18191b",
				fontSize: Math.max(10, Math.round(size * 0.32)),
				fontWeight: 750,
				letterSpacing: "-0.03em",
			}}
		>
			{slug ? (
				<img src={`/provider-icons/${slug}.svg`} alt="" width={Math.round(size * 0.66)} height={Math.round(size * 0.66)} />
			) : (
				providerInitials(name, id)
			)}
		</span>
	);
}
