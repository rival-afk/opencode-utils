// commands-banlist.js — opencode plugin
//
// Reads a banlist file and refuses to execute matching shell commands.
//   default file: ~/.config/opencode/banlist
//   format: one pattern per line, "#" starts a comment
//     pgrep                 -> substring match (whitespace-insensitive)
//     /git\s+push\s+-{0,2}f/ -> regular expression when wrapped in /.../
//
// Matching runs against the whole command, every `; | && || &` segment and
// every quoted payload (recursively), so nested forms like
//   ssh -c "pgrep foo"  |  bash -c 'sh -c "pgrep"'  |  python -c "..."
// are blocked too. The file is re-read whenever it changes on disk.
//
// A blocked call fails with the message below as the *tool response*, so the
// model immediately sees why the command was rejected (no silent log entries).
//
// Options: { enabled: true|false, path: "/custom/banlist" }

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEFAULT_PATH = path.join(os.homedir(), ".config", "opencode", "banlist")

function normalize(s) {
  return s.trim().replace(/\s+/g, " ")
}

function parseLine(line) {
  const raw = line.trim()
  if (!raw || raw.startsWith("#")) return null
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(raw)
  if (m) {
    try {
      return { kind: "regex", re: new RegExp(m[1], m[2] || undefined), raw }
    } catch {
      return { kind: "sub", text: normalize(raw), raw }
    }
  }
  return { kind: "sub", text: normalize(raw), raw }
}

function loadFile(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
    return lines.map(parseLine).filter(Boolean)
  } catch {
    return null // missing/unreadable file = banlist disabled
  }
}

function makeStore(file) {
  let patterns = []
  let stamp = null
  let loaded = false

  function refresh(force = false) {
    let st
    try {
      const s = fs.statSync(file)
      st = `${s.mtimeMs}:${s.size}`
    } catch {
      st = null
    }
    if (!force && st === stamp && loaded) return
    stamp = st
    loaded = true
    patterns = st === null ? [] : loadFile(file) ?? []
  }

  refresh(true)
  return {
    get patterns() {
      refresh()
      return patterns
    },
    file,
  }
}

// ---- command decomposition -------------------------------------------------

function splitTop(cmd) {
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

function extractQuoted(text) {
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g
  let m
  while ((m = re.exec(text)) !== null) {
    const q = m[1] ?? m[2] ?? m[3] ?? ""
    if (q.trim()) out.push(q)
  }
  return out
}

function collect(text, depth, out) {
  if (text.trim()) out.push(text)
  if (depth >= 5) return
  for (const seg of splitTop(text)) {
    if (seg !== text) collect(seg, depth + 1, out)
  }
  for (const q of extractQuoted(text)) {
    collect(q, depth + 1, out)
  }
}

function matchBanlist(cmd, patterns) {
  const candidates = []
  collect(String(cmd ?? ""), 0, candidates)
  // prefer the most specific (shortest) matching candidate for the error message
  candidates.sort((a, b) => a.length - b.length)
  let best = null
  for (const cand of candidates) {
    const candNorm = normalize(cand)
    for (const p of patterns) {
      const hit = p.kind === "regex" ? p.re.test(cand) : candNorm.includes(p.text)
      if (hit && (!best || cand.length < best.cand.length)) {
        best = { pattern: p, cand }
      }
    }
  }
  return best
}

// ---- plugin ----------------------------------------------------------------

export default async function commandsBanlist(input, options) {
  const opts = options ?? {}
  const enabled = opts.enabled !== false
  const file = opts.path ? path.resolve(String(opts.path).replace(/^~(?=\/|$)/, os.homedir())) : DEFAULT_PATH
  const store = makeStore(file)

  return {
    "tool.execute.before": async (hookInput, output) => {
      if (!enabled) return
      const tool = hookInput.tool
      if (tool !== "shell" && tool !== "bash" && tool !== "sh") return
      const cmd = output.args?.command
      if (typeof cmd !== "string" || !cmd.trim()) return

      const hit = matchBanlist(cmd, store.patterns)
      if (hit) {
        throw new Error(
          `command is blacklisted: matched "${hit.pattern.raw}" in ${store.file} ` +
            `-> ${JSON.stringify(hit.cand)} ` +
            `(blocked command: ${JSON.stringify(cmd.length > 300 ? cmd.slice(0, 300) + "…" : cmd)})`,
        )
      }
    },
  }
}
