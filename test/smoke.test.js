import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import noEnv from "../no-env.js"
import commandsBanlist from "../commands-banlist.js"
import todoReminder from "../todo-reminder.js"

const mkd = () => fs.mkdtempSync(path.join(os.tmpdir(), "opencode-utils-"))

// Minimal async event bus matching ctx.event.subscribe({ signal }).
function makeBus() {
  const queue = []
  const waiters = []
  let closed = false
  const flush = () => {
    while (queue.length && waiters.length) waiters.shift()({ value: queue.shift(), done: false })
  }
  return {
    push(ev) {
      queue.push(ev)
      flush()
    },
    close() {
      closed = true
      while (waiters.length) waiters.shift()({ value: undefined, done: true })
    },
    subscribe({ signal } = {}) {
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
          if (closed || signal?.aborted) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiters.push(resolve)
            signal?.addEventListener("abort", () => resolve({ value: undefined, done: true }), { once: true })
          })
        },
        return() {
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

// A fake V2 plugin context that records registered hooks.
async function makeCtx(dir, options, plugin) {
  const hooks = {}
  const bus = makeBus()
  const record = async (name, cb) => {
    ;(hooks[name] ??= []).push(cb)
    return { dispose: async () => {} }
  }
  const ctx = {
    options,
    app: { version: "test" },
    location: { directory: dir, project: { id: "p", directory: dir, canonical: dir } },
    tool: { hook: record },
    shell: { hook: record },
    event: { subscribe: (o) => bus.subscribe(o) },
  }
  const cleanup = await plugin.setup(ctx)
  await new Promise((r) => setTimeout(r, 0)) // let the event loop subscribe
  const run = (name, event) => {
    let chain = Promise.resolve()
    for (const cb of hooks[name] ?? []) chain = chain.then(() => cb(event))
    return chain
  }
  return {
    hooks,
    bus,
    cleanup,
    before: (event) => run("execute.before", event),
    after: (event) => run("execute.after", event),
    shellBefore: (event) => run("create.before", event),
  }
}

const toolEvent = (tool, input) => ({ tool, sessionID: "s", agent: "build", messageID: "m", id: "c", input })

// ---------------------------------------------------------------- no-env ---

{
  const dir = mkd()
  fs.writeFileSync(path.join(dir, ".env"), "SECRET_TOKEN=sk-test-abcdef1234567890\nAPI_URL=https://api.example.com\n")
  fs.writeFileSync(path.join(dir, ".env.example"), "SECRET_TOKEN=\n")
  const p = await makeCtx(dir, {}, noEnv)

  test("no-env: exports a V2 plugin definition", () => {
    assert.equal(typeof noEnv.id, "string")
    assert.equal(typeof noEnv.setup, "function")
  })

  test("no-env: blocks read tool on .env", async () => {
    await assert.rejects(() => p.before(toolEvent("read", { path: ".env" })), /env read access restricted/)
    await assert.rejects(() => p.before(toolEvent("read", { path: "cfg/.env.local" })), /env read access restricted/)
  })

  test("no-env: allows read of .env.example", async () => {
    await p.before(toolEvent("read", { path: ".env.example" }))
  })

  test("no-env: allows write/edit of .env", async () => {
    await p.before(toolEvent("write", { path: ".env", content: "A=1" }))
    await p.before(toolEvent("edit", { path: ".env" }))
    await p.before(toolEvent("patch", { path: ".env" }))
  })

  test("no-env: blocks shell readers of .env", async () => {
    for (const cmd of [
      "cat .env",
      "cat .env.local",
      "head -n 5 .env",
      "grep SECRET .env",
      "source .env",
      ". .env",
      "cat < .env",
      "cat config/.env",
      "sudo cat .env",
      "cat .env | head -2",
      "wc -l .env",
      "base64 .env",
      "node --env-file=.env app.js",
    ]) {
      await assert.rejects(() => p.before(toolEvent("shell", { command: cmd })), /env read access restricted/, `expected block: ${cmd}`)
    }
  })

  test("no-env: blocks nested commands", async () => {
    for (const cmd of [
      'ssh -c "cat .env"',
      "bash -c 'cat .env'",
      'sh -c "grep KEY .env"',
      `python3 -c "print(open('.env').read())"`,
      `python3 -c "import os; os.system('cat .env')"`,
      `node -e "console.log(require('fs').readFileSync('.env','utf8'))"`,
      'bash -c "sh -c \\"cat .env\\""',
    ]) {
      await assert.rejects(() => p.before(toolEvent("shell", { command: cmd })), /env read access restricted/, `expected block: ${cmd}`)
    }
  })

  test("no-env: allows writes and $VAR insertion", async () => {
    for (const cmd of [
      'curl -H "Authorization: Bearer $API_KEY" https://api.example.com',
      "echo NEW_KEY=1 >> .env",
      "echo hi > .env",
      "sed -i 's/a/b/' .env",
      "cat .env.example",
      "ls .env",
      "echo .env",
      "rm -f .env",
      `python3 -c "open('.env','w').write('A=1')"`,
      "grep -r API_KEY src/",
    ]) {
      await p.before(toolEvent("shell", { command: cmd }))
    }
  })

  test("no-env: prose that merely mentions .env is allowed", async () => {
    for (const cmd of [
      `git commit -m "Port plugins: .env is writable, secrets are redacted"`,
      `git commit -m 'mention .env* and .env.example in the docs'`,
      `echo "see .env for details"`,
      `printf 'note: .env is gitignored\\n'`,
    ]) {
      await p.before(toolEvent("shell", { command: cmd }), `expected allow: ${cmd}`)
    }
  })

  test("no-env: blocks grep tool targeting .env", async () => {
    await assert.rejects(() => p.before(toolEvent("grep", { pattern: "KEY", path: ".env" })), /env read access restricted/)
    await assert.rejects(() => p.before(toolEvent("grep", { pattern: "KEY", include: "**/.env*" })), /env read access restricted/)
    await p.before(toolEvent("grep", { pattern: "API_KEY" }))
  })

  test("no-env: glob is allowed (names only)", async () => {
    await p.before(toolEvent("glob", { pattern: "**/.env*" }))
  })

  test("no-env: redacts secret values from result.content", async () => {
    const result = { content: "connected with sk-test-abcdef1234567890 ok", metadata: {} }
    await p.after({ tool: "shell", sessionID: "s", status: "completed", input: {}, result })
    assert.match(result.content, /\[REDACTED:SECRET_TOKEN\]/)
    assert.ok(!result.content.includes("sk-test-abcdef1234567890"))
  })

  test("no-env: redacts array content and output", async () => {
    const result = {
      content: [{ type: "text", text: "key sk-test-abcdef1234567890" }],
      output: "also sk-test-abcdef1234567890",
      metadata: { nested: "sk-test-abcdef1234567890" },
    }
    await p.after({ tool: "read", sessionID: "s", status: "completed", input: {}, result })
    assert.match(result.content[0].text, /\[REDACTED:SECRET_TOKEN\]/)
    assert.match(result.output, /\[REDACTED:SECRET_TOKEN\]/)
    assert.match(result.metadata.nested, /\[REDACTED:SECRET_TOKEN\]/)
  })

  test("no-env: keeps non-sensitive values readable", async () => {
    const result = { content: "base = https://api.example.com" }
    await p.after({ tool: "shell", sessionID: "s", status: "completed", input: {}, result })
    assert.match(result.content, /https:\/\/api\.example\.com/)
  })

  test("no-env: file.edited triggers a rescan of new values", async () => {
    const evtDir = mkd()
    fs.writeFileSync(path.join(evtDir, ".env"), "API_KEY=oldvalue123456\n")
    const evt = await makeCtx(evtDir, { rescanInterval: 0 }, noEnv)
    fs.writeFileSync(path.join(evtDir, ".env"), "API_KEY=oldvalue123456\nROTATED_PASSWORD=hunter2-not-secret-value\n")
    evt.bus.push({ type: "file.edited", data: { file: path.join(evtDir, ".env") } })
    await new Promise((r) => setTimeout(r, 30))
    const result = { content: "pw hunter2-not-secret-value" }
    await evt.after({ tool: "shell", sessionID: "s", status: "completed", input: {}, result })
    assert.match(result.content, /\[REDACTED:ROTATED_PASSWORD\]/)
  })

  test("no-env: re-reads new .env values from disk without any event", async () => {
    const d2 = mkd()
    fs.writeFileSync(path.join(d2, ".env"), "API_KEY=oldvalue123456\n")
    const q = await makeCtx(d2, { rescanInterval: 0 }, noEnv)
    // simulate an external/agent edit after the initial scan
    fs.writeFileSync(path.join(d2, ".env"), "API_KEY=oldvalue123456\nBRAND_NEW_PASSWORD=freshsecretvalue42\n")
    const result = { content: "x freshsecretvalue42 y" }
    await q.after({ tool: "shell", sessionID: "s", status: "completed", input: {}, result })
    assert.match(result.content, /\[REDACTED:BRAND_NEW_PASSWORD\]/)
  })

  test("no-env: disabled option turns checks off", async () => {
    const off = await makeCtx(dir, { enabled: false, redact: false }, noEnv)
    await off.before(toolEvent("read", { path: ".env" }))
    await off.before(toolEvent("shell", { command: "cat .env" }))
  })
}

// ------------------------------------------------------- commands-banlist ---

{
  const dir = mkd()
  const banlist = path.join(dir, "banlist")
  fs.writeFileSync(banlist, "# comment\npgrep\n/git\\s+push\\s+--force/\nrm -rf /\n")
  const p = await makeCtx(dir, { path: banlist }, commandsBanlist)
  const shell = (command) => p.before(toolEvent("shell", { command }))

  test("banlist: exports a V2 plugin definition", () => {
    assert.equal(typeof commandsBanlist.id, "string")
    assert.equal(typeof commandsBanlist.setup, "function")
  })

  test("banlist: blocks plain pattern", async () => {
    await assert.rejects(() => shell("pgrep node"), /command is blacklisted.*pgrep/s)
    await assert.rejects(() => shell("rm -rf / --no-preserve-root"), /command is blacklisted/s)
  })

  test("banlist: blocks nested commands", async () => {
    for (const cmd of [
      'ssh -c "pgrep foo"',
      "bash -c 'pgrep -x ssh'",
      'sh -c "echo a && pgrep"',
      `python3 -c "import os; os.system('pgrep')"`,
      "echo hi; pgrep",
      "ls && pgrep || true",
      'bash -c "sh -c \\"pgrep\\""',
    ]) {
      await assert.rejects(() => shell(cmd), /command is blacklisted/, `expected block: ${cmd}`)
    }
  })

  test("banlist: regex pattern", async () => {
    await assert.rejects(() => shell("git push --force origin main"), /command is blacklisted/s)
    await shell("git push origin main")
  })

  test("banlist: clean commands pass", async () => {
    await shell("echo hi")
    await shell("ls -la")
    await shell("git status")
  })

  test("banlist: hot reload on file change", async () => {
    await shell("htop")
    fs.writeFileSync(banlist, fs.readFileSync(banlist, "utf8") + "\nhtop\n")
    await assert.rejects(() => shell("htop"), /command is blacklisted/s)
  })

  test("banlist: missing file disables the plugin", async () => {
    const off = await makeCtx(dir, { path: path.join(dir, "no-such-banlist") }, commandsBanlist)
    await off.before(toolEvent("shell", { command: "pgrep node" }))
  })

  test("banlist: other tools are not inspected", async () => {
    await p.before(toolEvent("read", { path: "x" }))
  })
}

// ---------------------------------------------------------- todo-reminder ---

test("todo-reminder: is an inert, valid V2 definition (deprecated)", async () => {
  assert.equal(typeof todoReminder.id, "string")
  assert.equal(typeof todoReminder.setup, "function")

  const hooks = {}
  const ctx = {
    options: {},
    tool: { hook: async (name, cb) => void (hooks[name] = cb) },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }) },
  }
  const warn = console.warn
  let warned = ""
  console.warn = (msg) => {
    warned = String(msg)
  }
  try {
    await todoReminder.setup(ctx)
  } finally {
    console.warn = warn
  }
  assert.deepEqual(Object.keys(hooks), [])
  assert.match(warned, /deprecated/)
})
