// todo-reminder.js — DEPRECATED on opencode V2
//
// OpenCode V2 removed both the `todowrite` tool and the `todo.updated` event:
// there is no todo tool, no todo event, and no todo API endpoint anymore. This
// plugin therefore has nothing to hook into and cannot work on V2.
//
// What this file is now:
//   - a valid, inert V2 plugin (id + setup) so it never breaks plugin loading;
//   - `setup` only logs a single deprecation notice and registers no hooks.
//
// The original V1 implementation is preserved in archive/todo-reminder.v1.js
// and still works on OpenCode V1.

export const id = "opencode.utils.todo-reminder"

export async function setup() {
  console.warn(
    "[todo-reminder] deprecated: opencode V2 has no todo tool or todo.updated event. " +
      "This plugin is inert. See archive/todo-reminder.v1.js for the V1 implementation.",
  )
}

export default { id, setup }
