// sandbox.js — opencode plugin (V2)
//
// «Sandbox mode» for the agent: the session is told (honestly) that it runs
// against an isolated local sandbox, and file access is confined to the
// sandbox roots.
//
// What it does:
//   - registers a `context` hook that prepends a short factual note to the
//     system instructions of every agent-loop model call
//     (`event.system.push(...)`). The note says what the environment is —
//     nothing more; it does not ask the model to bypass its own judgment.
//   - confines file tools to the sandbox roots — the location directory, the
//     project directory, the worktree, plus any extra `roots` you configure:
//       read / write / edit / patch / grep -> `path` (and `filePath`) must be
//         inside a root, otherwise the call is refused with a tool error
//       glob -> `path` (its working directory), when set
//       shell / bash / sh -> `cwd` (and `workdir`), when set
//     Relative paths resolve against the location directory.
//
// What it deliberately does NOT do:
//   - It does not scan shell command *text* for absolute paths — that check
//     produces too many false positives (/bin/ls, /usr/bin/...). Shell
//     confinement covers the working directory only; use commands-banlist
//     for command filtering.
//   - It does not inject hidden overrides, and it does not ask the model to
//     skip its own safety judgment. The note only states the facts.
//
// Options (object form in opencode.json: { package: "./sandbox.js", options: {...} }):
//   enabled: true|false   (default true)
//   roots:   string[]     extra absolute (or ~-relative) paths allowed in
//                         addition to the location/project/worktree roots
//   note:    string|false a custom note instead of the default, or false to
//                         disable the system-note injection entirely
//
// OpenCode V2 plugin API: default export { id, setup(ctx) }. The V1
// `chat.params` hook became the `context` session hook.

import path from "node:path"
import os from "node:os"

export const id = "opencode.utils.sandbox"

export const DEFAULT_NOTE = [
  "[SANDBOX MODE] This session runs against an isolated local sandbox — a",
  "throwaway environment for building and testing code. It is not production:",
  "nothing here is a real deployment, real user data or a shared service.",
  "Prefer direct, concrete technical answers and working code over lengthy",
  "disclaimers. Irreversible actions outside the sandbox (touching state",
  "beyond this workspace) still warrant an explicit check with the user first.",
].join("\n")

const FILE_PATH_KEYS = ["path", "filePath", "file_path", "file"]
const CWD_KEYS = ["cwd", "workdir", "directory"]

function expandHome(p) {
  const s = String(p)
  if (s === "~") return os.homedir()
  if (s.startsWith(`~${path.sep}`) || s.startsWith("~/")) return path.join(os.homedir(), s.slice(2))
  return s
}

/** Resolve a candidate path against base; returns null for empty input. */
export function resolveCandidate(p, base) {
  if (typeof p !== "string" || !p.trim()) return null
  return path.resolve(base, expandHome(p.trim()))
}

/** True when `child` is `root` itself or lives underneath it. */
export function isInside(child, root) {
  const rel = path.relative(path.resolve(root), path.resolve(child))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function normalizeRoots(location, extra = []) {
  const out = new Set()
  const add = (p) => {
    const r = resolveCandidate(p, process.cwd())
    if (r) out.add(path.resolve(r))
  }
  if (location?.directory) add(location.directory)
  if (location?.project?.directory) add(location.project.directory)
  if (location?.worktree) add(location.worktree)
  for (const r of extra) add(r)
  return [...out]
}

export function sandboxRoots(ctx) {
  const opts = ctx?.options ?? {}
  const extra = Array.isArray(opts.roots) ? opts.roots.map(String) : []
  return normalizeRoots(ctx?.location ?? {}, extra)
}

function outsideRoots(candidate, roots, base) {
  const abs = resolveCandidate(candidate, base)
  if (abs && roots.some((root) => isInside(abs, root))) return null
  return abs
}

function sandboxError(what, abs, roots) {
  return new Error(
    `sandbox: ${what} "${abs ?? what}" is outside the sandbox roots ` +
      `(${roots.join(", ")}). Add it to the plugin's "roots" option or ` +
      `work inside the workspace.`,
  )
}

// collect every path-like argument of a file tool call
function filePaths(args) {
  const out = []
  for (const key of FILE_PATH_KEYS) {
    const abs = typeof args?.[key] === "string" ? args[key] : null
    if (abs) out.push(abs)
  }
  return out
}

// ---- plugin ----------------------------------------------------------------

export async function setup(ctx) {
  const opts = ctx.options ?? {}
  const enabled = opts.enabled !== false
  const location = ctx.location ?? {}
  const base = location.directory ? path.resolve(location.directory) : process.cwd()
  const roots = sandboxRoots(ctx)
  const note = typeof opts.note === "string" ? opts.note : opts.note === false ? false : DEFAULT_NOTE

  if (!enabled) return

  if (note && typeof ctx.session?.hook === "function") {
    await ctx.session.hook("context", (event) => {
      if (!Array.isArray(event?.system)) return
      event.system.push({ type: "text", text: note })
    })
  }

  await ctx.tool.hook("execute.before", (event) => {
    if (!enabled) return
    const tool = event.tool
    const args = event.input ?? {}

    if (["read", "write", "edit", "patch", "grep"].includes(tool)) {
      for (const p of filePaths(args)) {
        const abs = outsideRoots(p, roots, base)
        if (abs) throw sandboxError(tool, abs, roots)
      }
      return
    }

    if (tool === "glob") {
      if (typeof args.path === "string" && args.path.trim()) {
        const abs = outsideRoots(args.path, roots, base)
        if (abs) throw sandboxError(tool, abs, roots)
      }
      return
    }

    if (tool === "shell" || tool === "bash" || tool === "sh") {
      for (const key of CWD_KEYS) {
        if (typeof args[key] === "string" && args[key].trim()) {
          const abs = outsideRoots(args[key], roots, base)
          if (abs) throw sandboxError(`shell ${key}`, abs, roots)
        }
      }
      return
    }
    // everything else is unconstrained
  })
}

export default { id, setup }
