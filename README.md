# Iris

Slack ⇄ AI agent bridge — minimal, self-hosted.

<p align="right"><a href="./README.ja.md">日本語</a></p>

Iris connects a Slack workspace to a local [**agent CLI**](https://github.com/earendil-works/pi) —
[Claude Code](https://claude.com/claude-code), [**Pi**](https://github.com/earendil-works/pi), or
**Hermes**. You talk to the agent from a Slack thread or DM; Iris runs it as a
resident process, streams its output back, and turns tool-permission requests
into clickable Slack buttons.

It is a deliberately small tool — **Slack + a selectable agent backend** (Claude Code,
Pi, Hermes, or Copilot) — with no plugin registry, no multi-platform abstraction, no provider
switching, cron, relay, or TTS.

> Named after Iris, the Greek messenger goddess of the rainbow who relays
> between gods and mortals.

## Acknowledgements

Iris is inspired by [**cc-connect**](https://github.com/chenhg5/cc-connect) (MIT),
an excellent general-purpose bridge that connects many AI coding agents to many
messaging platforms. We are grateful for its design ideas.

Iris is **not a fork** — it is an independent implementation that distills those
ideas down to a small set of agent backends (Slack + Claude Code / Pi / Hermes)
for a smaller, more
auditable tool. What we borrowed is the *approach* (driving Claude Code over
`stream-json`, bridging the `stdio` permission tool to chat buttons, the
`NO_REPLY` silence marker); what we dropped is everything that exists to support
the other 100+ agent×platform combinations. If you need broad multi-platform /
multi-agent support, use cc-connect.

## Built with Claude Code

The entire source code of Iris was written by [Claude Code](https://claude.com/claude-code)
(Anthropic's agentic coding tool) — from the initial analysis of cc-connect, through
design, implementation, tests, CI/CD, release automation, and the signed/notarized
macOS binary. It is, fittingly, a tool for Claude Code that was itself built by
Claude Code.

## How it works

```
Slack (Socket Mode) ──▶ index.ts ──▶ session.ts ──▶ <backend> ──▶ agent CLI
    ▲   block_actions                  thread_ts     (claude.ts | pi.ts | hermes.ts)
    └──── chat.postMessage ◀── format.ts ◀──────────────── events
```

- **One Slack thread (or DM) = one agent session = one resident process.**
- Claude Code runs with `--input-format stream-json --output-format stream-json
   --permission-prompt-tool stdio`; Pi and Hermes use their own protocols. Iris
   writes user messages / permission responses to stdin and parses the JSON event
   stream from stdout.
- Permission requests become Block Kit Allow/Deny buttons; the click is routed
   back to the agent. (Claude Code via `control_request`; Hermes via ACP
   `session/request_permission`; Pi via its permission RPC.)
- When a process dies, its `session_id` is kept so the next message resumes it
   (Claude `--resume`, Pi `--session`, Hermes `session/resume`).

## Features

- Channel (@mention + thread) and DM conversations; one thread = one session
- Tool-permission buttons; permission modes (`manual` / `acceptEdits` / `auto`)
- Streaming incremental updates; usage footer (tokens / cost / duration)
- Inbound image & file attachments (images seen directly, files read)
- Outbound generated-file uploads
- Slash commands (`/help` `/status` `/sessions` `/restart` `/clear` `/switch` `/resume` `/summary` `/cc:`)
- `/switch <name>` to change the working directory per session (searches under `work_dir`)
- `/resume` lists past Claude sessions (with turn count & recent prompts); `/resume <id>` reattaches the thread to a session by id (any backend)
- `/summary` summarizes the current conversation for handover (output wrapped in a code block); `/summary <request>` uses your own instruction
- `/cc:<command> [args]` runs Claude Code's own `/<command>` (Claude backend only — for a pi/hermes thread the text is sent as a normal prompt instead)
- Multi-project routing via TOML
- Idle-session reaping: a session's Claude process is closed after `idle_ttl_min` minutes idle (default 24h) to free memory; the thread gets a pause notice, and the next message resumes it via `--resume` (with a resume notice), so no conversation is lost
- Leveled logging (`log_level`), `iris --version`

## Install

**Option A — standalone binary (recommended, no Node required)**

Download the latest binary for your platform from
[Releases](https://github.com/t2tx/iris/releases):

| Platform | Asset | Notes |
|----------|-------|-------|
| macOS arm64 | `iris-macos-arm64.zip` | Apple-signed and notarized |
| Linux x86_64 | `iris-linux-x64.tar.gz` | |
| Linux arm64 | `iris-linux-arm64.tar.gz` | AWS Graviton, Raspberry Pi, etc. |
| Windows x86_64 | `iris-windows-x64.zip` | |

```bash
# macOS / Linux
tar xzf iris-linux-x64.tar.gz   # or unzip iris-macos-arm64.zip
mv iris /usr/local/bin/iris
iris --help

# Windows (PowerShell)
Expand-Archive iris-windows-x64.zip -DestinationPath .
.\iris.exe --help
```

**Option B — npm**

```bash
npm install -g @t2tx/iris
```

> Iris launches the configured **agent** CLI (Claude Code / Pi / Hermes — see
> `agent` below); it does not handle API keys itself. The agent CLI must already
> be authenticated.

## Configuration (TOML)

Generate a starter config with `iris init`, then fill in your tokens and check it:

```bash
iris init           # write a commented config (~/.iris-slack/config.toml, mode 0600; never overwrites)
# → edit it: [slack] tokens + at least one [[projects]]
iris config check   # validate without starting (prints a per-project summary)
iris config path    # show which config file is used
```

All configuration lives in one TOML file, resolved in this order:

1. `IRIS_CONFIG=<path>`
2. `./iris.config.toml` (repo-local — development)
3. `~/.iris-slack/config.toml` (installed default)

```toml
# Top-level keys must come BEFORE [slack] / [[projects]] table headers.
permission_mode = "manual"   # manual | acceptEdits | auto
log_level = "info"           # debug | info | warn | error
# idle_ttl_min = 1440        # close a session's process after N idle minutes (default 1440 = 24h; 0 disables)

[slack]
bot_token = "xoxb-..."
app_token = "xapp-..."

[[projects]]
name = "default"
work_dir = "/path/to/your/repo"
allow_channels = ["C0123ABCDEF"]   # respond to @Iris in this channel
allow_users = ["U09XXXXXXX"]       # respond to this user's DMs
```

- **Routing**: an inbound message matches the first project whose
  `allow_channels` (channel) / `allow_users` (DM) include it; no match → ignored.
- Add multiple `[[projects]]` for different work dirs / permission modes per
  channel or user. Template: [iris.config.example.toml](./iris.config.example.toml).

### Choosing an agent backend

By default Iris drives [Claude Code](https://claude.com/claude-code) (`claude`
CLI). It can also drive the [**Pi** coding agent](https://github.com/earendil-works/pi)
(`agent = "pi"`), [**Hermes**](https://github.com/hermes-agent/hermes) (`agent = "hermes"`),
or [**Copilot CLI**](https://github.com/features/copilot) over the Agent Client
Protocol (`agent = "copilot"`), selected per project (or as the top-level default).

> The Copilot backend drives the `copilot` CLI in its ACP mode (`copilot --acp`) — the same
> protocol Iris uses for Hermes. You must have the Copilot CLI installed and signed in on the
> host (Copilot uses its own local auth); Iris never handles a Copilot credential or API key.
> Copilot's ACP mode is autonomy-first: there is no per-action approval from Slack, so the tool
> policy is set once at process start by the project's `permission_mode` (`auto` →
> `--allow-all`, `acceptEdits` → `--allow-tool 'write'`, `manual` → Copilot's declared-policy
default).

Select the backend with the top-level `agent` key (default `claude`, override per
project). The default Claude backend needs no change — `agent` unset means
`claude`.

```toml
# Use Pi for every project (top-level default; per-project can override):
agent = "pi"
# pi_bin = "pi"             # PATH to the Pi CLI (default "pi"; override if not on PATH)

# Or drive Hermes via the Agent Client Protocol (ACP) instead:
# agent = "hermes"
# hermes_bin = "hermes"       # PATH to the Hermes CLI (default "hermes"; override if not on PATH)

# Or drive Copilot CLI over ACP (copilot must be installed and signed in locally):
# agent = "copilot"
# copilot_bin = "copilot"     # PATH to the Copilot CLI (default "copilot"; override if not on PATH)

[[projects]]
name = "pi-lab"
work_dir = "/path/to/your/repo"
allow_users = ["U09XXXXXXX"]
# agent = "pi"             # per-project override (omitted inherits top-level)
```

**Installing Pi:** Iris only launches the `pi` CLI; it does not install it.
Install and authenticate Pi by following the
[Pi repository](https://github.com/earendil-works/pi) instructions. Point
`pi_bin` at it if it is not on your `PATH`.

**Driving Hermes:** Iris launches `hermes acp`, which speaks the
[Agent Client Protocol](https://agentclientprotocol.com/); it does not install
it or manage its model configuration. Install Hermes, configure a model, and
ensure its ACP dependency (`agent-client-protocol`) is available, following the
Hermes setup instructions. Point `hermes_bin` at the CLI if it is not on your
`PATH`. The three backends share the same outbox / session-resume contract; only
the wire protocol differs (Claude Code = `stream-json` + `std`io permission tool,
Pi = its own RPC, Hermes = ACP / JSON-RPC).

All backends expose the same surface to Slack (tool-permission buttons,
progress, session resume); only the underlying CLI differs.

Slack app setup walkthrough: [docs/slack-setup.md](./docs/slack-setup.md) (Japanese).

## Run

```bash
iris            # run in the foreground (all platforms)
iris install    # install as a launchd service — macOS only (auto-start on login)
iris status     # show launchd service status — macOS only
```

## Security notes

- **Default-deny**: with empty `allow_channels` / `allow_users`, Iris ignores
  every message.
- **Manual permission mode by default**: every tool use needs an explicit click.
  `acceptEdits` auto-allows edit tools; `auto` allows everything — opt in only
  if you trust the peer.
- No outbound integrations (cron/relay/provider-switch). Attack surface is just
  Slack-in → Claude-CLI-out.
- Tokens live only in the TOML config file — protect it (`chmod 600`).

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
