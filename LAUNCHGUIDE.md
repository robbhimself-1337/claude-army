# ClaudeArmy

## Tagline
Orchestrate multiple Claude Code agents in parallel from a single chat interface.

## Description
ClaudeArmy is an MCP server that lets Claude spawn and manage multiple Claude Code agents working autonomously across different project directories — all from a single chat interface. Dispatch solo agents for focused tasks, or activate team mode to have a lead agent automatically decompose complex work and coordinate specialized sub-agents running in parallel. Monitor progress, inspect agent teams, retrieve full output, and cancel agents on demand — without leaving your conversation.

## Setup Requirements
No API keys or environment variables are required. ClaudeArmy runs entirely locally, but the following must be installed and configured before use:

- **Claude Desktop** must be installed and granted filesystem and process execution permissions by your OS. On macOS this requires Full Disk Access in System Settings → Privacy & Security. On Windows, ensure Claude Desktop has permission to spawn child processes.
- **Claude Code CLI** must be installed (`npm install -g @anthropic-ai/claude-code`), authenticated with an active Anthropic account, and available on your PATH.

## Category
Developer Tools

## Use Cases
Coding, Refactoring, Code Review, Architecture Analysis, Parallel Development, Task Automation, Multi-Agent Orchestration

## Features
- Dispatch Claude Code agents to any project directory from chat
- Team mode: lead agent decomposes tasks and spawns parallel sub-agents automatically
- Real-time progress tracking: see file reads, edits, and bash commands as they happen
- get_agent_team tool gives a live tree view of lead agent and all sub-agents
- check_tasks shows running/completed counts and last activity timestamps
- get_task_output retrieves full agent output including a timestamped progress timeline
- Cancel or purge agents at any time
- Run up to 5 concurrent agents across different projects simultaneously
- Cross-platform: works on Linux, macOS, and Windows

## Getting Started
- "Refactor the authentication module in ~/my-project to use JWT tokens"
- "Run a read-only audit of ~/my-project and summarize the architecture"
- "Refactor ~/project-a and add test coverage to ~/project-b at the same time"
- "How are the agents doing?"
- "Show me the full output from the last agent"
- Tool: dispatch_task — Deploy a Claude Code agent to a project directory. Use mode: "team" for complex tasks that benefit from parallel sub-agents
- Tool: check_tasks — Monitor all running and completed agents with live status
- Tool: get_agent_team — Get a detailed tree view of a lead agent and all its sub-agents
- Tool: get_task_output — Retrieve the full output and progress timeline from any agent

## Tags
mcp, claude-code, agents, orchestration, multi-agent, automation, developer-tools, parallel, coding-assistant

## Documentation URL
https://github.com/robbhimself-1337/claude-army
