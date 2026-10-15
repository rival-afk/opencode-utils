// no-env.js — opencode plugin (V2)
//
// .env files stay writable and usable through $VAR insertion, but their
// contents never reach the model:
//   - read/grep on .env*          -> blocked (tool error response)
//   - shell commands that print .env contents (cat, head, grep, ...) -> blocked
//   - nested commands (ssh -c "cat .env", bash -c '...', python -c "...") -> blocked
//   - writes are allowed: write/edit tools, `echo X >> .env`, sed -i, tee ...
//   - $VAR / ${VAR} insertion is allowed (it never reads the file)
//   - values found in .env* are redacted from every tool output afterwards
//
// Options (object form in opencode.json: { package: "./no-env.js", options: {...} }):
//   enabled:  true | false          (default true)
//   redact:   "sensitive" | "all" | false   (default "sensitive")
//   rescanInterval: ms to re-read .env* from disk for redaction (default 1000)
//
// OpenCode V2 plugin API: default export { id, setup(ctx) }. Registrations are
// made through ctx.tool.hook / ctx.event.subscribe instead of a returned map.

import fs from "node:fs"
import path from "node:path"

export const id = "opencode.utils.no-env"

const DEFAULTS = { enabled: true, redact: "sensitive", rescanInterval: 1000 }

const SAFE_SUFFIX = /\.(example|sample|template|dist|default|defaults|placeholder)$/i

export function isEnvFile(p) {
  if (typeof p !== "string" || p.length === 0) return false
  const base = path.basename(p.trim())
  if (!/^\.env(\.[^.\/\\]+)*$/.test(base)) return false
  if (SAFE_SUFFIX.test(base)) return false
  return true
}

// .env, .env.local, config/.env.production ... (not foo.env, not .envrc)
const ENV_REF_RE = /(?:^|[^A-Za-z0-9_.])(\.env(?:\.[A-Za-z0-9_-]+)*)(?=$|[^A-Za-z0-9_.-])/g

export function refsIn(text) {
  const out = []
  for (const m of String(text).matchAll(ENV_REF_RE)) {
    if (isEnvFile(m[1])) out.push(m[1])
  }
  return out
}

export function splitTop(cmd) {
  const parts = []
  let cur = ""
  let quote = null
  let esc = false
  for (const ch of cmd) {
    if (esc) {
      cur += ch
      esc = false
      continue
    }
    if (quote) {
      if (ch === "\\") {
        cur += ch
        if (quote !== "'") esc = true
        continue
      }
      if (ch === quote) quote = null
      cur += ch
      continue
    }
    if (ch === "\\") {
      cur += ch
      esc = true
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      if (cur.trim()) parts.push(cur.trim())
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

export function extractQuoted(text) {
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g
  let m
  while ((m = re.exec(text)) !== null) {
    const q = m[1] ?? m[2] ?? m[3] ?? ""
    if (q.trim()) out.push(q)
  }
  return out
}

function collect(text, kind, depth, out) {
  out.push({ text, kind })
  if (depth >= 4) return
  if (kind === "cmd") {
    for (const seg of splitTop(text)) {
      if (seg !== text) collect(seg, "cmd", depth + 1, out)
    }
  }
  for (const q of extractQuoted(text)) {
    collect(q, "payload", depth + 1, out)
  }
}

const READ_WORDS = new Set([
  "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "jq", "cut", "wc", "strings", "xxd", "hexdump", "od", "nl", "tac", "shuf", "rev",
  "base64", "sed", "awk", "sort", "uniq", "tr", "diff", "cmp", "sha256sum", "md5sum",
  "openssl", "column", "paste", "expand", "fold", "fmt", "pr", "source", ".",
])

const SCRIPT_WRITE_RE =
  /\b(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|write_text|write_bytes)\s*\(|open\s*\([^)]*,\s*['"]w[a+]?['"]|\bmode\s*=\s*['"]w['"]/

const LEAD_SKIP = new Set(["sudo", "command", "builtin", "nohup", "time", "exec", "nice", "doas"])

// Read primitives used inside script payloads: open('.env').read(),
// fs.readFileSync('.env'), Get-Content .env, file_get_contents('.env'), ...
const SCRIPT_READ_RE =
  /\b(open|readFile|readFileSync|readFileText|read_text|read_bytes|readlines|readline|readAll|getContent|Get-Content|fopen|fgets|file_get_contents)\b/i

// A quoted payload is a reader only if it actually looks like one. A plain
// message that merely mentions ".env" (a commit message, an echo, an issue
// title) must not be blocked. Nested quoted commands are still caught because
// collect() descends into the payload and re-checks every extracted part.
function payloadReads(text, refs) {
  if (readsEnv(text, refs)) return true
  if (SCRIPT_READ_RE.test(text)) return true
  return false
}

function firstWords(seg, n) {
  const words = seg.trim().split(/\s+/).filter(Boolean)
  const out = []
  let i = 0
  while (i < words.length && out.length < n) {
    const w = words[i]
    if (LEAD_SKIP.has(w)) {
      i++
      continue
    }
    if (w === "env") {
      i++
      while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++
      continue
    }
    // strip wrapping quotes / backslashes so escaped forms like \"cat are seen
    // as the command they are (bash -c "sh -c \"cat .env\"")
    const clean = w.replace(/^[\\'"`]+|[\\'"`]+$/g, "")
    if (clean) out.push(clean)
    i++
  }
  return out
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isWriteOnly(text, refs) {
  // echo x > .env / >> .env
  for (const ref of refs) {
    const re = new RegExp(`(^|[^\\w.>])>{1,2}\\s*['"]?[^;&|\\n]*${escRe(ref)}(?![A-Za-z0-9_.-])`)
    if (re.test(text)) return true
  }
  // in-place editors
  if (/\bsed\s+-[A-Za-z]*i[A-Za-z]*\b|\bperl\s+-[A-Za-z]*i[A-Za-z]*\b|\bsponge\b/.test(text)) {
    return true
  }
  // tee .env / tee -a .env (tee target is a write; the piped reader is a separate segment)
  if (/\btee\s+(-\S+\s+)*['"]?[^;&|\s]*\.env(\.[A-Za-z0-9_-]+)?(?![A-Za-z0-9_.-])/.test(text)) {
    return true
  }
  // script writes: python -c "open('.env','w')...", fs.writeFileSync('.env', ...)
  if (SCRIPT_WRITE_RE.test(text)) return true
  return false
}

function readsEnv(text, refs) {
  // input redirection: cat < .env, done < .env, $(<.env)
  for (const ref of refs) {
    const re = new RegExp(`<{1,2}\\s*['"]?[^;&|\\n]*${escRe(ref)}(?![A-Za-z0-9_.-])`)
    if (re.test(text)) return true
  }
  // --env-file=.env (node, etc.)
  if (/--env-file(=|\s)/.test(text)) return true
  const words = firstWords(text, 4)
  for (const w of words) {
    if (READ_WORDS.has(w) || READ_WORDS.has(path.basename(w))) return true
  }
  return false
}

export function analyseCommand(cmd) {
  const candidates = []
  collect(String(cmd ?? ""), "cmd", 0, candidates)
  for (const cand of candidates) {
    const refs = refsIn(cand.text)
    if (refs.length === 0) continue
    if (isWriteOnly(cand.text, refs)) continue
    if (cand.kind === "payload") {
      const bare = cand.text.trim().replace(/^['"]|['"]$/g, "")
      // payload that is just a filename ("cat .env", "echo .env") — the surrounding
      // command was already checked at cmd level; a bare filename itself reads nothing
      if (refs.length === 1 && refs[0] === bare) continue
      // only block payloads that actually read the file, not prose that mentions it
      if (!payloadReads(cand.text, refs)) continue
      return { ref: refs[0], snippet: cand.text }
    }
    if (readsEnv(cand.text, refs)) {
      return { ref: refs[0], snippet: cand.text }
    }
  }
  return null
}

function envRestricted(ref, via) {
  return new Error(
    `env read access restricted: "${ref}" cannot be read by the agent` +
      (via ? ` (blocked: ${via})` : "") +
      `. Writing .env is allowed (write/edit tools, ">> .env", sed -i); ` +
      `reference values as $VAR in commands instead. .env.example files are readable and contain the variable names.`,
  )
}

// ---- secret store ----------------------------------------------------------

const SENSITIVE_NAME = /(KEY|SECRET|TOKEN|PASS|CRED|AUTH|CERT|PRIVATE|SALT|SIGN|DSN|CONNECTION|DATABASE_URL|LICENSE|BUNDLE_?PHRASE|API_?KEY)/i
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".cache", ".next", ".nuxt",
  "vendor", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".idea",
])

export function parseEnv(content) {
  const found = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]
    const q = value[0]
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) {
      value = value.slice(1, -1)
    }
    if (!value || value.startsWith("${")) continue
    found.push({ name: m[1], value })
  }
  return found
}

function walk(dir, depth, acc) {
  if (depth < 0) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) {
        if (!e.name.startsWith(".")) continue
        if (SKIP_DIRS.has(e.name)) continue
      }
      walk(path.join(dir, e.name), depth - 1, acc)
    } else if (e.isFile() && isEnvFile(e.name)) {
      acc.push(path.join(dir, e.name))
    }
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function makeSecretStore(opts) {
  const values = new Map() // name -> Set(values) (cumulative, survives file renames)

  function scanRoot(root, depth) {
    const files = []
    walk(root, depth, files)
    for (const f of files) {
      try {
        for (const { name, value } of parseEnv(fs.readFileSync(f, "utf8"))) {
          if (!values.has(name)) values.set(name, new Set())
          values.get(name).add(value)
        }
      } catch {
        /* unreadable .env — ignore */
      }
    }
  }

  function scan(dirs, depth) {
    for (const d of new Set(dirs)) {
      if (d) scanRoot(d, depth)
    }
  }

  function redact(text) {
    if (opts.redact === false || !text) return text
    let out = text
    const entries = []
    for (const [name, set] of values) {
      if (opts.redact !== "all" && !SENSITIVE_NAME.test(name)) continue
      for (const v of set) entries.push({ name, v })
    }
    entries.sort((a, b) => b.v.length - a.v.length)
    for (const { name, v } of entries) {
      const tag = `[REDACTED:${name}]`
      if (v.length >= 10) {
        out = out.split(v).join(tag)
      } else {
        out = out.replace(new RegExp(`\\b${escapeRe(v)}\\b`, "g"), tag)
      }
    }
    return out
  }

  return { scan, redact, size: () => values.size }
}

// ---- tool result redaction -------------------------------------------------

function redactDeep(value, store, depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) redactDeep(item, store, depth + 1)
    return
  }
  for (const key of Object.keys(value)) {
    const v = value[key]
    if (typeof v === "string") value[key] = store.redact(v)
    else redactDeep(v, store, depth + 1)
  }
}

export function redactResult(result, store) {
  if (!result || typeof result !== "object") return
  // V2 Tool.Result: { output?, content?: string | Content[], metadata? }
  if (typeof result.content === "string") {
    result.content = store.redact(result.content)
  } else if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part && part.type === "text" && typeof part.text === "string") part.text = store.redact(part.text)
    }
  }
  if (typeof result.output === "string") result.output = store.redact(result.output)
  redactDeep(result.metadata, store)
}

// ---- plugin ----------------------------------------------------------------

export async function setup(ctx) {
  const opts = { ...DEFAULTS, ...(ctx.options ?? {}) }
  const location = ctx.location ?? {}
  const dirs = [location.directory, location.project?.directory, location.worktree].filter(Boolean)
  const store = makeSecretStore(opts)

  if (opts.enabled) {
    try {
      store.scan(dirs, 2)
    } catch {
      /* best effort */
    }
  }

  let lastScan = 0
  const rescanInterval = Number.isFinite(Number(opts.rescanInterval)) ? Math.max(0, Number(opts.rescanInterval)) : DEFAULTS.rescanInterval
  const rescan = () => {
    const now = Date.now()
    if (now - lastScan < rescanInterval) return
    lastScan = now
    try {
      store.scan(dirs, 2)
    } catch {
      /* ignore */
    }
  }

  // Re-scan when an .env file is edited (V2 event: { type, data: { file } }).
  const controller = new AbortController()
  if (ctx.event?.subscribe) {
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!opts.enabled) continue
          if (event?.type !== "file.edited") continue
          const file = String(event.data?.file ?? "")
          if (isEnvFile(file) || /(^|[\\/])\.env(\.[A-Za-z0-9_-]+)?$/.test(file)) rescan()
        }
      } catch {
        /* subscription closed */
      }
    })()
  }

  await ctx.tool.hook("execute.before", (event) => {
    if (!opts.enabled) return
    const tool = event.tool
    const args = event.input ?? {}

    if (tool === "read") {
      if (isEnvFile(args.path)) throw envRestricted(path.basename(String(args.path)), "read tool")
      return
    }

    if (tool === "grep") {
      const target =
        (typeof args.path === "string" && isEnvFile(args.path)) ||
        (typeof args.include === "string" && refsIn(args.include).length > 0)
      if (target) throw envRestricted(String(args.path ?? args.include), "grep tool")
      return
    }

    if (tool === "shell" || tool === "bash" || tool === "sh") {
      const hit = analyseCommand(args.command)
      if (hit) throw envRestricted(hit.ref, JSON.stringify(hit.snippet).slice(0, 120))
      return
    }

    // write / edit / patch / glob and everything else stay allowed
  })

  await ctx.tool.hook("execute.after", (event) => {
    if (!opts.enabled || opts.redact === false) return
    if (event.status !== "completed") return
    // Re-read .env from disk (throttled) so values added after startup are
    // caught even when file.edited events are unavailable. This also covers
    // the .env write performed by the very tool call being redacted.
    rescan()
    try {
      redactResult(event.result, store)
    } catch {
      /* never break the tool result */
    }
  })

  return () => controller.abort()
}

export default { id, setup }
