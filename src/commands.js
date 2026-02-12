const fs = require("fs");
const path = require("path");
const os = require("os");
const claude = require("./claude");
const sessions = require("./sessions");
const projects = require("./projects");

function bindProject(channelId, dirPath, userId) {
  projects.set(channelId, dirPath, userId);
  sessions.clear(channelId);
}

const COMMANDS = {
  help: {
    description: "Show available commands",
    handler: handleHelp,
  },
  status: {
    description: "Check if Claude Code is available",
    handler: handleStatus,
  },
};

const CONTINUE_ALIASES = new Set(["continue", "c"]);
const SNAP_ALIASES = new Set(["snap", "camera", "photo"]);

function isCommand(text) {
  const lower = text.trim().toLowerCase();
  return COMMANDS[lower] !== undefined;
}

function isContinue(text) {
  return CONTINUE_ALIASES.has(text.trim().toLowerCase());
}

async function handleCommand(text) {
  const lower = text.trim().toLowerCase();
  const cmd = COMMANDS[lower];
  if (cmd) return cmd.handler();
  return null;
}

async function handleHelp() {
  const lines = [
    "*Available commands:*",
    "\u2022 `continue` / `c` \u2014 Resume the most recent terminal Claude session",
    "\u2022 `help` \u2014 Show this message",
    "\u2022 `snap` / `camera` / `photo` \u2014 Take a photo from the MacBook camera",
    "\u2022 `status` \u2014 Check if Claude Code is available",
    "",
    "*Project commands:*",
    "\u2022 `project set <name>` \u2014 Fuzzy-find a project and bind it to this channel",
    "\u2022 `project set /path/to/dir` \u2014 Bind an exact directory to this channel",
    "\u2022 `project set` \u2014 List all discovered projects to pick from",
    "\u2022 `project show` \u2014 Show the current channel's project binding",
    "\u2022 `project remove` \u2014 Unbind this channel's project",
    "\u2022 `project list` \u2014 List all channel\u2192project bindings",
    "",
    "*Usage:*",
    "\u2022 Send any message as a DM to start a new Claude conversation",
    "\u2022 Reply in a thread to continue that conversation",
    "\u2022 Send `continue` to pick up your most recent terminal session",
    "\u2022 Use `project set` in a channel to bind Claude to a project directory",
  ];
  return lines.join("\n");
}

async function handleStatus() {
  const result = await claude.run({ prompt: "Say OK", sessionId: undefined });
  if (result.error) {
    return `:x: Claude Code is not available: ${result.error}`;
  }
  const count = Object.keys(sessions.all()).length;
  return `:white_check_mark: Claude Code is running. ${count} active session(s).`;
}

function isSnap(text) {
  return SNAP_ALIASES.has(text.trim().toLowerCase());
}

// --- Project commands ---

function isProjectCommand(text) {
  const lower = text.trim().toLowerCase();
  return lower === "project" || lower.startsWith("project ");
}

function parseProjectCommand(text) {
  const trimmed = text.trim();
  // Strip "project" prefix
  const rest = trimmed.slice(7).trim();
  if (!rest) return { sub: null, arg: null };

  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx === -1) return { sub: rest.toLowerCase(), arg: null };

  const sub = rest.slice(0, spaceIdx).toLowerCase();
  const arg = rest.slice(spaceIdx + 1).trim();
  return { sub, arg: arg || null };
}

function expandHome(dir) {
  if (dir.startsWith("~/") || dir === "~") {
    return path.join(os.homedir(), dir.slice(1));
  }
  return dir;
}

function getBaseDirs() {
  const raw = process.env.PROJECT_DIRS || "";
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map(expandHome);
}

function discoverProjects(query) {
  const baseDirs = getBaseDirs();
  const results = [];

  for (const baseDir of baseDirs) {
    if (!fs.existsSync(baseDir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(baseDir, entry.name);
      if (!query || entry.name.toLowerCase().includes(query.toLowerCase())) {
        results.push({ name: entry.name, path: fullPath });
      }
    }
  }

  // Sort: exact prefix matches first, then alphabetical
  if (query) {
    const lowerQuery = query.toLowerCase();
    results.sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(lowerQuery);
      const bPrefix = b.name.toLowerCase().startsWith(lowerQuery);
      if (aPrefix && !bPrefix) return -1;
      if (!aPrefix && bPrefix) return 1;
      return a.name.localeCompare(b.name);
    });
  } else {
    results.sort((a, b) => a.name.localeCompare(b.name));
  }

  return results;
}

function handleProjectCommand(sub, arg, channelId, userId) {
  // Bare "project" — show usage
  if (!sub) {
    return {
      text: [
        "*Project commands:*",
        "\u2022 `project set <name>` \u2014 Fuzzy-find and bind a project",
        "\u2022 `project set /path` \u2014 Bind an exact path",
        "\u2022 `project set` \u2014 Browse all projects",
        "\u2022 `project show` \u2014 Current binding",
        "\u2022 `project remove` \u2014 Unbind",
        "\u2022 `project list` \u2014 All bindings",
      ].join("\n"),
    };
  }

  if (sub === "show") {
    const current = projects.get(channelId);
    if (!current) {
      return { text: "No project bound to this channel. Use `project set` to bind one." };
    }
    return { text: `:file_folder: This channel is bound to \`${current}\`` };
  }

  if (sub === "remove") {
    const current = projects.get(channelId);
    if (!current) {
      return { text: "No project is bound to this channel." };
    }
    projects.remove(channelId);
    return { text: `:wastebasket: Unbound project \`${current}\` from this channel.` };
  }

  if (sub === "list") {
    const allBindings = projects.all();
    const entries = Object.entries(allBindings);
    if (entries.length === 0) {
      return { text: "No project bindings configured." };
    }
    const lines = entries.map(
      ([ch, info]) => `\u2022 <#${ch}> \u2192 \`${info.path}\``
    );
    return { text: `*Project bindings:*\n${lines.join("\n")}` };
  }

  if (sub === "set") {
    // Absolute path — bind directly
    if (arg && path.isAbsolute(arg)) {
      try {
        bindProject(channelId, arg, userId);
        return {
          text: `:white_check_mark: Bound this channel to \`${path.resolve(arg)}\``,
        };
      } catch (err) {
        return { text: `:x: ${err.message}` };
      }
    }

    // Fuzzy search or list all
    const baseDirs = getBaseDirs();
    if (baseDirs.length === 0) {
      return {
        text: ":warning: No `PROJECT_DIRS` configured in `.env`. Set it to a comma-separated list of base directories (e.g. `PROJECT_DIRS=~/Files/Github,~/Projects`).",
      };
    }

    const matches = discoverProjects(arg || null);
    if (matches.length === 0) {
      return {
        text: arg
          ? `:mag: No projects matching \`${arg}\` found in: ${baseDirs.map((d) => `\`${d}\``).join(", ")}`
          : `:mag: No projects found in: ${baseDirs.map((d) => `\`${d}\``).join(", ")}`,
      };
    }

    // Single match — bind directly
    if (matches.length === 1) {
      try {
        bindProject(channelId, matches[0].path, userId);
        return {
          text: `:white_check_mark: Bound this channel to \`${matches[0].path}\``,
        };
      } catch (err) {
        return { text: `:x: ${err.message}` };
      }
    }

    // Multiple matches — return buttons
    // Cap at 20 to stay within Slack block limits
    const capped = matches.slice(0, 20);
    const buttons = capped.map((m, i) => ({
      type: "button",
      text: { type: "plain_text", text: m.name },
      action_id: `project_pick_${i}_${Date.now()}`,
      value: m.path,
    }));

    // Slack allows max 5 elements per actions block, so chunk them
    const actionBlocks = [];
    for (let i = 0; i < buttons.length; i += 5) {
      actionBlocks.push({
        type: "actions",
        elements: buttons.slice(i, i + 5),
      });
    }

    const headerText = arg
      ? `:mag: Found ${matches.length} projects matching \`${arg}\`:`
      : `:file_folder: Found ${matches.length} projects:`;

    return {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: headerText },
        },
        ...actionBlocks,
      ],
      text: headerText,
    };
  }

  return { text: `Unknown project subcommand: \`${sub}\`. Try \`project\` for usage.` };
}

module.exports = {
  isCommand,
  isContinue,
  isSnap,
  handleCommand,
  isProjectCommand,
  parseProjectCommand,
  handleProjectCommand,
};
