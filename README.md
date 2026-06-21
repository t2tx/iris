# Iris

Slack ⇄ Claude Code bridge — minimal, self-hosted.

<p align="right"><a href="./README.ja.md">日本語</a></p>

Iris connects a Slack workspace to a local [Claude Code](https://claude.com/claude-code)
CLI. You talk to Claude from a Slack thread or DM; Iris runs Claude Code as a
resident process, streams its output back, and turns tool-permission requests
into clickable Slack buttons.

It is a deliberately small, single-purpose tool — **Slack + Claude Code only** —
with no plugin registry, no multi-platform/multi-agent abstraction, no provider
switching, cron, relay, or TTS.

> Named after Iris, the Greek messenger goddess of the rainbow who relays
> between gods and mortals.

## Acknowledgements

Iris is inspired by [**cc-connect**](https://github.com/chenhg5/cc-connect) (MIT),
an excellent general-purpose bridge that connects many AI coding agents to many
messaging platforms. We are grateful for its design ideas.

Iris is **not a fork** — it is an independent implementation that distills those
ideas down to a single combination (Slack + Claude Code) for a smaller, more
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
Slack (Socket Mode) ──▶ index.ts ──▶ session.ts ──▶ claude.ts ──▶ claude CLI
   ▲   block_actions                  thread_ts          stream-json (stdin/stdout)
   └──── chat.postMessage ◀── format.ts ◀──────────────── events
```

- **One Slack thread (or DM) = one Claude session = one resident process.**
- Claude runs with `--input-format stream-json --output-format stream-json
  --permission-prompt-tool stdio`. Iris writes user messages / permission
  responses to stdin and parses the JSON event stream from stdout.
- Permission requests (`control_request` → `can_use_tool`) become Block Kit
  Allow/Deny buttons; the click is routed back via `control_response`.
- When a process dies, its `session_id` is kept so the next message resumes it
  with `--resume`.

## Features

- Channel (@mention + thread) and DM conversations; one thread = one session
- Tool-permission buttons; permission modes (`manual` / `acceptEdits` / `auto`)
- Streaming incremental updates; usage footer (tokens / cost / duration)
- Inbound image & file attachments (images seen directly, files read)
- Outbound generated-file uploads
- Slash commands (`/help` `/status` `/sessions` `/restart` `/clear` `/switch` `/resume` `/summary`)
- `/switch <name>` to change the working directory per session (searches under `work_dir`)
- `/resume` lists past Claude sessions (with turn count & recent prompts); `/resume <id>` reattaches the thread
- `/summary` summarizes the current conversation for handover (output wrapped in a code block); `/summary <request>` uses your own instruction
- Multi-project routing via TOML
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

> Iris launches the `claude` CLI; it does not handle API keys itself. The
> `claude` CLI must already be authenticated.

## Configuration (TOML)

All configuration lives in one TOML file, resolved in this order:

1. `IRIS_CONFIG=<path>`
2. `./iris.config.toml` (repo-local — development)
3. `~/.iris-slack/config.toml` (installed default)

```toml
# Top-level keys must come BEFORE [slack] / [[projects]] table headers.
permission_mode = "manual"   # manual | acceptEdits | auto
log_level = "info"           # debug | info | warn | error

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
