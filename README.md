# opencode-utils

Standalone [opencode](https://opencode.ai) plugins — each is a single
self-contained `.js` file with zero dependencies. Written for **opencode V2**
(the V2 plugin API: `export default { id, setup(ctx) }`).

| Plugin | What it does |
| --- | --- |
| [`no-env.js`](#no-envjs) | `.env` is writable and usable via `$VAR`, but its contents never reach the model |
| [`commands-banlist.js`](#commands-banlistjs) | Shell commands matching `~/.config/opencode/banlist` are refused, even when nested (`ssh -c "pgrep"`) |
| [`todo-reminder.js`](#todo-reminderjs) | **Deprecated on V2** — V2 removed the todo tool/events; kept as an inert stub |

Blocked calls fail **with a message in the tool response itself**
(`env read access restricted: …`, `command is blacklisted: …`), so the model
sees exactly why the call was refused right in its tool result — nothing is
quietly written to opencode's logs only.

## Install

Copy the files you want into the plugins directory and restart opencode:

```sh
mkdir -p ~/.config/opencode/plugins          # global
cp no-env.js commands-banlist.js ~/.config/opencode/plugins/

# or project-local
mkdir -p .opencode/plugins
cp ~/projects/opencode-utils/no-env.js ~/projects/opencode-utils/commands-banlist.js .opencode/plugins/
```

opencode auto-discovers `*.js` files in `~/.config/opencode/plugins/` and
`.opencode/plugins/` — no config entries needed. Verify with:

```sh
opencode plugin list     # each file shows an id; "-" means it failed to load
```

### Migrating a V1 plugin

A V2 plugin exports a default object with an `id` and an async `setup(ctx)`:

```js
export default {
  id: "my.plugin",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => { /* event.tool, event.input */ })
    await ctx.tool.hook("execute.after", (event) => { /* event.result, event.status */ })
    for await (const e of ctx.event.subscribe({ signal })) { /* e.type, e.data */ }
    return () => { /* cleanup */ }
  },
}
```

The V1 `(input, output)` hook arguments became a single mutable `event`, and a
thrown `Error` inside `execute.before` aborts the tool and is shown to the model.

---

## no-env.js

**Blocked** (tool error response):

- `read` / `grep` targeting `.env`, `.env.local`, … (`.env.example`,
  `.env.sample`, `.env.template` stay readable)
- shell commands that print file contents:
  `cat .env`, `head/tail/grep/wc/base64/sed -n …`, input redirection `cat < .env`,
  `source .env`, `node --env-file=.env …`
- **nested forms**: `ssh -c "cat .env"`, `bash -c 'grep X .env'`,
  `python -c "print(open('.env').read())"`, and deeper — quoted payloads are
  unwrapped recursively
- grep tool with `path: ".env"` or `include: "**/.env*"`

**Allowed**:

- writing: `write` / `edit` / `patch` tools, `echo X >> .env`, `echo x > .env`,
  `sed -i … .env`, `tee .env`, `open('.env','w')…`
- variable insertion: `curl -H "Authorization: Bearer $API_KEY"` (uses the
  environment, never reads the file)

**Safety net — output redaction**: the plugin scans `.env*` files (depth 2,
skips `node_modules`, `.git`, build dirs) at startup and again while handling
tool results (`rescanInterval`, default 1000 ms — so values added after startup
are still caught even if no `file.edited` event fires), then rewrites every tool
output: values of sensitive-looking names
(`*KEY* *SECRET* *TOKEN* *PASS* *CRED* *AUTH* *CERT* …`) become
`[REDACTED:NAME]`. So even `echo $API_KEY` or an accidental `cat` in another
file cannot leak the value into the context. Values are kept cumulatively, so
renaming/copying an `.env` file does not un-redact anything.

Options:

```jsonc
// ["no-env.js", { ... }]
{
  "enabled": true,
  "redact": "sensitive",    // "sensitive" (default) | "all" | false
  "rescanInterval": 1000    // ms between disk re-reads for redaction
}
```

---

## commands-banlist.js

Reads **`~/.config/opencode/banlist`** (override with `path` option):

```text
# one pattern per line, "#" = comment
pgrep                    # substring match, whitespace-insensitive
/git\s+push\s+--force/   # /regex/ when wrapped in slashes
rm -rf /
```

- only the `shell` tool is inspected (V2 renamed `bash` → `shell`; the old
  `bash`/`sh` names are still accepted)
- the command is decomposed: every `; | && || &` segment **and** every quoted
  payload is checked recursively (depth ≤ 5), so
  `ssh -c "pgrep foo"`, `bash -c 'sh -c "pgrep"'`,
  `python3 -c "os.system('pgrep')"` and `echo hi; pgrep` are all caught
- the banlist file is re-read automatically whenever it changes on disk —
  edits take effect without restarting opencode
- missing file ⇒ plugin is inert (nothing is blocked)

Blocked response looks like:

```text
command is blacklisted: matched "pgrep" in /root/.config/opencode/banlist
-> "pgrep foo" (blocked command: "ssh -c \"pgrep foo\"")
```

Options: `{ "enabled": true, "path": "/custom/banlist" }`.

---

## todo-reminder.js

**Deprecated on opencode V2.** V2 removed both the `todowrite` tool and the
`todo.updated` event — there is no todo tool, no todo event and no todo API
endpoint anymore — so the plugin has nothing to hook into.

The file is now a valid, **inert** V2 plugin (it loads without errors and
registers no hooks, logging a single deprecation notice on setup). The original
working V1 implementation is preserved in
[`archive/todo-reminder.v1.js`](archive/todo-reminder.v1.js) for reference and
still works on opencode V1.

Do **not** copy `todo-reminder.js` into `~/.config/opencode/plugins/` on V2.

---

## Tests

```sh
npm test        # node --test
```

24 smoke tests run the plugins against a fake V2 `ctx` (hook registry + event
bus): blocking/allow matrices, nested-command unwrapping, banlist hot reload,
output redaction, disk re-scan and the deprecated stub.

## License

MIT
