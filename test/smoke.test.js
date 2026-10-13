import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import noEnv from "../no-env.js"
import commandsBanlist from "../commands-banlist.js"
import todoReminder from "../todo-reminder.js"

const mkd = () => fs.mkdtempSync(path.join(os.tmpdir(), "opencode-utils-"))

function makeInput(dir, client) {
  return {
    directory: dir,
    worktree: dir,
    client: client ?? { session: { todo: async () => ({ data: [] }) } },
    project: {},
    $: null,
    serverUrl: new URL("http://localhost"),
    experimental_workspace: { register() {} },
  }
}

// ---------------------------------------------------------------- no-env ---

{
  const dir = mkd()
  fs.writeFileSync(path.join(dir, ".env"), "SECRET_TOKEN=sk-test-abcdef1234567890\nAPI_URL=https://api.example.com\n")
  fs.writeFileSync(path.join(dir, ".env.example"), "SECRET_TOKEN=\n")
  const hooks = await noEnv(makeInput(dir), {})
  const before = hooks["tool.execute.before"]
  const after = hooks["tool.execute.after"]

  const shell = (command) => before({ tool: "shell", sessionID: "s", callID: "c" }, { args: { command } })

  test("no-env: blocks read tool on .env", async () => {
    await assert.rejects(
      () => before({ tool: "read", sessionID: "s", callID: "c" }, { args: { path: ".env" } }),
      /env read access restricted/,
    )
    await assert.rejects(
      () => before({ tool: "read", sessionID: "s", callID: "c" }, { args: { path: "cfg/.env.local" } }),
      /env read access restricted/,
    )
  })

  test("no-env: allows read of .env.example", async () => {
    await before({ tool: "read", sessionID: "s", callID: "c" }, { args: { path: ".env.example" } })
  })

  test("no-env: allows write/edit of .env", async () => {
    await before({ tool: "write", sessionID: "s", callID: "c" }, { args: { path: ".env", content: "A=1" } })
    await before({ tool: "edit", sessionID: "s", callID: "c" }, { args: { path: ".env" } })
    await before({ tool: "patch", sessionID: "s", callID: "c" }, { args: { path: ".env" } })
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
      await assert.rejects(() => shell(cmd), /env read access restricted/, `expected block: ${cmd}`)
    }
  })

  test("no-env: blocks nested commands", async () => {
    for (const cmd of [
      'ssh -c "cat .env"',
      "bash -c 'cat .env'",
      'sh -c "grep KEY .env"',
      `python3 -c "print(open('.env').read())"`,
      'node -e "console.log(require(\'fs\').readFileSync(\'.env\',\'utf8\'))"',
      'bash -c "sh -c \\"cat .env\\""',
    ]) {
      await assert.rejects(() => shell(cmd), /env read access restricted/, `expected block: ${cmd}`)
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
      await before({ tool: "shell", sessionID: "s", callID: "c" }, { args: { command: cmd } })
    }
  })

  test("no-env: blocks grep tool targeting .env", async () => {
    await assert.rejects(
      () => before({ tool: "grep", sessionID: "s", callID: "c" }, { args: { pattern: "KEY", path: ".env" } }),
      /env read access restricted/,
    )
    await assert.rejects(
      () => before({ tool: "grep", sessionID: "s", callID: "c" }, { args: { pattern: "KEY", include: "**/.env*" } }),
      /env read access restricted/,
    )
    await before({ tool: "grep", sessionID: "s", callID: "c" }, { args: { pattern: "API_KEY" } })
  })

  test("no-env: glob is allowed (names only)", async () => {
    await before({ tool: "glob", sessionID: "s", callID: "c" }, { args: { pattern: "**/.env*" } })
  })

  test("no-env: redacts secret values from tool output", async () => {
    const output = { title: "t", output: "connected with sk-test-abcdef1234567890 ok", metadata: {} }
    await after({ tool: "shell", sessionID: "s", callID: "c", args: {} }, output)
    assert.match(output.output, /\[REDACTED:SECRET_TOKEN\]/)
    assert.ok(!output.output.includes("sk-test-abcdef1234567890"))
  })

  test("no-env: keeps non-sensitive values readable", async () => {
    const output = { title: "t", output: "base = https://api.example.com", metadata: {} }
    await after({ tool: "shell", sessionID: "s", callID: "c", args: {} }, output)
    assert.match(output.output, /https:\/\/api\.example\.com/)
  })

  test("no-env: disabled option turns checks off", async () => {
    const off = await noEnv(makeInput(dir), { enabled: false, redact: false })
    await off["tool.execute.before"]({ tool: "read", sessionID: "s", callID: "c" }, { args: { path: ".env" } })
    await off["tool.execute.before"]({ tool: "shell", sessionID: "s", callID: "c" }, { args: { command: "cat .env" } })
  })
}

// ------------------------------------------------------- commands-banlist ---

{
  const dir = mkd()
  const banlist = path.join(dir, "banlist")
  fs.writeFileSync(banlist, "# comment\npgrep\n/git\\s+push\\s+--force/\nrm -rf /\n")
  const hooks = await commandsBanlist(makeInput(dir), { path: banlist })
  const before = hooks["tool.execute.before"]
  const shell = (command) => before({ tool: "shell", sessionID: "s", callID: "c" }, { args: { command } })

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
    const missing = path.join(dir, "no-such-banlist")
    const off = await commandsBanlist(makeInput(dir), { path: missing })
    await off["tool.execute.before"]({ tool: "shell", sessionID: "s", callID: "c" }, { args: { command: "pgrep node" } })
  })

  test("banlist: other tools are not inspected", async () => {
    await before({ tool: "read", sessionID: "s", callID: "c" }, { args: { path: "x" } })
  })
}

// ---------------------------------------------------------- todo-reminder ---

{
  const dir = mkd()
  const client = {
    session: {
      todo: async ({ path: p }) => ({
        data: p.id === "empty" ? [] : [{ content: "fetched", status: "pending" }],
      }),
    },
  }
  const hooks = await todoReminder(makeInput(dir, client), {})
  const after = hooks["tool.execute.after"]
  const event = hooks.event

  const todos = (statuses) => statuses.map((status, i) => ({ content: `t${i}`, status }))
  const call = async (tool = "read", out = "result") => {
    const o = { title: "t", output: out, metadata: {} }
    await after({ tool, sessionID: "s1", callID: "c", args: {} }, o)
    return o
  }

  test("todo-reminder: silent without todos", async () => {
    const o = { title: "t", output: "x", metadata: {} }
    await after({ tool: "read", sessionID: "empty", callID: "c", args: {} }, o)
    await after({ tool: "read", sessionID: "empty", callID: "c", args: {} }, o)
    await after({ tool: "read", sessionID: "empty", callID: "c", args: {} }, o)
    await after({ tool: "read", sessionID: "empty", callID: "c", args: {} }, o)
    assert.ok(!o.output.includes("[todo-reminder]"), o.output)
  })

  test("todo-reminder: first reminder after baseInterval calls", async () => {
    await event({ event: { type: "todo.updated", properties: { sessionID: "s1", todos: todos(["pending", "pending"]) } } })

    const o1 = await call("read", "a")
    const o2 = await call("bash", "b")
    assert.ok(!o2.output.includes("[todo-reminder]"))

    const o3 = await call("bash", "c")
    assert.match(o3.output, /\[todo-reminder\]/)
    assert.match(o3.output, /2 pending/)
    assert.ok(o3.output.startsWith("c"), "original output preserved")
  })

  test("todo-reminder: backoff — no reminder on calls 4,5, reminder on 6", async () => {
    const o4 = await call("bash", "d")
    const o5 = await call("bash", "e")
    assert.ok(!o4.output.includes("[todo-reminder]"))
    assert.ok(!o5.output.includes("[todo-reminder]"))
    const o6 = await call("bash", "f")
    assert.match(o6.output, /\[todo-reminder\]/)
  })

  test("todo-reminder: todowrite resets the schedule", async () => {
    await after(
      { tool: "todowrite", sessionID: "s1", callID: "c", args: { todos: todos(["pending", "in_progress"]) } },
      { title: "t", output: "ok", metadata: {} },
    )
    const o1 = await call("bash", "g")
    const o2 = await call("bash", "h")
    assert.ok(!o1.output.includes("[todo-reminder]"))
    assert.ok(!o2.output.includes("[todo-reminder]"))
    const o3 = await call("bash", "i")
    assert.match(o3.output, /\[todo-reminder\]/)
    assert.match(o3.output, /1 pending, 1 in progress/)
  })

  test("todo-reminder: todo.updated event resets too", async () => {
    await event({ event: { type: "todo.updated", properties: { sessionID: "s1", todos: todos(["pending"]) } } })
    await call("bash", "j")
    await call("bash", "k")
    const o3 = await call("bash", "l")
    assert.match(o3.output, /\[todo-reminder\]/)
  })

  test("todo-reminder: silent when everything is completed", async () => {
    await event({
      event: { type: "todo.updated", properties: { sessionID: "s1", todos: todos(["completed", "completed"]) } },
    })
    for (let i = 0; i < 10; i++) {
      const o = await call("bash", `done-${i}`)
      assert.ok(!o.output.includes("[todo-reminder]"))
    }
  })

  test("todo-reminder: lazily fetches todos for fresh sessions", async () => {
    const mk = (x) => ({ title: "t", output: x, metadata: {} })
    const o1 = mk("x")
    await after({ tool: "read", sessionID: "lazy", callID: "c", args: {} }, o1)
    const o2 = mk("x")
    await after({ tool: "read", sessionID: "lazy", callID: "c", args: {} }, o2)
    const o3 = mk("x")
    await after({ tool: "read", sessionID: "lazy", callID: "c", args: {} }, o3)
    assert.ok(!o1.output.includes("[todo-reminder]"))
    assert.ok(!o2.output.includes("[todo-reminder]"))
    assert.match(o3.output, /\[todo-reminder\]/) // client returned 1 pending todo
  })

  test("todo-reminder: custom message and intervals", async () => {
    const custom = await todoReminder(makeInput(dir, client), {
      baseInterval: 2,
      maxInterval: 4,
      message: "TODO CHECK: {pending} left",
    })
    const e = custom.event
    const a = custom["tool.execute.after"]
    await e({ event: { type: "todo.updated", properties: { sessionID: "s2", todos: todos(["pending"]) } } })
    const o1 = { title: "t", output: "1", metadata: {} }
    await a({ tool: "read", sessionID: "s2", callID: "c", args: {} }, o1)
    const o2 = { title: "t", output: "2", metadata: {} }
    await a({ tool: "read", sessionID: "s2", callID: "c", args: {} }, o2)
    assert.ok(!o1.output.includes("TODO CHECK"))
    assert.match(o2.output, /TODO CHECK: 1 left/)
  })
}
