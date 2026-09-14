/**
 * 从 material-icon-theme（MIT）抽一份常用文件/文件夹图标子集到 public/file-icons/，
 * 并生成 src/lib/file-icons.json（扩展名 / 文件名 / 文件夹名 → 图标 id 的精简映射）。
 * 项目树与文件查看器按映射取 /file-icons/<id>.svg，未命中回落到通用 file / folder。
 * 用法：npm run sync:file-icons
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "node_modules", "material-icon-theme");
const target = path.join(root, "public", "file-icons");
const manifest = JSON.parse(await readFile(path.join(pkg, "dist", "material-icons.json"), "utf8"));

/** 扩展名（不含点，小写）；多段扩展如 d.ts / test.ts 也在 fileExtensions 表里 */
const EXTENSIONS = [
	"ts", "tsx", "d.ts", "test.ts", "spec.ts", "test.tsx", "js", "jsx", "mjs", "cjs", "test.js", "spec.js",
	"json", "jsonc", "json5", "jsonl", "md", "mdx", "markdown", "txt", "rtf", "log",
	"py", "pyi", "pyc", "ipynb", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cpp", "cc", "hpp", "cs", "fs",
	"css", "scss", "sass", "less", "styl", "html", "htm", "vue", "svelte", "astro", "php", "ejs", "hbs", "pug", "liquid",
	"sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
	"yml", "yaml", "toml", "ini", "cfg", "conf", "env", "xml", "plist", "properties",
	"svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif", "psd", "ai",
	"mp3", "wav", "flac", "ogg", "mp4", "mkv", "mov", "webm", "avi",
	"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "tsv",
	"zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz",
	"sql", "db", "sqlite", "sqlite3", "lock", "wasm", "lua", "r", "dart", "ex", "exs", "erl", "hs", "ml", "clj", "scala", "groovy", "gradle",
	"tf", "tfvars", "hcl", "proto", "graphql", "gql", "prisma", "sol", "vim", "jl", "m", "mm", "pl", "nim", "zig", "v", "elm", "vala",
	"cshtml", "razor", "cmake", "mk", "ninja", "nix", "bicep", "pem", "key", "crt", "cer", "pub", "ttf", "otf", "woff", "woff2", "eot",
	"map", "patch", "diff", "asm", "s", "wat", "glsl", "hlsl", "shader", "unity", "prefab", "blend", "obj", "fbx", "stl", "gltf",
	"ttl", "rdf", "owl", "tex", "bib", "org", "adoc", "rst", "po", "pot", "mo", "ics", "vcf", "gpg", "asc", "sig", "torrent",
];

/** 完整文件名（小写） */
const FILE_NAMES = [
	"package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "tsconfig.json", "tsconfig.base.json", "jsconfig.json",
	".gitignore", ".gitattributes", ".gitmodules", ".gitkeep", ".editorconfig", ".npmrc", ".nvmrc", ".prettierrc", ".prettierignore", ".eslintrc", ".eslintrc.js", ".eslintrc.json",
	"eslint.config.js", "eslint.config.mjs", "vitest.config.ts", "vitest.config.mts", "vite.config.ts", "vite.config.js", "next.config.ts", "next.config.js", "next.config.mjs",
	"tailwind.config.js", "tailwind.config.ts", "postcss.config.js", "postcss.config.mjs", "babel.config.js", ".babelrc", "jest.config.js", "jest.config.ts",
	"webpack.config.js", "rollup.config.js", "rollup.config.mjs", "tsup.config.ts", "turbo.json", "nx.json", "lerna.json", "vercel.json", "netlify.toml",
	"dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", ".dockerignore", "makefile", "cmakelists.txt", "justfile", "taskfile.yml",
	"readme.md", "readme", "license", "license.md", "license.txt", "changelog.md", "changelog", "contributing.md", "code_of_conduct.md", "security.md", "authors", "codeowners",
	".env", ".env.local", ".env.example", ".env.development", ".env.production", ".env.test",
	"cargo.toml", "cargo.lock", "go.mod", "go.sum", "pyproject.toml", "requirements.txt", "requirements-dev.txt", "poetry.lock", "uv.lock", "pipfile", "pipfile.lock", "setup.py", "setup.cfg", "tox.ini", "pytest.ini",
	"gemfile", "gemfile.lock", "rakefile", "composer.json", "composer.lock", "build.gradle", "build.gradle.kts", "settings.gradle", "pom.xml", "mix.exs", "deno.json", "deno.jsonc",
	"agents.md", "claude.md", ".cursorrules", "robots.txt", "sitemap.xml", "manifest.json", "favicon.ico", "index.html", "index.js", "index.ts", ".gitlab-ci.yml", "jenkinsfile", ".travis.yml", "procfile", "now.json", "renovate.json", ".releaserc", "commitlint.config.js", ".huskyrc", ".lintstagedrc", "nodemon.json", "pm2.config.js", "ecosystem.config.js",
];

/** 文件夹名（小写），展开态用 <id>-open */
const FOLDER_NAMES = [
	"src", "source", "lib", "libs", "components", "component", "hooks", "utils", "util", "helpers", "helper", "api", "apis", "app", "apps", "pages", "public", "static", "assets", "images", "image", "img", "icons", "icon",
	"styles", "style", "css", "scss", "sass", "less", "fonts", "font", "test", "tests", "__tests__", "spec", "specs", "e2e", "docs", "doc", "documentation", "scripts", "script", "bin", "build", "dist", "out", "output", "release",
	"node_modules", ".git", ".github", ".gitlab", ".vscode", ".idea", ".husky", "config", "configs", "configuration", "settings", "types", "typings", "@types", "interfaces", "models", "model", "entities", "controllers", "controller",
	"services", "service", "middleware", "middlewares", "routes", "router", "routers", "views", "view", "layouts", "layout", "templates", "template", "data", "database", "db", "migrations", "migration", "seeds", "seed",
	"server", "client", "shared", "common", "core", "plugins", "plugin", "extensions", "extension", "packages", "package", "modules", "module", "tools", "tooling", "examples", "example", "demo", "demos", "samples", "sample",
	"vendor", "vendors", "third_party", "third-party", "temp", "tmp", "cache", ".cache", "logs", "log", "locale", "locales", "i18n", "lang", "langs", "translations", "media", "video", "videos", "audio", "sounds",
	"python", "java", "rust", "android", "ios", "web", "mobile", "desktop", "backend", "frontend", "functions", "lambda", "cloud", "aws", "azure", "gcp", "docker", "k8s", "kubernetes", "terraform", "ci", ".circleci", "workflows",
	"store", "stores", "redux", "context", "contexts", "providers", "provider", "state", "prisma", "supabase", "generated", "gen", "proto", "schemas", "schema", "contracts", "contract", "tasks", "task", "jobs", "job", "queue", "workers", "worker",
	"mock", "mocks", "__mocks__", "fixtures", "fixture", "stories", "benchmark", "benchmarks", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo", ".venv", "venv", "env", "__pycache__", ".pytest_cache", ".mypy_cache", "target",
	"notebooks", "notebook", "ml", "models", "datasets", "dataset", "features", "feature", "domain", "infra", "infrastructure", "deploy", "deployment", "deployments", "environments", "environment", "secrets", "keys", "certs", "certificates",
	"docs-site", "website", "site", "blog", "content", "posts", "admin", "auth", "user", "users", "account", "accounts", "payment", "payments", "billing", "cart", "checkout", "product", "products", "order", "orders", "search", "chat", "messages",
	"ui", "widgets", "widget", "elements", "element", "primitives", "atoms", "molecules", "organisms", "theme", "themes", "design", "designs", "graphics", "graphql", "gql", "rest", "grpc", "socket", "sockets", "websocket", "events", "event", "listeners",
	"resources", "resource", "res", "raw", "wasm", "native", "cpp", "c", "include", "includes", "headers", "objects", "obj", "debug", "dll", "libraries", "library", "framework", "frameworks", "sdk", "cli", "commands", "command", "console",
	"history", "archive", "archives", "backup", "backups", "old", "legacy", "deprecated", "draft", "drafts", "review", "reviews", "meta", "metadata", "manifest", "manifests", "spec-files", "requirements", "tasks-old", "todo",
	"pi", ".pi", "skills", "skill", "prompts", "prompt", "agents", "agent", "memory", "sessions", "session",
];

const defs = manifest.iconDefinitions ?? {};
const has = (id) => typeof id === "string" && Boolean(defs[id]);
const used = new Set();
const ext = {};
const name = {};
const folder = {};
const lower = (s) => s.toLowerCase();

for (const e of EXTENSIONS) {
	const id = manifest.fileExtensions?.[lower(e)];
	if (has(id)) {
		ext[lower(e)] = id;
		used.add(id);
	}
}
for (const n of FILE_NAMES) {
	const id = manifest.fileNames?.[lower(n)];
	if (has(id)) {
		name[lower(n)] = id;
		used.add(id);
	}
}
for (const f of FOLDER_NAMES) {
	const id = manifest.folderNames?.[lower(f)];
	const openId = manifest.folderNamesExpanded?.[lower(f)] ?? (id ? `${id}-open` : undefined);
	if (has(id) && has(openId)) {
		folder[lower(f)] = id;
		used.add(id);
		used.add(openId);
	}
}
const defaults = { file: manifest.file ?? "file", folder: manifest.folder ?? "folder", folderOpen: manifest.folderExpanded ?? "folder-open" };
for (const id of Object.values(defaults)) {
	if (!has(id)) throw new Error(`material-icon-theme missing default icon ${id}`);
	used.add(id);
}

await mkdir(target, { recursive: true });
let copied = 0;
for (const id of used) {
	const rel = String(defs[id].iconPath ?? `./../icons/${id}.svg`).replace(/^\.\/\.\.\//, "");
	await copyFile(path.join(pkg, rel), path.join(target, `${id}.svg`));
	copied += 1;
}
await copyFile(path.join(pkg, "LICENSE"), path.join(target, "LICENSE"));

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const json = { defaults, ext: sortKeys(ext), name: sortKeys(name), folder: sortKeys(folder) };
await writeFile(path.join(root, "src", "lib", "file-icons.json"), `${JSON.stringify(json, null, "\t")}\n`, "utf8");
console.log(`Synced ${copied} file icons (${Object.keys(ext).length} extensions, ${Object.keys(name).length} file names, ${Object.keys(folder).length} folders).`);
