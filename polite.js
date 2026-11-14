// polite.js — opencode plugin (V2)  (бывш. «С УВАЖЕНИЕМ.» / s-uvazheniem.js)
//
// Rewrites every user message into corporate-respectful Russian before it
// reaches the model, using the public «С УВАЖЕНИЕМ.» mini-app API (bot
// @uvashenie_bot) — "с человеческого на корпоративный и обратно":
//   POST https://s-uvazheniem-production.up.railway.app/api/translate
//
//   "ты заебал" -> "Коллега, предлагаю синхронизироваться по формату взаимодействия…"
//
// How it works: a single `prompt` hook (admission time — once per submitted
// message, before the text is persisted or sent to the model). Assistant
// messages, system instructions and tool results are left untouched.
//
// Важно: плагин НИКОГДА не меняет сообщение молча. Перед изменением
// КАЖДОГО сообщения он спрашивает подтверждение через встроенный
// permission-диалог opencode (стрелки ←/→ переключают Да/Нет, Enter
// подтверждает). «Нет» — сообщение уходит как есть. «Изменять всегда,
// не спрашивая» опции нет и не будет: каждый промпт требует своего решения.
//
// Escape hatch: a message starting with the raw prefix (default "!!") is
// forwarded unchanged, with the prefix stripped. Messages starting with "/"
// (slash commands) are never touched.
//
// Options (object form in opencode.json: { package: "./polite.js", options: {...} }):
//   enabled:    true|false      (default true)
//   mode:       "colleagues" | "boss" | "hr" | "reverse"   (default "colleagues")
//   level:      1..3            (default 2 — "Корпоративный сотрудник")
//   baseURL:    API origin      (default https://s-uvazheniem-production.up.railway.app)
//   timeoutMs:  per-request timeout (default 15000)
//   failOpen:   true  → on API error keep the original text (default)
//               false → let the error abort the prompt
//   skipCommands: true|false    (default true — never touch text starting with "/")
//   rawPrefix:  string          (default "!!"; set to "" to disable the escape hatch)
//   cacheSize:  translations cached in memory (default 200, 0 disables)
//
// OpenCode V2 plugin API: default export { id, setup(ctx) }.

export const id = "opencode.utils.polite"

export const DEFAULT_BASE_URL = "https://s-uvazheniem-production.up.railway.app"
export const MODES = new Set(["hr", "colleagues", "boss", "reverse"])
export const PERMISSION_ACTION = "polite.rewrite"
export const PERMISSION_RESOURCE = "prompt"

export function makeTranslator(opts = {}) {
  const baseURL = String(opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const mode = MODES.has(opts.mode) ? opts.mode : "colleagues"
  const level = Math.min(3, Math.max(1, Number(opts.level) || 2))
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000
  const failOpen = opts.failOpen !== false
  const cacheSize = Number(opts.cacheSize ?? 200)

  const cache = new Map()
  const inflight = new Map()

  function cacheGet(key) {
    const value = cache.get(key)
    if (value === undefined) return undefined
    // LRU-ish: refresh recency
    cache.delete(key)
    cache.set(key, value)
    return value
  }

  function cacheSet(key, value) {
    if (cacheSize <= 0) return
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value)
  }

  async function translate(text, previous = "", action = "translate") {
    const key = `${action}:${mode}:${level}\n${previous}\n${text}`
    const hit = cacheGet(key)
    if (hit !== undefined) return hit
    const pending = inflight.get(key)
    if (pending) return pending

    const job = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(`${baseURL}/api/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, mode, level, action, previous }),
          signal: controller.signal,
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`)
        }
        if (typeof body?.text !== "string" || !body.text.trim()) {
          throw new Error("empty translation from API")
        }
        return body.text
      } finally {
        clearTimeout(timer)
        inflight.delete(key)
      }
    })()

    inflight.set(key, job)
    try {
      const result = await job
      cacheSet(key, result)
      return result
    } catch (err) {
      if (failOpen) {
        console.error(`polite: translation failed, keeping original text (${err?.message ?? err})`)
        return text
      }
      throw err
    }
  }

  return {
    translate,
    mode,
    level,
    baseURL,
    /** Apply the raw-prefix escape hatch; returns null when text should pass unchanged. */
    stripRawPrefix(text, rawPrefix) {
      if (!rawPrefix) return null
      if (!text.startsWith(rawPrefix)) return null
      const rest = text.slice(rawPrefix.length).replace(/^\s+/, "")
      return rest.length ? rest : null
    },
  }
}

export async function setup(ctx) {
  const opts = ctx.options ?? {}
  const enabled = opts.enabled !== false
  const skipCommands = opts.skipCommands !== false
  const rawPrefix = typeof opts.rawPrefix === "string" ? opts.rawPrefix : "!!"

  const t = makeTranslator(opts)
  if (enabled) {
    console.log(
      `polite: prompts will be translated via ${t.baseURL} ` +
        `(mode=${t.mode}, level=${t.level}${opts.failOpen === false ? ", fail-closed" : ""}, ` +
        `ask before every rewrite)`,
    )
    if (typeof ctx.permission?.assert !== "function") {
      console.warn(
        "polite: ctx.permission.assert is unavailable in this opencode version — plugin will NOT rewrite messages silently",
      )
    }
  }

  await ctx.session.hook("prompt", async (event) => {
    if (!enabled) return
    const prompt = event?.prompt
    if (!prompt || typeof prompt.text !== "string") return
    const text = prompt.text
    const trimmed = text.trim()
    if (!trimmed) return
    if (skipCommands && trimmed.startsWith("/")) return

    const raw = t.stripRawPrefix(trimmed, rawPrefix)
    if (raw !== null) {
      prompt.text = raw
      return
    }

    // Спрашиваем ТОЛЬКО перед изменением сообщения — и только для него.
    if (typeof ctx.permission?.assert !== "function") {
      // Старое поведение (молчаливый рерайт) недопустимо: не трогаем сообщение.
      return
    }
    try {
      await ctx.permission.assert({
        sessionID: event.sessionID,
        agent: event.agent,
        action: PERMISSION_ACTION,
        resources: [PERMISSION_RESOURCE],
        metadata: { reason: "rewrite prompt into corporate Russian (yes = rewrite, no = keep as-is)", mode: t.mode, level: t.level },
      })
    } catch {
      return // «Нет» / deny — сообщение остаётся как есть
    }

    const translated = await t.translate(text)
    if (translated !== text) {
      prompt.text = translated
      event.metadata = { ...event.metadata, translatedBy: id }
    }
  })
}

export default { id, setup }
