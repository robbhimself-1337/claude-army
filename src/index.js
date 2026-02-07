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
const CLAUDE_BINARY = "claude";
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
      outputLength: this.stdout.length,
      hasErrors: this.stderr.length > 0,
    };
  }
}

// ─── Core Functions ──────────────────────────────────────────────────────────

function spawnClaudeAgent(task) {
  const args = [
    "-p", task.description,
    "--output-format", "text",
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

  proc.stdout.on("data", (data) => {
    task.stdout += data.toString();
  });

  proc.stderr.on("data", (data) => {
    task.stderr += data.toString();
  });

  proc.on("close", (code) => {
    task.exitCode = code;
    task.status = code === 0 ? "completed" : "failed";
    task.completedAt = new Date().toISOString();
    task.process = null;
  });

  proc.on("error", (err) => {
    task.status = "failed";
    task.stderr += `\nProcess error: ${err.message}`;
    task.completedAt = new Date().toISOString();
    task.process = null;
  });

  return task;
}

function getActiveTasks() {
  return [...tasks.values()].filter((t) => t.status === "running");
}

// ─── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: "claude-army", version: "0.1.0" },
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
            text: `❌ Directory not found: ${workDir}`,
          }],
        };
      }

      const taskId = randomUUID().split("-")[0]; // Short ID
      const task = new Task(taskId, args.task, workDir, {
        model: args.model,
        permissionMode: args.permission_mode,
      });

      tasks.set(taskId, task);
      spawnClaudeAgent(task);

      const projectName = path.basename(workDir);
      return {
        content: [{
          type: "text",
          text: `🚀 Agent deployed!\n\n` +
            `• Task ID: ${taskId}\n` +
            `• Project: ${projectName} (${workDir})\n` +
            `• Mission: ${args.task}\n` +
            `• Model: ${args.model || "default"}\n` +
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
        return `${icon} [${t.id}] ${t.status.toUpperCase()}\n   Project: ${project}\n   Task: ${t.description}\n   Runtime: ${runtime}`;
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

      let output = task.stdout || "(no output yet)";
      if (args.tail_lines && args.tail_lines > 0) {
        const lines = output.split("\n");
        output = lines.slice(-args.tail_lines).join("\n");
      }

      const errOutput = task.stderr ? `\n\n⚠️ Stderr:\n${task.stderr}` : "";

      return {
        content: [{
          type: "text",
          text: `📄 Output for task ${args.task_id} [${task.status}]\n` +
            `Project: ${path.basename(task.workingDir)}\n` +
            `Task: ${task.description}\n\n` +
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
        task.process.kill("SIGTERM");
        // Give it 5s then SIGKILL
        setTimeout(() => {
          if (task.process) {
            task.process.kill("SIGKILL");
          }
        }, 5000);
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
            if (task.process) task.process.kill("SIGTERM");
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
