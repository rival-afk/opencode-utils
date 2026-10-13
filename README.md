# opencode-utils

Three standalone [opencode](https://opencode.ai) plugins — each is a single
self-contained `.js` file with zero dependencies.

| Plugin | What it does |
| --- | --- |
| [`no-env.js`](#no-envjs) | `.env` is writable and usable via `$VAR`, but its contents never reach the model |
| [`commands-banlist.js`](#commands-banlistjs) | Shell commands matching `~/.config/opencode/banlist` are refused, even when nested (`ssh -c "pgrep"`) |
| [`todo-reminder.js`](#todo-reminderjs) | Gently reminds the model to refresh its todo list — adaptive, context-cheap |

Blocked calls fail **with a message in the tool response itself**
(`env read access restricted: …`, `command is blacklisted: …`), so the model
sees exactly why the call was refused right in its tool result — nothing is
quietly written to opencode's logs only.

## Install

Copy the files you want into the plugins directory and restart opencode:

```sh
mkdir -p ~/.config/opencode/plugins          # global
cp no-env.js commands-banlist.js todo-reminder.js ~/.config/opencode/plugins/

# or project-local
mkdir -p .opencode/plugins
cp ~/projects/opencode-utils/*.js .opencode/plugins/
```

opencode auto-discovers `*.js` files in `~/.config/opencode/plugins/` and
`.opencode/plugins/` — no config entries needed.

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
skips `node_modules`, `.git`, build dirs) at startup and on `file.edited`,
then rewrites every tool output: values of sensitive-looking names
(`*KEY* *SECRET* *TOKEN* *PASS* *CRED* *AUTH* *CERT* …`) become
`[REDACTED:NAME]`. So even `echo $API_KEY` or an accidental `cat` in another
file cannot leak the value into the context. Values are kept cumulatively, so
renaming/copying an `.env` file does not un-redact anything.

Options:

```jsonc
// ["no-env.js", { ... }]
{
  "enabled": true,
  "redact": "sensitive"   // "sensitive" (default) | "all" | false
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

- only the `shell`/`bash` tool is inspected
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

Keeps the model from forgetting its todos **without flooding the context**.

Why not a naive "every 2–3 tool calls"? A fixed short interval either nags
during long tool bursts or is still easy to ignore. Instead, per session:

1. every tool call increments a counter (`todowrite` resets it);
2. first reminder lands after **3** calls with no todo update — early enough
   that the list never goes stale for long;
3. afterwards the required gap **doubles**: `3 → 6 → 12 → 24 → 24 …`
   (cap `maxInterval`) — constant nudging stops, the model still gets pulsed
   reminders on long stretches;
4. any `todo.updated` event (or the model calling `todowrite`) resets the
   schedule back to 3;
5. no todos / everything `completed` / `cancelled` ⇒ completely silent;
6. two reminders never land on consecutive tool calls.

Delivery is one short line **appended to the tool output the model is already
reading** (~25 tokens, no synthetic prompts, no `session.idle` loops):

```text
⏳ [todo-reminder] 2 pending, 1 in progress — statuses look stale, call todowrite to update the list.
```

Options:

```jsonc
// ["todo-reminder.js", { ... }]
{
  "enabled": true,
  "baseInterval": 3,     // first reminder after N calls
  "maxInterval": 24,     // backoff cap
  "message": "TODO: {pending} pending, {inProgress} in progress, {total} total"
}
```

---

## Tests

```sh
npm test        # node --test
```

26 smoke tests cover blocking/allow matrices, nested-command unwrapping,
banlist hot reload, redaction and the reminder schedule/backoff.

## License

MIT
