# 🪖 ClaudeArmy

![Version](https://img.shields.io/badge/version-0.4.0-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Node](https://img.shields.io/badge/node-18%2B-brightgreen)

An MCP server that lets Claude orchestrate multiple Claude Code agents working autonomously across different projects.

![ClaudeArmy Demo](demo.gif)

## What It Does

ClaudeArmy gives Claude (in the chat interface) the ability to spawn background Claude Code processes that work independently on coding tasks. Think of it as a chain of command:

- **You** → give strategic direction
- **Claude (chat)** → breaks it down and dispatches agents
- **Claude Code agents** → execute autonomously, spawning their own sub-agents as needed

This means you can kick off work across multiple projects simultaneously, keep chatting normally, and check in on progress whenever you want.

## Tools

| Tool | Description |
|------|-------------|
| `dispatch_task` | Deploy a Claude Code agent to a project directory. Supports `mode: "team"` for multi-agent coordination |
| `check_tasks` | Monitor status of all running/completed agents |
| `get_task_output` | Retrieve what an agent did and its full output |
| `get_agent_team` | Detailed view of a lead agent and all its sub-agents |
| `cancel_task` | Stop a running agent gracefully |
| `purge_tasks` | Clean up completed/failed tasks |

## Setup

1. Clone this repo
2. `npm install`
3. Add to your Claude Desktop config:

   - **Linux:** `~/.config/Claude/claude_desktop_config.json`
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
"claude-army": {
  "command": "node",
  "args": ["/path/to/claude-army/src/index.js"]
}
```

> **Windows note:** Use forward slashes in the path value (e.g. `"C:/Users/you/claude-army/src/index.js"`).

4. Restart Claude Desktop

## Usage Examples

**Single project task:**
> "Refactor GarbageFire's app.py into modular components"

**Multi-project parallel work:**
> "Refactor GarbageFire to be more modular, and add a Salesforce adapter to my Reporting Tool"

Claude will dispatch separate agents to each project directory and let them work autonomously.

**Check progress:**
> "How are the agents doing?"

## Agent Teams

Use `mode: "team"` on `dispatch_task` to have the lead agent automatically decompose work and spawn specialized sub-agents that run in parallel.

**How it works:**
- The lead agent analyzes the task and breaks it into focused subtasks
- Each subtask is delegated to a sub-agent via Claude Code's `Task` tool
- Sub-agents work in parallel, each with a well-defined scope
- The lead agent synthesizes results once all sub-agents complete

**Monitoring teams:**
- `check_tasks` shows a sub-agent summary (e.g. "3 sub-agents: 1 running, 2 completed")
- `get_agent_team` gives a detailed tree view of the lead agent and every sub-agent, including status, runtime, and output previews

## Configuration

Edit the constants at the top of `src/index.js`:

- `CLAUDE_BINARY` - Path to your Claude Code binary
- `MAX_CONCURRENT_TASKS` - Max simultaneous agents (default: 5)

## Requirements

- Claude Code installed and authenticated
- Node.js 18+
- Claude Desktop or any MCP-compatible client

## Changelog

### v0.4.0
- Agent team support: track sub-agents spawned via Claude Code Task tool
- New `get_agent_team` tool: tree view of lead + all sub-agents
- `check_tasks` now shows sub-agent summary for team operations
- `dispatch_task` gains `mode` parameter: `solo` (default) or `team`
- Cross-platform: fixed Windows binary (`claude.cmd`) and signal handling
- Error messages now show platform-appropriate diagnostic commands
- README: added setup paths for Linux, macOS, and Windows

### v0.3.0
- Fixed stream-json parsing to correctly handle assistant message content arrays
- Staleness indicator: `check_tasks` now shows time since last agent activity
- Better error surfacing: actionable messages for CLI not found, permission denied, and mid-run failures
- Fixed output duplication in `get_task_output`
- Demo GIF added to README

### v0.2.0
- Real-time progress tracking via Claude Code's stream-json output
- `check_tasks` now shows recent agent activity (file reads, edits, bash commands) instead of just runtime
- `get_task_output` includes a full progress timeline with timestamps
- Structured event parsing for tool use, assistant messages, and results

### v0.1.0
- Initial release
- Core tools: dispatch_task, check_tasks, get_task_output, cancel_task, purge_tasks
- Fire-and-forget architecture with background process management
- Max 5 concurrent agents
- stdio transport for MCP communication

## License

MIT
