#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import path from "path";

// ─── Configuration ───────────────────────────────────────────────────────────
const IS_WINDOWS = process.platform === "win32";
const CLAUDE_BINARY = IS_WINDOWS ? "claude.cmd" : "claude";
const MAX_CONCURRENT_TASKS = 5;
const OUTPUT_POLL_INTERVAL_MS = 500;

// ─── Task Store ──────────────────────────────────────────────────────────────
const tasks = new Map();

class Task {
  constructor(id, description, workingDir, options = {}) {
    this.id = id;
    this.description = description;
    this.workingDir = workingDir;
    this.status = "starting"; // starting | running | completed | failed | cancelled
    this.process = null;
    this.stdout = "";
    this.stderr = "";
    this.exitCode = null;
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.model = options.model || null;
    this.permissionMode = options.permissionMode || "default";
    // Progress tracking
    this.progressLog = [];    // [{timestamp, type, summary}]
    this.lastActivity = null; // ISO timestamp of last event
    this.resultText = "";     // Final assembled output from stream events
    this._stdoutBuffer = "";  // Buffer for incomplete JSON lines
    // Sub-agent tracking
    this.subAgents = [];
    this._pendingTaskTools = new Map();
  }

  addProgress(type, summary) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      summary,
    };
    this.progressLog.push(entry);
    this.lastActivity = entry.timestamp;
    // Keep last 50 entries to avoid memory bloat
    if (this.progressLog.length > 50) {
      this.progressLog = this.progressLog.slice(-50);
    }
  }

  getLatestProgress(count = 3) {
    return this.progressLog.slice(-count);
  }

  addSubAgent(toolUseId, description) {
    const subAgent = {
      id: `sub-${this.subAgents.length + 1}`,
      toolUseId,
      description: (description || "Unknown task").slice(0, 120),
      status: "running",
      dispatchedAt: new Date().toISOString(),
      completedAt: null,
      outputPreview: null,
    };
    this.subAgents.push(subAgent);
    this._pendingTaskTools.set(toolUseId, subAgent);
    return subAgent;
  }

  completeSubAgent(toolUseId, output) {
    const subAgent = this._pendingTaskTools.get(toolUseId);
    if (!subAgent) return null;
    subAgent.status = "completed";
    subAgent.completedAt = new Date().toISOString();
    subAgent.outputPreview = output ? String(output).slice(0, 300) : null;
    this._pendingTaskTools.delete(toolUseId);
    return subAgent;
  }

  toJSON() {
    return {
      id: this.id,
      description: this.description,
      workingDir: this.workingDir,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      exitCode: this.exitCode,
      model: this.model,
      permissionMode: this.permissionMode,
      outputLength: this.resultText.length || this.stdout.length,
      hasErrors: this.stderr.length > 0,
      progressEntries: this.progressLog.length,
    };
  }
}

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Parse a tool_use content block into a progress entry.
 * Reusable for tool_use blocks found inside assistant message content arrays
 * and for top-level tool_use events.
 */
function parseToolUseBlock(block) {
  const toolName = block.name || "unknown_tool";
  const input = block.input || {};

  switch (toolName) {
    case "Read":
    case "View":
    case "read_file":
      return { type: "read", summary: `📖 Reading: ${input.file_path || input.path || "file"}` };

    case "Write":
    case "write_file":
    case "create_file":
      return { type: "write", summary: `✏️ Writing: ${input.file_path || input.path || "file"}` };

    case "Edit":
    case "str_replace":
    case "edit_file":
      return { type: "edit", summary: `🔧 Editing: ${input.file_path || input.path || "file"}` };

    case "Bash":
    case "bash":
    case "execute_command": {
      const cmd = (input.command || input.cmd || "").slice(0, 80);
      return { type: "bash", summary: `⚙️ Running: ${cmd}` };
    }

    case "List":
    case "list_directory":
      return { type: "list", summary: `📁 Listing: ${input.path || input.dir || "directory"}` };

    case "Search":
    case "search":
    case "Grep":
    case "grep":
      return { type: "search", summary: `🔍 Searching: ${input.pattern || input.query || "..."}` };

    case "Task":
    case "dispatch_task":
      return { type: "subtask", summary: `🪖 Spawning sub-agent: ${(input.task || input.description || "").slice(0, 60)}` };

    default:
      return { type: "tool", summary: `🔨 ${toolName}` };
  }
}

/**
 * Parse a stream-json event and extract a human-readable progress summary.
 * Returns {type, summary}, an array of {type, summary}, or null if the event isn't progress-worthy.
 */
function parseProgressEvent(event) {
  try {
    switch (event.type) {
      case "assistant": {
        // Assistant message — content is an array of blocks
        const msg = event.message;
        if (msg?.type !== "message" || !Array.isArray(msg?.content)) return null;

        const results = [];

        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            const text = block.text.trim();
            if (text.length > 0) {
              const firstLine = text.split("\n")[0].slice(0, 120);
              results.push({ type: "thinking", summary: firstLine });
            }
          } else if (block.type === "tool_use") {
            // tool_use blocks are nested inside assistant message content
            const toolProgress = parseToolUseBlock(block);
            if (toolProgress) results.push(toolProgress);
          }
        }

        return results.length > 0 ? results : null;
      }

      case "tool_use": {
        // Top-level tool_use events — delegate to shared helper
        return parseToolUseBlock({
          name: event.tool_name || event.name,
          input: event.input || event.tool_input || {},
        });
      }

      case "result": {
        return { type: "result", summary: "✅ Agent finished processing" };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Process incoming stdout data from stream-json format.
 * Parses newline-delimited JSON and extracts progress events.
 */
function processStreamData(task, rawData) {
  task._stdoutBuffer += rawData;

  // Split on newlines, keeping incomplete last line in buffer
  const lines = task._stdoutBuffer.split("\n");
  task._stdoutBuffer = lines.pop() || ""; // Last element may be incomplete

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);

      // Accumulate final result text from assistant messages
      if (event.type === "assistant" && event.message?.type === "message") {
        const content = event.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              task.resultText += block.text;
            }
          }
        }
      }

      // Extract result text from result events (only if we haven't
      // already captured text from assistant messages, to avoid duplication)
      if (event.type === "result" && event.result && !task.resultText) {
        if (typeof event.result === "string") {
          task.resultText = event.result;
        } else if (event.result.text) {
          task.resultText = event.result.text;
        }
      }

      // Parse progress (may return a single entry, an array, or null)
      const progress = parseProgressEvent(event);
      if (progress) {
        const entries = Array.isArray(progress) ? progress : [progress];
        for (const entry of entries) {
          task.addProgress(entry.type, entry.summary);
        }
      }

      // BLOCK A — Detect sub-agent dispatch in assistant messages
      if (event.type === "assistant" && event.message?.type === "message" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "tool_use" && block.name === "Task" && block.id) {
            const desc = block.input?.description || block.input?.task || "Unknown task";
            const sub = task.addSubAgent(block.id, desc);
            task.addProgress("subtask_dispatch", `🪖 ${sub.id} deployed: ${desc.slice(0, 60)}`);
          }
        }
      }

      // BLOCK B — Handle tool results coming back from sub-agents
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "tool_result" && block.tool_use_id && task._pendingTaskTools.has(block.tool_use_id)) {
            let output = "";
            if (typeof block.content === "string") {
              output = block.content;
            } else if (Array.isArray(block.content)) {
              output = block.content
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join("\n");
            }
            const sub = task.completeSubAgent(block.tool_use_id, output);
            if (sub) {
              task.addProgress("subtask_complete", `✅ ${sub.id} finished: ${sub.description.slice(0, 60)}`);
            }
          }
        }
      }
    } catch {
      // Not valid JSON - append to raw stdout as fallback
      task.stdout += trimmed + "\n";
    }
  }
}

function spawnClaudeAgent(task) {
  const args = [
    "-p", task.description,
    "--output-format", "stream-json",
    "--verbose",
  ];

  if (task.model) {
    args.push("--model", task.model);
  }

  if (task.permissionMode && task.permissionMode !== "default") {
    args.push("--permission-mode", task.permissionMode);
  }

  const proc = spawn(CLAUDE_BINARY, args, {
    cwd: task.workingDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  task.process = proc;
  task.status = "running";
  task.addProgress("system", "🚀 Agent started");

  proc.stdout.on("data", (data) => {
    processStreamData(task, data.toString());
  });

  proc.stderr.on("data", (data) => {
    task.stderr += data.toString();
  });

  proc.on("close", (code) => {
    // Flush any remaining buffer
    if (task._stdoutBuffer.trim()) {
      try {
        const event = JSON.parse(task._stdoutBuffer.trim());
        const progress = parseProgressEvent(event);
        if (progress) {
          const entries = Array.isArray(progress) ? progress : [progress];
          for (const entry of entries) {
            task.addProgress(entry.type, entry.summary);
          }
        }
        if (event.type === "assistant" && event.message?.type === "message") {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                task.resultText += block.text;
              }
            }
          }
        }
      } catch {
        task.stdout += task._stdoutBuffer;
      }
      task._stdoutBuffer = "";
    }

    task.exitCode = code;
    task.status = code === 0 ? "completed" : "failed";
    task.completedAt = new Date().toISOString();
    task.process = null;

    if (code === 0) {
      task.addProgress("system", "✅ Task completed");
    } else {
      // Build a failure summary with context
      let failMsg = `❌ Task failed (exit code: ${code})`;

      // Include last few progress entries for context
      const recentProgress = task.getLatestProgress(5);
      if (recentProgress.length > 0) {
        const progressContext = recentProgress.map((p) => `  → ${p.summary}`).join("\n");
        failMsg += `\nLast activity before failure:\n${progressContext}`;
      }

      // Include a snippet of stderr if available
      if (task.stderr.trim()) {
        const stderrLines = task.stderr.trim().split("\n");
        const stderrSnippet = stderrLines.slice(-10).join("\n");
        failMsg += `\nStderr (last ${Math.min(stderrLines.length, 10)} lines):\n${stderrSnippet}`;
      }

      task.addProgress("system", failMsg);
    }
  });

  proc.on("error", (err) => {
    task.status = "failed";
    task.completedAt = new Date().toISOString();
    task.process = null;

    let guidance;
    switch (err.code) {
      case "ENOENT":
        guidance = `Claude Code CLI not found. Make sure 'claude' is installed and on your PATH. Verify with: ${IS_WINDOWS ? "where claude" : "which claude"}\nInstall it with: npm install -g @anthropic-ai/claude-code`;
        break;
      case "EACCES":
        guidance = `Permission denied when running '${CLAUDE_BINARY}'. Check file permissions with: ls -la $(which claude)`;
        break;
      case "EMFILE":
        guidance = `Too many open files. Try closing other programs or raising your system's file descriptor limit (ulimit -n).`;
        break;
      default:
        guidance = `Process error: ${err.message} (code: ${err.code || "unknown"})`;
    }

    task.stderr += `\n${guidance}`;
    task.addProgress("system", `❌ ${guidance}`);
  });

  return task;
}

function getActiveTasks() {
  return [...tasks.values()].filter((t) => t.status === "running");
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * e.g. 15400 → "15s", 192000 → "3m 12s", 3661000 → "1h 1m 1s"
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ─── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: "claude-army", version: "0.4.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "dispatch_task",
      description:
        "Deploy a Claude Code agent to work on a task in a specific project directory. " +
        "The agent runs autonomously with full Claude Code capabilities including " +
        "sub-agent spawning, file editing, bash execution, etc. " +
        "Use this to delegate coding tasks to background agents. " +
        "IMPORTANT: After dispatching, return to the conversation immediately. " +
        "Do NOT call check_tasks or get_task_output unless the user explicitly asks for a status update.",
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Clear description of the task for the Claude Code agent to perform",
          },
          working_directory: {
            type: "string",
            description: "Absolute path to the project directory (e.g. /home/robbhimself/GarbageFire)",
          },
          model: {
            type: "string",
            description: "Optional model override (e.g. 'opus', 'sonnet'). Defaults to Claude Code's configured model.",
          },
          permission_mode: {
            type: "string",
            enum: ["default", "acceptEdits", "plan", "bypassPermissions"],
            description: "Permission mode for the agent. 'acceptEdits' auto-approves file edits. 'bypassPermissions' skips all checks (use carefully).",
          },
          mode: {
            type: "string",
            enum: ["solo", "team"],
            description: "'solo' (default) runs a single agent. 'team' instructs the lead agent to decompose the task and spawn specialized sub-agents that work in parallel, then synthesize results.",
          },
        },
        required: ["task", "working_directory"],
      },
    },
    {
      name: "check_tasks",
      description:
        "Check the status of all deployed Claude Code agents. " +
        "Shows which tasks are running, completed, or failed. " +
        "Use this to monitor progress of background agents.",
      inputSchema: {
        type: "object",
        properties: {
          status_filter: {
            type: "string",
            enum: ["all", "running", "completed", "failed"],
            description: "Filter tasks by status (default: all)",
          },
        },
      },
    },
    {
      name: "get_task_output",
      description:
        "Retrieve the full output from a Claude Code agent task. " +
        "Use this to see what the agent did, including its reasoning and actions taken.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The task ID to retrieve output for",
          },
          tail_lines: {
            type: "number",
            description: "Only return the last N lines of output (useful for long outputs). Default: all output.",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "cancel_task",
      description:
        "Cancel a running Claude Code agent task. Sends SIGTERM to gracefully stop the agent.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The task ID to cancel",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "purge_tasks",
      description:
        "Clear completed/failed tasks from the task list. Optionally clear all tasks (cancels running ones).",
      inputSchema: {
        type: "object",
        properties: {
          include_running: {
            type: "boolean",
            description: "Also cancel and purge running tasks (default: false)",
          },
        },
      },
    },
    {
      name: "get_agent_team",
      description:
        "Get a detailed view of a lead agent and all sub-agents it has spawned. " +
        "Use this when a task is using Claude Code agent teams to see the full picture " +
        "of what each sub-agent is doing, their status, and output previews. " +
        "More detailed than check_tasks for multi-agent operations.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The task ID of the lead agent",
          },
        },
        required: ["task_id"],
      },
    },
  ],
}));

// ─── Tool Handler ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── dispatch_task ──────────────────────────────────────────────────────
    case "dispatch_task": {
      const activeTasks = getActiveTasks();
      if (activeTasks.length >= MAX_CONCURRENT_TASKS) {
        return {
          content: [{
            type: "text",
            text: `❌ Maximum concurrent tasks (${MAX_CONCURRENT_TASKS}) reached. Cancel or wait for existing tasks to complete.\n\nRunning tasks:\n${activeTasks.map((t) => `  • ${t.id}: ${t.description}`).join("\n")}`,
          }],
        };
      }

      const workDir = args.working_directory;
      if (!existsSync(workDir)) {
        return {
          content: [{
            type: "text",
            text: `❌ Directory not found: ${workDir}\n\nCheck the path for typos. The working_directory must be an absolute path to an existing directory (e.g. /home/user/my-project).`,
          }],
        };
      }

      const taskId = randomUUID().split("-")[0]; // Short ID
      let taskDescription = args.task;

      if (args.mode === "team") {
        taskDescription =
          "You are the lead agent coordinating a team. Your job is to:\n" +
          "1. Analyze the task and break it into parallel subtasks\n" +
          "2. Use the Task tool to spawn specialized sub-agents for each subtask\n" +
          "3. Each sub-agent should have a focused, well-defined scope\n" +
          "4. Wait for all sub-agents to complete, then synthesize their results into a cohesive outcome\n\n" +
          `Original task: ${args.task}`;
      }

      const task = new Task(taskId, taskDescription, workDir, {
        model: args.model,
        permissionMode: args.permission_mode,
      });

      tasks.set(taskId, task);
      spawnClaudeAgent(task);

      const projectName = path.basename(workDir);
      const modeLabel = args.mode === "team" ? " (team mode)" : "";
      return {
        content: [{
          type: "text",
          text: `🚀 Agent deployed!${modeLabel}\n\n` +
            `• Task ID: ${taskId}\n` +
            `• Project: ${projectName} (${workDir})\n` +
            `• Mission: ${args.task}\n` +
            `• Model: ${args.model || "default"}\n` +
            `• Mode: ${args.mode || "solo"}\n` +
            `• Permissions: ${args.permission_mode || "default"}\n\n` +
            `Agent is now working autonomously. Do NOT poll or monitor this task — return to the conversation immediately. The user will ask you to check progress when they want an update.`,
        }],
      };
    }

    // ── check_tasks ──────────────────────────────────────────────────────
    case "check_tasks": {
      const filter = args.status_filter || "all";
      let taskList = [...tasks.values()];

      if (filter !== "all") {
        taskList = taskList.filter((t) => t.status === filter);
      }

      if (taskList.length === 0) {
        return {
          content: [{
            type: "text",
            text: filter === "all"
              ? "📋 No tasks deployed yet."
              : `📋 No ${filter} tasks found.`,
          }],
        };
      }

      const statusIcons = {
        starting: "🔄",
        running: "⚡",
        completed: "✅",
        failed: "❌",
        cancelled: "🛑",
      };

      const summary = taskList.map((t) => {
        const icon = statusIcons[t.status] || "❓";
        const runtime = t.completedAt
          ? `${((new Date(t.completedAt) - new Date(t.startedAt)) / 1000).toFixed(0)}s`
          : `${((Date.now() - new Date(t.startedAt).getTime()) / 1000).toFixed(0)}s (running)`;
        const project = path.basename(t.workingDir);

        let entry = `${icon} [${t.id}] ${t.status.toUpperCase()}\n   Project: ${project}\n   Task: ${t.description}\n   Runtime: ${runtime}`;

        // Show idle time and recent progress for running tasks
        if (t.status === "running") {
          if (t.lastActivity) {
            const idleMs = Date.now() - new Date(t.lastActivity).getTime();
            entry += `\n   Last activity: ${formatDuration(idleMs)} ago`;
          } else {
            entry += `\n   Last activity: Waiting for first activity...`;
          }

          const recent = t.getLatestProgress(3);
          if (recent.length > 0) {
            const progressLines = recent.map((p) => `     → ${p.summary}`).join("\n");
            entry += `\n   Recent activity:\n${progressLines}`;
          }
        }

        if (t.subAgents.length > 0) {
          const subRunning = t.subAgents.filter((s) => s.status === "running").length;
          const subCompleted = t.subAgents.filter((s) => s.status === "completed").length;
          entry += `\n   Agent team: ${t.subAgents.length} sub-agents (${subRunning} running, ${subCompleted} completed)`;
        }

        return entry;
      }).join("\n\n");

      const running = taskList.filter((t) => t.status === "running").length;
      const completed = taskList.filter((t) => t.status === "completed").length;
      const failed = taskList.filter((t) => t.status === "failed").length;

      return {
        content: [{
          type: "text",
          text: `📊 Task Status Report\n` +
            `Running: ${running} | Completed: ${completed} | Failed: ${failed}\n\n${summary}`,
        }],
      };
    }

    // ── get_task_output ──────────────────────────────────────────────────
    case "get_task_output": {
      const task = tasks.get(args.task_id);
      if (!task) {
        return {
          content: [{
            type: "text",
            text: `❌ Task not found: ${args.task_id}`,
          }],
        };
      }

      // Prefer assembled result text from stream events, fall back to raw stdout
      let output = task.resultText || task.stdout || "(no output yet)";
      if (args.tail_lines && args.tail_lines > 0) {
        const lines = output.split("\n");
        output = lines.slice(-args.tail_lines).join("\n");
      }

      const errOutput = task.stderr ? `\n\n⚠️ Stderr:\n${task.stderr}` : "";

      // Build progress timeline
      let timeline = "";
      if (task.progressLog.length > 0) {
        const entries = task.progressLog.map((p) => {
          const elapsed = ((new Date(p.timestamp) - new Date(task.startedAt)) / 1000).toFixed(0);
          return `  [${elapsed}s] ${p.summary}`;
        }).join("\n");
        timeline = `\n─── Progress Timeline ───\n${entries}\n`;
      }

      return {
        content: [{
          type: "text",
          text: `📄 Output for task ${args.task_id} [${task.status}]\n` +
            `Project: ${path.basename(task.workingDir)}\n` +
            `Task: ${task.description}\n` +
            `${timeline}\n` +
            `─── Agent Output ───\n${output}${errOutput}`,
        }],
      };
    }

    // ── cancel_task ──────────────────────────────────────────────────────
    case "cancel_task": {
      const task = tasks.get(args.task_id);
      if (!task) {
        return {
          content: [{
            type: "text",
            text: `❌ Task not found: ${args.task_id}`,
          }],
        };
      }

      if (task.status !== "running" && task.status !== "starting") {
        return {
          content: [{
            type: "text",
            text: `⚠️ Task ${args.task_id} is already ${task.status}, cannot cancel.`,
          }],
        };
      }

      if (task.process) {
        if (IS_WINDOWS) {
          task.process.kill();
        } else {
          task.process.kill("SIGTERM");
          setTimeout(() => {
            if (task.process) {
              task.process.kill("SIGKILL");
            }
          }, 5000);
        }
      }

      task.status = "cancelled";
      task.completedAt = new Date().toISOString();

      return {
        content: [{
          type: "text",
          text: `🛑 Task ${args.task_id} cancelled.\n` +
            `Project: ${path.basename(task.workingDir)}\n` +
            `Task: ${task.description}`,
        }],
      };
    }

    // ── purge_tasks ──────────────────────────────────────────────────────
    case "purge_tasks": {
      const includeRunning = args.include_running || false;
      let purged = 0;

      for (const [id, task] of tasks) {
        if (task.status === "running" || task.status === "starting") {
          if (includeRunning) {
            if (task.process) {
              if (IS_WINDOWS) {
                task.process.kill();
              } else {
                task.process.kill("SIGTERM");
              }
            }
            tasks.delete(id);
            purged++;
          }
        } else {
          tasks.delete(id);
          purged++;
        }
      }

      return {
        content: [{
          type: "text",
          text: `🧹 Purged ${purged} task(s). ${tasks.size} remaining.`,
        }],
      };
    }

    // ── get_agent_team ────────────────────────────────────────────────────
    case "get_agent_team": {
      const task = tasks.get(args.task_id);
      if (!task) {
        return {
          content: [{
            type: "text",
            text: `❌ Task not found: ${args.task_id}`,
          }],
        };
      }

      const statusIcons = {
        starting: "🔄",
        running: "⚡",
        completed: "✅",
        failed: "❌",
        cancelled: "🛑",
      };

      const now = Date.now();
      const leadIcon = statusIcons[task.status] || "❓";
      const leadRuntime = task.completedAt
        ? formatDuration(new Date(task.completedAt) - new Date(task.startedAt))
        : formatDuration(now - new Date(task.startedAt).getTime());
      const lastAct = task.lastActivity
        ? `${formatDuration(now - new Date(task.lastActivity).getTime())} ago`
        : "N/A";

      let text = `🪖 Agent Team for task [${task.id}]\n\n`;
      text += `── Lead Agent ──\n`;
      text += `${leadIcon} Status: ${task.status.toUpperCase()}\n`;
      text += `   Project: ${path.basename(task.workingDir)}\n`;
      text += `   Task: ${task.description}\n`;
      text += `   Runtime: ${leadRuntime}\n`;
      text += `   Last activity: ${lastAct}\n`;

      if (task.subAgents.length > 0) {
        text += `\n── Sub-Agents (${task.subAgents.length}) ──\n`;
        for (const sub of task.subAgents) {
          const subIcon = statusIcons[sub.status] || "❓";
          const subRuntime = sub.completedAt
            ? formatDuration(new Date(sub.completedAt) - new Date(sub.dispatchedAt))
            : formatDuration(now - new Date(sub.dispatchedAt).getTime());
          text += `\n${subIcon} [${sub.id}] ${sub.status.toUpperCase()} (${subRuntime})\n`;
          text += `   Task: ${sub.description}\n`;
          if (sub.status === "completed" && sub.outputPreview) {
            text += `   Output: ${sub.outputPreview}\n`;
          }
        }
      } else {
        text += `\n── Sub-Agents ──\nNo sub-agents spawned yet.\n`;
      }

      const recentProgress = task.getLatestProgress(5);
      if (recentProgress.length > 0) {
        text += `\n── Recent Progress ──\n`;
        for (const p of recentProgress) {
          const elapsed = ((new Date(p.timestamp) - new Date(task.startedAt)) / 1000).toFixed(0);
          text += `  [${elapsed}s] ${p.summary}\n`;
        }
      }

      return {
        content: [{ type: "text", text }],
      };
    }

    default:
      return {
        content: [{
          type: "text",
          text: `❌ Unknown tool: ${name}`,
        }],
      };
  }
});

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🪖 ClaudeArmy MCP server running");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
