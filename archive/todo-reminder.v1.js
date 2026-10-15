// todo-reminder.js — opencode V1 plugin (ARCHIVED)
//
// Kept for reference only. OpenCode V2 removed the `todowrite` tool and the
// `todo.updated` event, so this plugin cannot run on V2. See ../todo-reminder.js
// and ../README.md. It still works on OpenCode V1.
//
// Keeps the model from forgetting its todo list without flooding the context.
//
// Algorithm (per session):
//   - every tool call increments a counter (todowrite itself resets it)
//   - a reminder is appended to the tool result text after `baseInterval`
//     calls with no todo update, then the required gap doubles:
//     3 -> 6 -> 12 -> 24 -> 24 -> ... (capped at `maxInterval`)
//   - any todo.updated event (model called todowrite) resets the schedule
//   - no todos / everything completed -> plugin stays completely silent
//   - two reminders never land on consecutive tool calls
//
// Delivery: one short line appended to the tool output the model is already
// reading (~25 tokens). No synthetic prompts, no session.idle loops.
//
// Options: {
//   enabled: true, baseInterval: 3, maxInterval: 24,
//   message: "..."   // optional override; placeholders {pending} {inProgress} {total}
// }

const DEFAULTS = { enabled: true, baseInterval: 3, maxInterval: 24 }

const DEFAULT_MESSAGE =
  "⏳ [todo-reminder] {pending} pending, {inProgress} in progress — statuses look stale, call todowrite to update the list."

const OPEN_STATUSES = new Set(["pending", "in_progress", "open"])

function makeState(opts) {
  return {
    count: 0,
    next: opts.baseInterval,
    gap: opts.baseInterval,
    todos: null, // null = unknown yet
    fetched: false,
  }
}

function normalizeOptions(options) {
  const opts = { ...DEFAULTS, ...(options ?? {}) }
  opts.baseInterval = Math.max(1, Math.floor(Number(opts.baseInterval) || DEFAULTS.baseInterval))
  opts.maxInterval = Math.max(opts.baseInterval, Math.floor(Number(opts.maxInterval) || DEFAULTS.maxInterval))
  return opts
}

function openCounts(todos) {
  let pending = 0
  let inProgress = 0
  for (const t of todos) {
    if (t.status === "in_progress") inProgress++
    else if (OPEN_STATUSES.has(t.status)) pending++
  }
  return { pending, inProgress, total: todos.length }
}

function renderMessage(opts, counts) {
  const tpl = typeof opts.message === "string" && opts.message ? opts.message : DEFAULT_MESSAGE
  return tpl
    .replaceAll("{pending}", String(counts.pending))
    .replaceAll("{inProgress}", String(counts.inProgress))
    .replaceAll("{total}", String(counts.total))
}

export default async function todoReminder(input, options) {
  const opts = normalizeOptions(options)
  const sessions = new Map()

  const state = (sid) => {
    let st = sessions.get(sid)
    if (!st) {
      st = makeState(opts)
      sessions.set(sid, st)
    }
    return st
  }

  const reset = (st, todos) => {
    st.count = 0
    st.next = opts.baseInterval
    st.gap = opts.baseInterval
    if (todos !== undefined) st.todos = todos
  }

  const applyTodos = (sid, todos) => {
    if (!Array.isArray(todos)) return
    reset(state(sid), todos)
  }

  const fetchTodos = async (sid, st) => {
    if (st.fetched) return
    st.fetched = true
    try {
      const res = await input.client?.session?.todo?.({ path: { id: sid } })
      const data = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null
      if (Array.isArray(data)) st.todos = data
    } catch {
      /* stay silent until we actually know the todos */
    }
  }

  return {
    event: async ({ event }) => {
      if (!opts.enabled) return
      if (event?.type !== "todo.updated") return
      const props = event.properties ?? {}
      if (typeof props.sessionID !== "string") return
      applyTodos(props.sessionID, props.todos)
    },

    "tool.execute.after": async (hookInput, output) => {
      if (!opts.enabled) return
      const sid = hookInput.sessionID
      if (typeof sid !== "string") return
      const st = state(sid)

      if (hookInput.tool === "todowrite") {
        // the todo list itself is the freshest source of truth
        const todos = Array.isArray(hookInput.args?.todos) ? hookInput.args.todos : undefined
        reset(st, todos)
        return
      }

      st.count++
      if (st.todos === null) await fetchTodos(sid, st)
      if (!Array.isArray(st.todos)) return

      const counts = openCounts(st.todos)
      if (counts.pending + counts.inProgress === 0) return
      if (st.count < st.next) return

      const line = renderMessage(opts, counts)
      output.output = output.output ? `${output.output}\n\n${line}` : line

      st.next = st.count + st.gap
      st.gap = Math.min(st.gap * 2, opts.maxInterval)
    },
  }
}
