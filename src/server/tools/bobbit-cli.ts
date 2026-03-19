#!/usr/bin/env node
/**
 * Bobbit CLI — Team lead tool for managing teams, tasks, and artifacts.
 * Auto-discovers config from env vars and ~/.pi/ files.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Config discovery
// ---------------------------------------------------------------------------

function loadConfig(): { sessionId: string; goalId: string; token: string; baseUrl: string } {
  const sessionId = process.env.BOBBIT_SESSION_ID;
  if (!sessionId) {
    fatal('BOBBIT_SESSION_ID environment variable is not set');
  }

  const goalId = process.env.BOBBIT_GOAL_ID;
  if (!goalId) {
    fatal('BOBBIT_GOAL_ID environment variable is not set');
  }

  const piDir = path.join(homedir(), '.pi');

  let token: string;
  const tokenPath = path.join(piDir, 'gateway-token');
  try {
    token = fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    fatal(`Cannot read auth token from ${tokenPath}`);
  }

  let baseUrl: string;
  const urlPath = path.join(piDir, 'gateway-url');
  try {
    baseUrl = fs.readFileSync(urlPath, 'utf-8').trim().replace(/\/+$/, '');
  } catch {
    fatal(`Cannot read gateway URL from ${urlPath}`);
  }

  return { sessionId: sessionId!, goalId: goalId!, token: token!, baseUrl: baseUrl! };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface Config {
  sessionId: string;
  goalId: string;
  token: string;
  baseUrl: string;
}

async function api(
  cfg: Config,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${cfg.baseUrl}${urlPath}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${cfg.token}`,
    'Content-Type': 'application/json',
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  const text = await resp.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!resp.ok) {
    const msg = typeof data === 'object' && data !== null && 'error' in data
      ? (data as { error: string }).error
      : typeof data === 'string'
        ? data
        : `HTTP ${resp.status}`;
    fatal(msg);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Error / output helpers
// ---------------------------------------------------------------------------

function fatal(message: string): never {
  process.stderr.write(JSON.stringify({ error: message }) + '\n');
  process.exit(1);
}

function output(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        fatal(`Missing value for flag --${key}`);
      }
      flags[key] = val;
      i += 2;
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const val = flags[name];
  if (val === undefined) {
    fatal(`Missing required flag --${name}`);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

const USAGE = `\
bobbit-cli — Team lead tool for managing teams, tasks, and artifacts.

Usage: bobbit-cli <group> <command> [options]

Groups:
  team        Manage the agent team
  tasks       Manage tasks
  artifacts   Manage goal artifacts
  session     Session information

Run "bobbit-cli <group>" for subcommand help.`;

const TEAM_USAGE = `\
bobbit-cli team <command>

Commands:
  spawn    --role <role> --task "<description>"   Spawn a new team agent
  list                                            List team agents
  dismiss  --session <id>                         Dismiss a team agent
  state                                           Get full team state
  complete                                        Mark team as complete`;

const TASKS_USAGE = `\
bobbit-cli tasks <command>

Commands:
  list                                                          List all tasks
  create   --title "<title>" --type <type> [--spec "<spec>"]    Create a task
           [--depends-on id1,id2]
  get      <task-id>                                            Get a task
  update   <task-id> [--title "..."] [--spec "..."]             Update a task
           [--result-summary "..."] [--commit-sha "..."]
  assign   <task-id> --session <session-id>                     Assign a task
  transition <task-id> --state <state>                          Transition task state
  delete   <task-id>                                            Delete a task`;

const ARTIFACTS_USAGE = `\
bobbit-cli artifacts <command>

Commands:
  list                                                          List artifacts
  create   --name "<name>" --type <type>                        Create an artifact
           --content "<content>" | --content-file <path>
  get      <artifact-id>                                        Get an artifact
  update   <artifact-id>                                        Update an artifact
           --content "<content>" | --content-file <path>`;

const SESSION_USAGE = `\
bobbit-cli session <command>

Commands:
  info      Get current session information`;

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleTeam(cfg: Config, args: ParsedArgs): Promise<void> {
  const command = args.positional[0];
  if (!command) {
    process.stdout.write(TEAM_USAGE + '\n');
    return;
  }

  switch (command) {
    case 'spawn': {
      const role = requireFlag(args.flags, 'role');
      const task = requireFlag(args.flags, 'task');
      const data = await api(cfg, 'POST', `/api/goals/${cfg.goalId}/team/spawn`, { role, task });
      output(data);
      break;
    }
    case 'list': {
      const data = await api(cfg, 'GET', `/api/goals/${cfg.goalId}/team/agents`);
      output(data);
      break;
    }
    case 'dismiss': {
      const sessionId = requireFlag(args.flags, 'session');
      const data = await api(cfg, 'POST', `/api/goals/${cfg.goalId}/team/dismiss`, { sessionId });
      output(data);
      break;
    }
    case 'state': {
      const data = await api(cfg, 'GET', `/api/goals/${cfg.goalId}/team`);
      output(data);
      break;
    }
    case 'complete': {
      const data = await api(cfg, 'POST', `/api/goals/${cfg.goalId}/team/complete`, {});
      output(data);
      break;
    }
    default:
      fatal(`Unknown team command: ${command}\n${TEAM_USAGE}`);
  }
}

async function handleTasks(cfg: Config, args: ParsedArgs): Promise<void> {
  const command = args.positional[0];
  if (!command) {
    process.stdout.write(TASKS_USAGE + '\n');
    return;
  }

  switch (command) {
    case 'list': {
      const data = await api(cfg, 'GET', `/api/goals/${cfg.goalId}/tasks`);
      output(data);
      break;
    }
    case 'create': {
      const title = requireFlag(args.flags, 'title');
      const type = requireFlag(args.flags, 'type');
      const body: Record<string, unknown> = { title, type };
      if (args.flags['spec'] !== undefined) body.spec = args.flags['spec'];
      if (args.flags['depends-on'] !== undefined) {
        body.dependsOn = args.flags['depends-on'].split(',').map(s => s.trim());
      }
      const data = await api(cfg, 'POST', `/api/goals/${cfg.goalId}/tasks`, body);
      output(data);
      break;
    }
    case 'get': {
      const taskId = args.positional[1];
      if (!taskId) fatal('Usage: tasks get <task-id>');
      const data = await api(cfg, 'GET', `/api/tasks/${taskId}`);
      output(data);
      break;
    }
    case 'update': {
      const taskId = args.positional[1];
      if (!taskId) fatal('Usage: tasks update <task-id> [--title "..."] [--spec "..."] ...');
      const body: Record<string, unknown> = {};
      if (args.flags['title'] !== undefined) body.title = args.flags['title'];
      if (args.flags['spec'] !== undefined) body.spec = args.flags['spec'];
      if (args.flags['result-summary'] !== undefined) body.resultSummary = args.flags['result-summary'];
      if (args.flags['commit-sha'] !== undefined) body.commitSha = args.flags['commit-sha'];
      const data = await api(cfg, 'PUT', `/api/tasks/${taskId}`, body);
      output(data);
      break;
    }
    case 'assign': {
      const taskId = args.positional[1];
      if (!taskId) fatal('Usage: tasks assign <task-id> --session <session-id>');
      const sessionId = requireFlag(args.flags, 'session');
      const data = await api(cfg, 'POST', `/api/tasks/${taskId}/assign`, { sessionId });
      output(data);
      break;
    }
    case 'transition': {
      const taskId = args.positional[1];
      if (!taskId) fatal('Usage: tasks transition <task-id> --state <state>');
      const state = requireFlag(args.flags, 'state');
      const data = await api(cfg, 'POST', `/api/tasks/${taskId}/transition`, { state });
      output(data);
      break;
    }
    case 'delete': {
      const taskId = args.positional[1];
      if (!taskId) fatal('Usage: tasks delete <task-id>');
      const data = await api(cfg, 'DELETE', `/api/tasks/${taskId}`);
      output(data);
      break;
    }
    default:
      fatal(`Unknown tasks command: ${command}\n${TASKS_USAGE}`);
  }
}

async function handleArtifacts(cfg: Config, args: ParsedArgs): Promise<void> {
  const command = args.positional[0];
  if (!command) {
    process.stdout.write(ARTIFACTS_USAGE + '\n');
    return;
  }

  switch (command) {
    case 'list': {
      const data = await api(cfg, 'GET', `/api/goals/${cfg.goalId}/artifacts`);
      output(data);
      break;
    }
    case 'create': {
      const name = requireFlag(args.flags, 'name');
      const type = requireFlag(args.flags, 'type');
      let content: string;
      if (args.flags['content-file'] !== undefined) {
        try {
          content = fs.readFileSync(args.flags['content-file'], 'utf-8');
        } catch (err) {
          fatal(`Cannot read content file: ${args.flags['content-file']}`);
        }
      } else if (args.flags['content'] !== undefined) {
        content = args.flags['content'];
      } else {
        fatal('Either --content or --content-file is required');
      }
      const data = await api(cfg, 'POST', `/api/goals/${cfg.goalId}/artifacts`, {
        name,
        type,
        content: content!,
        producedBy: cfg.sessionId,
      });
      output(data);
      break;
    }
    case 'get': {
      const artifactId = args.positional[1];
      if (!artifactId) fatal('Usage: artifacts get <artifact-id>');
      const data = await api(cfg, 'GET', `/api/goals/${cfg.goalId}/artifacts/${artifactId}`);
      output(data);
      break;
    }
    case 'update': {
      const artifactId = args.positional[1];
      if (!artifactId) fatal('Usage: artifacts update <artifact-id> --content "..." | --content-file <path>');
      let content: string;
      if (args.flags['content-file'] !== undefined) {
        try {
          content = fs.readFileSync(args.flags['content-file'], 'utf-8');
        } catch (err) {
          fatal(`Cannot read content file: ${args.flags['content-file']}`);
        }
      } else if (args.flags['content'] !== undefined) {
        content = args.flags['content'];
      } else {
        fatal('Either --content or --content-file is required');
      }
      const data = await api(cfg, 'PUT', `/api/goals/${cfg.goalId}/artifacts/${artifactId}`, {
        content: content!,
      });
      output(data);
      break;
    }
    default:
      fatal(`Unknown artifacts command: ${command}\n${ARTIFACTS_USAGE}`);
  }
}

async function handleSession(cfg: Config, args: ParsedArgs): Promise<void> {
  const command = args.positional[0];
  if (!command) {
    process.stdout.write(SESSION_USAGE + '\n');
    return;
  }

  switch (command) {
    case 'info': {
      const data = await api(cfg, 'GET', `/api/sessions/${cfg.sessionId}`);
      output(data);
      break;
    }
    default:
      fatal(`Unknown session command: ${command}\n${SESSION_USAGE}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const GROUP_USAGE: Record<string, string> = {
  team: TEAM_USAGE,
  tasks: TASKS_USAGE,
  artifacts: ARTIFACTS_USAGE,
  session: SESSION_USAGE,
};

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  const group = rawArgs[0];

  // Show group help without requiring config
  if (rawArgs.length === 1 && GROUP_USAGE[group]) {
    process.stdout.write(GROUP_USAGE[group] + '\n');
    process.exit(0);
  }

  const rest = rawArgs.slice(1);
  const args = parseArgs(rest);

  const cfg = loadConfig();

  switch (group) {
    case 'team':
      await handleTeam(cfg, args);
      break;
    case 'tasks':
      await handleTasks(cfg, args);
      break;
    case 'artifacts':
      await handleArtifacts(cfg, args);
      break;
    case 'session':
      await handleSession(cfg, args);
      break;
    default:
      fatal(`Unknown command group: ${group}\n\n${USAGE}`);
  }
}

main();
