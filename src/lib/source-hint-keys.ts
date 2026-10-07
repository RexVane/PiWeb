/**
 * 框架开发态元数据换算出的源码定位线索键（截图上点选元素时在页面里读出，不是真实 DOM 属性）。
 * 浏览器内核与 dev-inspect-service 共用；本模块不能有任何依赖，免得浏览器内核被拖进 pi SDK。
 * - react-source（React ≤18 的 fiber._debugSource）、svelte-source（__svelte_meta.loc）：file:line[:col]，精确到行
 * - vue-file（组件实例的 type.__file）：只到组件文件，作为文本搜索的范围提示
 */
export const FRAMEWORK_SOURCE_KEYS = ["react-source", "svelte-source"] as const;
export const COMPONENT_FILE_KEY = "vue-file";
