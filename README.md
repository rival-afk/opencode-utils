# opencode-utils

Standalone [opencode](https://opencode.ai) plugins — each is a single
self-contained `.js` file with zero dependencies. Written for **opencode V2**
(the V2 plugin API: `export default { id, setup(ctx) }`).

| Plugin | What it does |
| --- | --- |
| [`no-env.js`](#no-envjs) | `.env` is writable and usable via `$VAR`, but its contents never reach the model |
| [`commands-banlist.js`](#commands-banlistjs) | Shell commands matching `~/.config/opencode/banlist` are refused, even when nested (`ssh -c "pgrep"`) |
| [`polite.js`](#politejs) | User prompts into corporate-respectful Russian via «С Уважением» — each rewrite asks first |
| [`todo-reminder.js`](#todo-reminderjs) | **Deprecated on V2** — V2 removed the todo tool/events; kept as an inert stub |

Blocked calls fail **with a message in the tool response itself**
(`env read access restricted: …`, `command is blacklisted: …`), so the model
sees exactly why the call was refused right in its tool result — nothing is
quietly written to opencode's logs only.

## Install

### One-liner (asks which plugins to install, downloads them from GitHub)

**Unix / Linux / Termux / macOS** — `curl | sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/rival-afk/opencode-utils/main/install.sh | sh
```

**Windows (cmd.exe)** — download & run:

```cmd
curl -fsSL https://raw.githubusercontent.com/rival-afk/opencode-utils/main/install.cmd -o "%TEMP%\opencode-utils-install.cmd" && "%TEMP%\opencode-utils-install.cmd"
```

Both installers:

- ask interactively which plugins to install (numbers/names, `all` = everything),
- fall back to `all` when there is no console (piped stdin) or when `OPENCODE_UTILS_PLUGINS` is set,
- download the selected `.js` files from `raw.githubusercontent.com` into
  `~/.config/opencode/plugins` (`%USERPROFILE%\.config\opencode\plugins` on Windows),
- sanity-check each file (`export default` must be present),

Non-interactive installs:

```sh
OPENCODE_UTILS_PLUGINS="all" curl -fsSL https://raw.githubusercontent.com/rival-afk/opencode-utils/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/rival-afk/opencode-utils/main/install.sh | sh -s -- --all
curl -fsSL https://raw.githubusercontent.com/rival-afk/opencode-utils/main/install.sh | sh -s -- --plugins "no-env polite"
```

Overrides (env or args): plugins dir — `OPENCODE_UTILS_PLUGINS_DIR=/path/to/plugins` / `--dest`,
git ref — `OPENCODE_UTILS_REF=v1.2.3` / `--ref`. Windows supports `/all`, `/plugins "…"`, `/dest`, `/ref` args the same way.

### Manual copy

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

## polite.js

Rewrites **every user prompt** into corporate-respectful Russian before the
model ever sees it — via the public [«С УВАЖЕНИЕМ.»](https://s-uvazheniem-production.up.railway.app/)
mini-app API (Telegram bot [@uvashenie_bot](https://t.me/uvashenie_bot),
"с человеческого на корпоративный").

```
ты заебал -> Коллега, предлагаю синхронизироваться по формату взаимодействия…
```

Implemented as a single `session.hook("prompt", …)` — the text is rewritten once
at **admission time**, before it is persisted or sent to the model. Assistant
messages, system instructions and tool results are left untouched.

**The plugin never changes a message silently.** Before every rewrite it asks
the user in opencode's built-in permission dialog — **Да / Нет**, switch with
←/→, confirm with Enter. «Нет» — the prompt goes out exactly as typed.
Permission rules apply, but the plugin deliberately passes no `save` patterns,
so there is no «всегда изменять» (always rewrite) choice to pick: every
message requires its own decision.

- `"/review staged"`-style slash commands are never touched
- a prompt starting with `!!` is forwarded unchanged, prefix stripped (`rawPrefix`)
- identical prompts are answered from an in-memory LRU cache (`cacheSize`, default 200)
- on API errors the original text passes through unchanged by default (`failOpen`)
- if `ctx.permission.assert` is unavailable (older opencode), the plugin does **not**
  rewrite messages at all — nothing changes silently
- translation is **not** authoritative: the API is a joke-as-a-service. Review output before sending

Options:

```jsonc
// ["polite.js", { ... }]
{
  "enabled": true,       // master switch
  "mode": "colleagues",  // "hr" | "colleagues" | "boss" | "reverse"
  "level": 2,            // 1 "Почти человек" · 2 "Корпоративный сотрудник" · 3 "HR-директор 3000"
  "baseURL": "https://s-uvazheniem-production.up.railway.app",
  "timeoutMs": 15000,    // abort slow API calls
  "failOpen": true,      // true (default) | false — false blocks the prompt on API errors
  "skipCommands": true,  // never touch text starting with "/"
  "rawPrefix": "!!",     // bypass prefix; "" disables the escape hatch
  "cacheSize": 200       // in-memory LRU of translations; 0 disables
}
```

No Telegram account, login or `initData` required — the API is public HTTPS.
(Renamed from `s-uvazheniem.js`; old file name no longer works — remove it from
your plugins directory if present and re-install.)

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

38 smoke tests run the plugins against a fake V2 `ctx` (hook registry + event
bus): blocking/allow matrices, nested-command unwrapping, banlist hot reload,
output redaction, disk re-scan and the deprecated stub.

## License

MIT
