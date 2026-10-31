/**
 * dsh-selection-chat —— host 半端（占位）
 * ============================================================================
 * 这个插件没有 host 侧能力：不注册工具、不起进程、不写文件、不碰网络。
 * 它存在的唯一理由是让 cordis 有一条可挂载的行，从而把浏览器半端
 * （`exports["./client"]` → client.js）交给 Web 客户端加载。
 *
 * 所以 apply() 故意是空的 —— 任何副作用都应当留在 client.js 里。
 * ============================================================================
 */

export const name = 'selection-chat'

/** 没有依赖任何 host 服务。 */
export const inject = []

/**
 * @param {unknown} _ctx cordis 上下文（本插件不需要）
 */
export function apply(_ctx) {
  // 故意留空：见文件头。
}
