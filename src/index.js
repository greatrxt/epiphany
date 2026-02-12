require("dotenv").config();

const { App } = require("@slack/bolt");
const claude = require("./claude");
const sessions = require("./sessions");
const projects = require("./projects");
const history = require("./history");
const dashboard = require("./dashboard");
const {
  isCommand,
  isContinue,
  isSnap,
  handleCommand,
  isProjectCommand,
  parseProjectCommand,
  handleProjectCommand,
} = require("./commands");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const MAX_MESSAGE_LENGTH = 4000;

// In-memory store for pending permission requests
// Maps actionId -> { channel, prompt, sessionId, denials }
const pendingPermissions = new Map();

function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      splitAt = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

async function addReaction(client, channel, timestamp) {
  try {
    await client.reactions.add({ channel, timestamp, name: "thinking_face" });
  } catch {}
}

async function removeReaction(client, channel, timestamp) {
  try {
    await client.reactions.remove({ channel, timestamp, name: "thinking_face" });
  } catch {}
}

async function postResponse(client, channel, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await client.chat.postMessage({ channel, text: chunk });
  }
}

// Build allowedTools patterns from permission denials
function buildAllowedTools(denials) {
  const tools = new Set();
  for (const denial of denials) {
    const name = denial.tool_name;
    if (name === "Bash" && denial.tool_input?.command) {
      const program = denial.tool_input.command.split(/\s+/)[0];
      tools.add(`Bash(${program}:*)`);
    } else {
      tools.add(name);
    }
  }
  return [...tools];
}

// Format denials into a readable Slack message
function formatDenials(denials) {
  const lines = denials.map((d) => {
    if (d.tool_name === "Bash" && d.tool_input?.command) {
      return `\u2022 \`${d.tool_input.command}\``;
    }
    return `\u2022 Tool: \`${d.tool_name}\``;
  });
  return [...new Set(lines)].join("\n");
}

// Clean up expired pending permissions (older than 10 minutes)
function prunePermissions() {
  const now = Date.now();
  for (const [key] of pendingPermissions) {
    const ts = parseInt(key.split("_")[1], 10);
    if (now - ts > 600_000) pendingPermissions.delete(key);
  }
}

// Send response with permission denial buttons
async function postWithPermissionRequest(client, channel, result) {
  if (result.response) {
    await postResponse(client, channel, result.response);
  }

  const actionId = `perm_${Date.now()}`;
  pendingPermissions.set(actionId, {
    channel,
    prompt: result._originalPrompt,
    sessionId: result.sessionId,
    denials: result.permissionDenials,
  });

  prunePermissions();

  const denialText = formatDenials(result.permissionDenials);

  await client.chat.postMessage({
    channel,
    text: `Permission needed:\n${denialText}\nAllow and retry?`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:lock: *Permission needed*\nClaude wanted to run:\n${denialText}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Allow & Retry" },
            style: "primary",
            action_id: `allow_${actionId}`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Deny" },
            action_id: `deny_${actionId}`,
          },
        ],
      },
    ],
  });
}

// Post Claude result — shared by handlePrompt and allow handler
async function postClaudeResult(client, channel, result, originalPrompt) {
  if (result.error) {
    await postResponse(client, channel, `:x: ${result.error}`);
    return;
  }

  if (result.sessionId) {
    sessions.set(channel, result.sessionId);
  }

  if (result.permissionDenials && result.permissionDenials.length > 0) {
    result._originalPrompt = originalPrompt;
    await postWithPermissionRequest(client, channel, result);
    return;
  }

  if (result.response) {
    await postResponse(client, channel, result.response);
  } else {
    await postResponse(client, channel, ":warning: Claude returned an empty response. Try again.");
  }
}

// Capture a photo and upload to Slack
const SNAP_PATH = path.join(__dirname, "..", "data", "snap.jpg");

async function handleSnap(client, channel, messageTs) {
  try {
    await new Promise((resolve, reject) => {
      execFile("imagesnap", ["-w", "1", SNAP_PATH], { timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await removeReaction(client, channel, messageTs);

    await client.filesUploadV2({
      channel_id: channel,
      file: fs.createReadStream(SNAP_PATH),
      filename: `snap_${Date.now()}.jpg`,
      initial_comment: ":camera_with_flash: Here's what I see!",
    });
  } catch (err) {
    await removeReaction(client, channel, messageTs);
    console.error("Snap error:", err);
    await postResponse(client, channel, `:x: Camera error: ${err.message}`);
  }
}

// Handle the main message flow
async function handlePrompt(client, channel, messageTs, text, sessionOpts) {
  const result = await claude.run(sessionOpts);
  await removeReaction(client, channel, messageTs);

  // Log to history
  if (result.sessionId) {
    history.append(result.sessionId, {
      role: "user",
      text,
      source: "slack",
      channel,
    });
    if (result.response) {
      history.append(result.sessionId, {
        role: result.error ? "error" : "assistant",
        text: result.response,
        source: "slack",
        channel,
      });
    }
  }

  await postClaudeResult(client, channel, result, text);
}

// --- Slack event: incoming message ---
app.event("message", async ({ event, client }) => {
  if (event.bot_id || event.subtype) return;

  const text = (event.text || "").trim();
  if (!text) return;

  const channel = event.channel;
  const messageTs = event.ts;

  await addReaction(client, channel, messageTs);

  try {
    // Built-in commands
    if (isCommand(text)) {
      const response = await handleCommand(text);
      await removeReaction(client, channel, messageTs);
      await postResponse(client, channel, response);
      return;
    }

    // Project commands
    if (isProjectCommand(text)) {
      const { sub, arg } = parseProjectCommand(text);
      const result = handleProjectCommand(sub, arg, channel, event.user);
      await removeReaction(client, channel, messageTs);
      if (result.blocks) {
        await client.chat.postMessage({
          channel,
          text: result.text,
          blocks: result.blocks,
        });
      } else {
        await postResponse(client, channel, result.text);
      }
      return;
    }

    // "snap" — capture photo from camera and upload to Slack
    if (isSnap(text)) {
      await handleSnap(client, channel, messageTs);
      return;
    }

    // "continue" — resume most recent terminal session
    if (isContinue(text)) {
      const cwd = projects.get(channel) || undefined;
      await handlePrompt(client, channel, messageTs, text, {
        prompt: "",
        continueSession: true,
        cwd,
      });
      return;
    }

    // Check for existing session on this channel
    const sessionId = sessions.get(channel);
    const cwd = projects.get(channel) || undefined;

    if (sessionId) {
      await handlePrompt(client, channel, messageTs, text, {
        prompt: text,
        resume: sessionId,
        cwd,
      });
    } else {
      await handlePrompt(client, channel, messageTs, text, {
        prompt: text,
        cwd,
      });
    }
  } catch (err) {
    console.error("Error handling message:", err);
    await removeReaction(client, channel, messageTs);
    try {
      await postResponse(client, channel, `:x: Something went wrong: ${err.message}`);
    } catch {}
  }
});

// --- Slack action: Allow button clicked ---
app.action(/^allow_perm_/, async ({ action, ack, client }) => {
  await ack();

  const actionId = action.action_id.replace("allow_", "");
  const pending = pendingPermissions.get(actionId);
  if (!pending) return;
  pendingPermissions.delete(actionId);

  const { channel, prompt, sessionId, denials } = pending;
  const allowedTools = buildAllowedTools(denials);
  const cwd = projects.get(channel) || undefined;

  await client.chat.postMessage({
    channel,
    text: `:white_check_mark: Approved. Retrying with permission for: ${allowedTools.join(", ")}`,
  });

  try {
    const result = await claude.run({
      prompt: prompt || "Please retry the previously denied operations.",
      resume: sessionId,
      allowedTools,
      cwd,
    });

    await postClaudeResult(client, channel, result, prompt);
  } catch (err) {
    console.error("Error retrying with permissions:", err);
    await postResponse(client, channel, `:x: Retry failed: ${err.message}`);
  }
});

// --- Slack action: Project picker button clicked ---
app.action(/^project_pick_/, async ({ action, ack, client, body }) => {
  await ack();

  const channel = body.channel?.id;
  const userId = body.user?.id;
  const dirPath = action.value;

  if (!channel || !dirPath) return;

  try {
    projects.set(channel, dirPath, userId);
    sessions.clear(channel);
    await client.chat.postMessage({
      channel,
      text: `:white_check_mark: Bound this channel to \`${dirPath}\``,
    });
  } catch (err) {
    await client.chat.postMessage({
      channel,
      text: `:x: ${err.message}`,
    });
  }
});

// --- Slack action: Deny button clicked ---
app.action(/^deny_perm_/, async ({ action, ack, client }) => {
  await ack();

  const actionId = action.action_id.replace("deny_", "");
  const pending = pendingPermissions.get(actionId);
  pendingPermissions.delete(actionId);

  if (pending) {
    await client.chat.postMessage({
      channel: pending.channel,
      text: ":no_entry_sign: Permission denied. Claude will work without those tools.",
    });
  }
});

(async () => {
  try {
    await app.start();
    console.log("Epiphany is running!");

    // Start web dashboard
    const dashboardPort = parseInt(process.env.DASHBOARD_PORT, 10) || 3141;
    const dashboardApp = dashboard.create({ sessions, projects, history, claude });
    dashboardApp.listen(dashboardPort, () => {
      console.log(`Dashboard running at http://localhost:${dashboardPort}`);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
})();
