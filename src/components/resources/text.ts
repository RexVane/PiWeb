"use client";
import { useI18n } from "@/i18n";

const en = {
	retry: "Retry",
	featuredExtensions: "Recommended PiWeb extensions",
	designDirectory: "Development folder (not installed)", designDirectoryHint: "This is where the source is saved. Install it with Pi only when you’re ready.", designWorkspace: "Extension design workspace", continueDesign: "Continue designing",
	advancedOptions: "Advanced options",
	pickLocalDirectory: "Choose local folder",
	nativeInstallHint: "Pi manages Git and npm install locations. Local packages stay in their original folder.",
	market: "Resource market", installed: "Installed", installExisting: "Install an existing resource", design: "Design your own", designHint: "Start a new session in an independent resource workspace", installHint: "Browse the market, enter a source or install locally",
	piwebMarket: "PiWeb market", piResources: "Pi extensions", sourceTab: "Link / local", piGallery: "Open the Pi package gallery", piGalleryHint: "Find a Pi package, then paste its npm, Git or local source here. Terminal-only interfaces may need adaptation.",
	web: "Web ready", adapt: "Needs web adaptation", unknown: "Compatibility not confirmed", check: "Check compatibility", adaptInstall: "Adapt before installing", checkedHint: "Static review only; this does not prove a package is safe or every feature works on the web.",
	developmentRoot: "Resource source directory", chooseDirectory: "Choose directory", source: "npm / Git / local source", scope: "Installation scope", user: "All workspaces", project: "This workspace", creating: "Preparing workspace…", startDesign: "Start designing", install: "Install", installing: "Installing…", cancel: "Cancel", close: "Close", refresh: "Refresh", search: "Search resources", all: "All", extensions: "Extensions", skills: "Skills", prompts: "Prompt templates",
	trustWarning: "Extensions run with the host's system permissions. Review the source before installing. Skills and templates can also instruct the agent to run commands.", marketUnavailable: "Some catalogs are unavailable. You can still install by source or locally.", empty: "No resources found", unavailable: "Not published yet", frameFailed: "The resource interface is unavailable.", basicInterface: "Use the basic interface", renderer: "Default interaction interface", basic: "Built-in basic interface", panels: "Resource interfaces", openPanel: "Open", preview: "Preview interface", previewHint: "Previewing an interface is different from executing its actions.", operationFailed: "Resource operation failed", inspectFirst: "Check before installing", startAdapt: "Start adaptation", directoryHint: "Source files stay here; installing a local package references this directory. It is separate from the installation scope.", retained: "Prepared source is retained in its workspace if preparation fails.",
} as const;
type Text = { [K in keyof typeof en]: string };
const zh: Text = {
	retry: "重试",
	featuredExtensions: "PiWeb 推荐扩展",
	designDirectory: "开发目录（不安装）", designDirectoryHint: "这里只保存源码，完成后再按 Pi 原生方式手动安装。", designWorkspace: "扩展设计工作区", continueDesign: "继续设计",
	advancedOptions: "高级选项",
	pickLocalDirectory: "选择本地目录",
	nativeInstallHint: "Git 和 npm 包按 Pi 原生规则安装；本地包直接引用原目录，不复制。",
	market: "资源市场", installed: "已安装", installExisting: "安装已有扩展", design: "自己设计", designHint: "在独立的资源工作区开启新会话", installHint: "从市场、链接或本地安装",
	piwebMarket: "PiWeb 市场", piResources: "Pi 扩展", sourceTab: "链接 / 本地", piGallery: "打开 Pi 官方包目录", piGalleryHint: "找到 Pi 包后，在此输入 npm、Git 或本地来源。终端专用界面可能需要网页适配。",
	web: "网页可用", adapt: "需要网页适配", unknown: "兼容性未确认", check: "检查兼容性", adaptInstall: "适配后安装", checkedHint: "这里只做静态检查，不代表扩展安全，也不保证所有功能都能在网页运行。",
	developmentRoot: "资源源码保存目录", chooseDirectory: "选择目录", source: "npm / Git / 本地来源", scope: "安装范围", user: "所有工作区", project: "仅当前工作区", creating: "正在准备工作区…", startDesign: "开始设计", install: "安装", installing: "正在安装…", cancel: "取消", close: "关闭", refresh: "刷新", search: "搜索资源", all: "全部", extensions: "扩展", skills: "技能", prompts: "提示词模板",
	trustWarning: "扩展拥有宿主的系统权限，请审查来源后安装。技能和提示词也可能指示 Agent 执行命令。", marketUnavailable: "部分市场清单暂时不可用，仍可从链接或本地安装。", empty: "没有找到资源", unavailable: "尚未发布", frameFailed: "扩展界面暂时不可用。", basicInterface: "使用基础界面", renderer: "默认交互界面", basic: "内置基础界面", panels: "资源界面", openPanel: "打开", preview: "预览界面", previewHint: "预览界面不等于执行其中的操作。", operationFailed: "资源操作失败", inspectFirst: "安装前检查", startAdapt: "开始适配", directoryHint: "源码长期保存在这里；本地安装引用此目录。它与安装范围分别设置。", retained: "准备失败时，已取得的源码仍保留在独立工作区。",
};
const hant: Text = { ...zh,
	retry: "重試",
	featuredExtensions: "PiWeb 推薦擴充功能",
	designDirectory: "開發目錄（不安裝）", designDirectoryHint: "這裡只儲存原始碼，完成後再依 Pi 原生方式手動安裝。", designWorkspace: "擴充功能設計工作區", continueDesign: "繼續設計",
	advancedOptions: "進階選項",
	pickLocalDirectory: "選擇本機資料夾",
	nativeInstallHint: "Git 和 npm 套件依 Pi 原生規則安裝；本機套件直接參照原始目錄，不複製。",
	market: "資源市場", installed: "已安裝", installExisting: "安裝現有擴充功能", design: "自行設計", designHint: "在獨立資源工作區開啟新對話", installHint: "從市場、連結或本機安裝", piResources: "Pi 擴充功能", sourceTab: "連結 / 本機", piGallery: "開啟 Pi 官方套件目錄", piGalleryHint: "找到 Pi 套件後，在此輸入 npm、Git 或本機來源。終端專用介面可能需要網頁適配。", web: "網頁可用", adapt: "需要網頁適配", unknown: "相容性未確認", check: "檢查相容性", adaptInstall: "適配後安裝", checkedHint: "僅進行靜態檢查，不代表擴充功能安全，也不保證所有功能能在網頁執行。", developmentRoot: "資源原始碼目錄", chooseDirectory: "選擇目錄", source: "npm / Git / 本機來源", scope: "安裝範圍", project: "僅目前工作區", creating: "正在準備工作區…", startDesign: "開始設計", install: "安裝", installing: "正在安裝…", close: "關閉", refresh: "重新整理", search: "搜尋資源", extensions: "擴充功能", prompts: "提示詞範本", trustWarning: "擴充功能擁有宿主的系統權限，請審查來源後安裝。技能與提示詞也可能指示 Agent 執行命令。", marketUnavailable: "部分市場清單暫時不可用，仍可從連結或本機安裝。", empty: "找不到資源", unavailable: "尚未發佈", frameFailed: "擴充功能介面暫時不可用。", basicInterface: "使用基本介面", renderer: "預設互動介面", basic: "內建基本介面", panels: "資源介面", openPanel: "開啟", preview: "預覽介面", previewHint: "預覽介面不等於執行其中的操作。", operationFailed: "資源操作失敗", inspectFirst: "安裝前檢查", startAdapt: "開始適配", directoryHint: "原始碼長期保存在此；本機安裝引用此目錄，與安裝範圍分開設定。", retained: "準備失敗時，已取得的原始碼仍保留在獨立工作區。",
};
const ja: Text = {
	retry: "再試行",
	featuredExtensions: "PiWeb おすすめ拡張",
	designDirectory: "開発フォルダー（未インストール）", designDirectoryHint: "ここにはソースのみを保存します。完成後に Pi で手動インストールしてください。", designWorkspace: "拡張開発ワークスペース", continueDesign: "設計を続ける",
	advancedOptions: "詳細オプション",
	pickLocalDirectory: "ローカルフォルダーを選択",
	nativeInstallHint: "Git と npm のインストール先は Pi が管理します。ローカルパッケージは元のフォルダーをそのまま使います。",
	market: "リソース市場", installed: "インストール済み", installExisting: "既存の拡張をインストール", design: "自分で設計", designHint: "独立したワークスペースで新しいセッションを開始", installHint: "市場、リンク、ローカルからインストール", piwebMarket: "PiWeb 市場", piResources: "Pi 拡張", sourceTab: "リンク / ローカル", piGallery: "Pi パッケージ一覧を開く", piGalleryHint: "Pi パッケージを探し、npm・Git・ローカルのソースを入力してください。端末専用 UI は Web 対応が必要です。", web: "Web 対応", adapt: "Web 対応が必要", unknown: "互換性未確認", check: "互換性を確認", adaptInstall: "対応してからインストール", checkedHint: "静的検査のみです。安全性や全機能の Web 動作を保証しません。", developmentRoot: "リソースのソース保存先", chooseDirectory: "フォルダを選択", source: "npm / Git / ローカルソース", scope: "インストール範囲", user: "全ワークスペース", project: "現在のワークスペースのみ", creating: "ワークスペースを準備中…", startDesign: "設計を開始", install: "インストール", installing: "インストール中…", cancel: "キャンセル", close: "閉じる", refresh: "更新", search: "リソースを検索", all: "すべて", extensions: "拡張", skills: "スキル", prompts: "プロンプトテンプレート", trustWarning: "拡張はホストのシステム権限で実行されます。ソースを確認してください。スキルやプロンプトも命令の実行を指示できます。", marketUnavailable: "一部の一覧を取得できません。リンクやローカルからはインストール可能です。", empty: "リソースがありません", unavailable: "未公開", frameFailed: "拡張 UI を利用できません。", basicInterface: "基本 UI を使用", renderer: "既定の対話 UI", basic: "内蔵の基本 UI", panels: "リソース UI", openPanel: "開く", preview: "UI をプレビュー", previewHint: "UI のプレビューと操作の実行は異なります。", operationFailed: "リソース操作に失敗しました", inspectFirst: "インストール前に確認", startAdapt: "Web 対応を開始", directoryHint: "ソースはここに保存され、ローカルインストールはこのパスを参照します。インストール範囲とは別の設定です。", retained: "準備に失敗した場合も、取得済みソースは専用ワークスペースに残ります。",
};
const ru: Text = {
	retry: "Повторить",
	featuredExtensions: "Рекомендуемые расширения PiWeb",
	designDirectory: "Папка разработки (без установки)", designDirectoryHint: "Здесь сохраняется только исходный код. Готовое расширение можно установить вручную через Pi.", designWorkspace: "Рабочая папка расширения", continueDesign: "Продолжить разработку",
	advancedOptions: "Дополнительные настройки",
	pickLocalDirectory: "Выбрать локальную папку",
	nativeInstallHint: "Расположением пакетов Git и npm управляет Pi. Локальные пакеты остаются в исходной папке.",
	market: "Каталог ресурсов", installed: "Установлено", installExisting: "Установить расширение", design: "Создать своё", designHint: "Начать сеанс в отдельной рабочей папке", installHint: "Установить из каталога, по ссылке или локально", piwebMarket: "Каталог PiWeb", piResources: "Расширения Pi", sourceTab: "Ссылка / локально", piGallery: "Открыть каталог пакетов Pi", piGalleryHint: "Найдите пакет Pi и укажите источник npm, Git или локальный путь. Терминальный интерфейс может требовать адаптации.", web: "Готово для Web", adapt: "Нужна Web-адаптация", unknown: "Совместимость не подтверждена", check: "Проверить совместимость", adaptInstall: "Адаптировать и установить", checkedHint: "Только статическая проверка: безопасность и работа всех функций не гарантируются.", developmentRoot: "Папка исходников ресурсов", chooseDirectory: "Выбрать папку", source: "Источник npm / Git / локальный", scope: "Область установки", user: "Все рабочие папки", project: "Текущая рабочая папка", creating: "Подготовка папки…", startDesign: "Начать создание", install: "Установить", installing: "Установка…", cancel: "Отмена", close: "Закрыть", refresh: "Обновить", search: "Поиск ресурсов", all: "Все", extensions: "Расширения", skills: "Навыки", prompts: "Шаблоны запросов", trustWarning: "Расширения имеют системные права хоста. Проверьте исходники. Навыки и шаблоны также могут предписывать выполнение команд.", marketUnavailable: "Часть каталогов недоступна. Установка по ссылке и локально доступна.", empty: "Ресурсы не найдены", unavailable: "Ещё не опубликовано", frameFailed: "Интерфейс ресурса недоступен.", basicInterface: "Основной интерфейс", renderer: "Интерфейс взаимодействия", basic: "Встроенный основной интерфейс", panels: "Интерфейсы ресурсов", openPanel: "Открыть", preview: "Предпросмотр интерфейса", previewHint: "Предпросмотр интерфейса не означает выполнение его действий.", operationFailed: "Ошибка действия ресурса", inspectFirst: "Проверить перед установкой", startAdapt: "Начать адаптацию", directoryHint: "Исходники хранятся здесь; локальная установка ссылается на эту папку. Область установки задаётся отдельно.", retained: "При сбое подготовки полученные исходники остаются в отдельной рабочей папке.",
};
export function useResourceText(): Text {
	const { lang } = useI18n();
	return lang === "zh" ? zh : lang === "zh-Hant" ? hant : lang === "ja" ? ja : lang === "ru" ? ru : en;
}
