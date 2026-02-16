require("dotenv").config();

const { App } = require("@slack/bolt");
const claude = require("./claude");
const sessions = require("./sessions");
const projects = require("./projects");
const history = require("./history");
const schedules = require("./schedules");
const { create: createDashboard, broadcastEvent } = require("./dashboard");
const {
  isCommand,
  isContinue,
  isSnap,
  isVideo,
  parseVideoDuration,
  handleCommand,
  isProjectCommand,
  parseProjectCommand,
  handleProjectCommand,
  isRunCommand,
  parseRunCommand,
} = require("./commands");
const { execFile, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Kill any old Epiphany instance holding our dashboard port
function killOldInstance(port) {
  try {
    const pids = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
    if (pids.length === 0) return;

    const myPid = process.pid;
    for (const raw of pids) {
      const pid = parseInt(raw, 10);
      if (!pid || pid === myPid) continue;

      // Check if it's a node process running our script
      try {
        const cmdline = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();
        if (cmdline.includes("index.js")) {
          console.log(`Killing old Epiphany instance (PID ${pid}): ${cmdline}`);
          process.kill(pid, "SIGKILL");
        } else {
          console.error(`Port ${port} is held by a non-Epiphany process (PID ${pid}): ${cmdline}`);
          console.error("Free the port or change DASHBOARD_PORT, then try again.");
          process.exit(1);
        }
      } catch {
        // Process may have already exited
      }
    }

    // Brief wait for OS to release the port
    execSync("sleep 1");
  } catch {
    // lsof returns non-zero if no matches — port is free
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const MAX_MESSAGE_LENGTH = 4000;

// Per-thread lock to prevent concurrent Claude calls
const threadLocks = new Map(); // "channel:threadTs" -> Promise

async function withThreadLock(channel, threadTs, fn) {
  const lockKey = sessions.makeKey(channel, threadTs);
  const prev = threadLocks.get(lockKey) || Promise.resolve();
  const next = prev.then(fn, fn); // run after previous completes (even if it failed)
  threadLocks.set(lockKey, next);
  try {
    return await next;
  } finally {
    // Clean up if this was the last in the chain
    if (threadLocks.get(lockKey) === next) {
      threadLocks.delete(lockKey);
    }
  }
}

// Track last processed message timestamp per channel (for catch-up after sleep)
const lastProcessedTs = new Map();

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

// Extract [FILE]: /path lines from response, return { cleanText, filePaths }
function extractFiles(text) {
  const filePaths = [];
  const cleanLines = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\[FILE\]:\s*(.+)$/);
    if (match) {
      const fp = match[1].trim();
      if (fs.existsSync(fp)) filePaths.push(fp);
    } else {
      cleanLines.push(line);
    }
  }
  return { cleanText: cleanLines.join("\n").trim(), filePaths };
}

async function uploadFiles(client, channel, filePaths, threadTs) {
  for (const fp of filePaths) {
    try {
      const opts = {
        channel_id: channel,
        file: fs.createReadStream(fp),
        filename: path.basename(fp),
      };
      if (threadTs) opts.thread_ts = threadTs;
      await client.filesUploadV2(opts);
    } catch (err) {
      console.error(`Failed to upload ${fp}:`, err.message);
    }
  }
}

async function postResponse(client, channel, text, threadTs) {
  const { cleanText, filePaths } = extractFiles(text);
  if (cleanText) {
    const chunks = splitMessage(cleanText);
    for (const chunk of chunks) {
      const msg = { channel, text: chunk };
      if (threadTs) msg.thread_ts = threadTs;
      await client.chat.postMessage(msg);
    }
  }
  if (filePaths.length > 0) {
    await uploadFiles(client, channel, filePaths, threadTs);
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
async function postWithPermissionRequest(client, channel, threadTs, result) {
  if (result.response) {
    await postResponse(client, channel, result.response, threadTs);
  }

  const actionId = `perm_${Date.now()}`;
  pendingPermissions.set(actionId, {
    channel,
    threadTs: threadTs || null,
    prompt: result._originalPrompt,
    sessionId: result.sessionId,
    denials: result.permissionDenials,
    cwd: result._cwd || null,
  });

  prunePermissions();

  const denialText = formatDenials(result.permissionDenials);

  const msg = {
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
  };
  if (threadTs) msg.thread_ts = threadTs;
  await client.chat.postMessage(msg);

  // Broadcast permission request to dashboard
  broadcastEvent("permission-request", {
    actionId,
    channel,
    threadTs: threadTs || null,
    sessionId: result.sessionId,
    denials: result.permissionDenials,
    prompt: result._originalPrompt,
  });
}

// Post Claude result — shared by handlePrompt and allow handler
async function postClaudeResult(client, channel, threadTs, result, originalPrompt) {
  if (result.error) {
    await postResponse(client, channel, `:x: ${result.error}`, threadTs);
    return;
  }

  if (result.sessionId) {
    sessions.set(channel, threadTs, result.sessionId);
  }

  if (result.permissionDenials && result.permissionDenials.length > 0) {
    result._originalPrompt = originalPrompt;
    await postWithPermissionRequest(client, channel, threadTs, result);
    return;
  }

  if (result.response) {
    await postResponse(client, channel, result.response, threadTs);
  } else {
    await postResponse(client, channel, ":warning: Claude returned an empty response. Try again.", threadTs);
  }
}

// Capture a photo and upload to Slack
const SNAP_PATH = path.join(__dirname, "..", "data", "snap.jpg");

async function handleSnap(client, channel, messageTs, threadTs) {
  try {
    await new Promise((resolve, reject) => {
      execFile("imagesnap", ["-w", "1", SNAP_PATH], { timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await removeReaction(client, channel, messageTs);

    const opts = {
      channel_id: channel,
      file: fs.createReadStream(SNAP_PATH),
      filename: `snap_${Date.now()}.jpg`,
      initial_comment: ":camera_with_flash: Here's what I see!",
    };
    if (threadTs) opts.thread_ts = threadTs;
    await client.filesUploadV2(opts);
  } catch (err) {
    await removeReaction(client, channel, messageTs);
    console.error("Snap error:", err);
    await postResponse(client, channel, `:x: Camera error: ${err.message}`, threadTs);
  }
}

// Record video and upload to Slack
const VIDEO_PATH = path.join(__dirname, "..", "data", "video.mp4");

async function handleVideo(client, channel, messageTs, threadTs, duration) {
  try {
    await postResponse(client, channel, `:movie_camera: Recording ${duration}s video...`, threadTs);

    await new Promise((resolve, reject) => {
      // ffmpeg: capture from default camera via AVFoundation
      const args = [
        "-f", "avfoundation",
        "-framerate", "30",
        "-video_size", "1280x720",
        "-i", "0",
        "-t", String(duration),
        "-y",
        VIDEO_PATH,
      ];
      execFile("ffmpeg", args, { timeout: (duration + 10) * 1000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await removeReaction(client, channel, messageTs);

    const opts = {
      channel_id: channel,
      file: fs.createReadStream(VIDEO_PATH),
      filename: `video_${Date.now()}.mp4`,
      initial_comment: `:movie_camera: Here's a ${duration}s video!`,
    };
    if (threadTs) opts.thread_ts = threadTs;
    await client.filesUploadV2(opts);
  } catch (err) {
    await removeReaction(client, channel, messageTs);
    console.error("Video error:", err);
    await postResponse(client, channel, `:x: Video error: ${err.message}`, threadTs);
  }
}

// Handle the main message flow
async function handlePrompt(client, channel, messageTs, threadTs, text, sessionOpts) {
  const result = await claude.run(sessionOpts);
  await removeReaction(client, channel, messageTs);

  // Log to history
  if (result.sessionId) {
    history.append(result.sessionId, {
      role: "user",
      text,
      source: "slack",
      channel,
      threadTs,
    });
    if (result.response) {
      history.append(result.sessionId, {
        role: result.error ? "error" : "assistant",
        text: result.response,
        source: "slack",
        channel,
        threadTs,
      });
    }
  }

  await postClaudeResult(client, channel, threadTs, result, text);

  // Broadcast session update to dashboard
  if (result.sessionId) {
    broadcastEvent("session-update", { sessionId: result.sessionId });
  }
}

// --- Slack event: incoming message ---
app.event("message", async ({ event, client }) => {
  if (event.bot_id || event.subtype) return;

  const text = (event.text || "").trim();
  if (!text) return;

  const channel = event.channel;
  const messageTs = event.ts;
  // For top-level messages, thread_ts is undefined — use event.ts as the new thread anchor
  const threadTs = event.thread_ts || event.ts;

  lastProcessedTs.set(sessions.makeKey(channel, threadTs), messageTs);

  await addReaction(client, channel, messageTs);

  try {
    // Built-in commands
    if (isCommand(text)) {
      const response = await handleCommand(text);
      await removeReaction(client, channel, messageTs);
      await postResponse(client, channel, response, threadTs);
      return;
    }

    // Project commands
    if (isProjectCommand(text)) {
      const { sub, arg } = parseProjectCommand(text);
      const result = handleProjectCommand(sub, arg, channel, event.user);
      await removeReaction(client, channel, messageTs);
      if (result.blocks) {
        const msg = {
          channel,
          text: result.text,
          blocks: result.blocks,
        };
        if (threadTs) msg.thread_ts = threadTs;
        await client.chat.postMessage(msg);
      } else {
        await postResponse(client, channel, result.text, threadTs);
      }
      return;
    }

    // "snap" — capture photo from camera and upload to Slack (no lock needed)
    if (isSnap(text)) {
      await handleSnap(client, channel, messageTs, threadTs);
      return;
    }

    // "video [seconds]" — record video and upload to Slack (no lock needed)
    if (isVideo(text)) {
      const duration = parseVideoDuration(text);
      await handleVideo(client, channel, messageTs, threadTs, duration);
      return;
    }

    // Everything below goes to Claude — queue per thread
    await withThreadLock(channel, threadTs, async () => {
      // "cc <command> [args]" — execute a custom Claude Code slash command
      if (isRunCommand(text)) {
        const cwd = projects.get(channel);
        if (!cwd) {
          await removeReaction(client, channel, messageTs);
          await postResponse(client, channel, ":x: No project bound to this channel. Use `project set` to bind one first.", threadTs);
          return;
        }

        const commandsDir = path.join(cwd, ".claude", "commands");
        const { command, args } = parseRunCommand(text);

        // Bare "cc" — list available commands
        if (!command) {
          await removeReaction(client, channel, messageTs);
          let files = [];
          try {
            files = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
          } catch {}
          if (files.length === 0) {
            await postResponse(client, channel, `:warning: No custom commands found in \`${commandsDir}\``, threadTs);
          } else {
            const names = files.map((f) => `\u2022 \`${f.replace(/\.md$/, "")}\``);
            await postResponse(client, channel, `*Available custom commands:*\n${names.join("\n")}\n\nUsage: \`cc <command> [args]\``, threadTs);
          }
          return;
        }

        // Resolve the command file
        const cmdFile = path.join(commandsDir, `${command}.md`);
        if (!fs.existsSync(cmdFile)) {
          await removeReaction(client, channel, messageTs);
          let files = [];
          try {
            files = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
          } catch {}
          const available = files.length > 0
            ? `\nAvailable commands: ${files.map((f) => `\`${f.replace(/\.md$/, "")}\``).join(", ")}`
            : "";
          await postResponse(client, channel, `:x: Unknown command \`${command}\`.${available}`, threadTs);
          return;
        }

        // Read template, replace $ARGUMENTS, send to Claude
        const template = fs.readFileSync(cmdFile, "utf-8");
        const prompt = template.replace(/\$ARGUMENTS/g, args);

        const sessionId = sessions.get(channel, threadTs);
        const sessionOpts = sessionId
          ? { prompt, resume: sessionId, cwd }
          : { prompt, cwd };

        await handlePrompt(client, channel, messageTs, threadTs, text, sessionOpts);
        return;
      }

      // "continue" — resume most recent terminal session
      if (isContinue(text)) {
        const cwd = projects.get(channel) || undefined;
        await handlePrompt(client, channel, messageTs, threadTs, text, {
          prompt: "",
          continueSession: true,
          cwd,
        });
        return;
      }

      // Default — send to Claude as prompt
      const sessionId = sessions.get(channel, threadTs);
      const cwd = projects.get(channel) || undefined;

      if (sessionId) {
        await handlePrompt(client, channel, messageTs, threadTs, text, {
          prompt: text,
          resume: sessionId,
          cwd,
        });
      } else {
        await handlePrompt(client, channel, messageTs, threadTs, text, {
          prompt: text,
          cwd,
        });
      }
    });
  } catch (err) {
    console.error("Error handling message:", err);
    await removeReaction(client, channel, messageTs);
    try {
      await postResponse(client, channel, `:x: Something went wrong: ${err.message}`, threadTs);
    } catch {}
  }
});

// --- Slack action: Allow button clicked ---
app.action(/^allow_perm_/, async ({ action, ack, client, body }) => {
  await ack();

  const actionId = action.action_id.replace("allow_", "");
  const pending = pendingPermissions.get(actionId);
  const channel = pending?.channel || body.channel?.id;
  const threadTs = pending?.threadTs || null;

  if (!pending) {
    console.error("Allow clicked but no pending permission found:", actionId);
    if (channel) {
      const msg = {
        channel,
        text: ":warning: Permission request expired (app may have restarted). Please re-send your message.",
      };
      if (threadTs) msg.thread_ts = threadTs;
      await client.chat.postMessage(msg);
    }
    return;
  }
  pendingPermissions.delete(actionId);

  const { prompt, sessionId, denials, cwd: pendingCwd } = pending;
  const allowedTools = buildAllowedTools(denials);
  const cwd = pendingCwd || projects.get(channel) || undefined;

  try {
    const approvalMsg = {
      channel,
      text: `:white_check_mark: Approved. Retrying with permission for: ${allowedTools.join(", ")}`,
    };
    if (threadTs) approvalMsg.thread_ts = threadTs;
    await client.chat.postMessage(approvalMsg);

    const result = await claude.run({
      prompt: prompt || "Please retry the previously denied operations.",
      resume: sessionId,
      allowedTools,
      cwd,
    });

    await postClaudeResult(client, channel, threadTs, result, prompt);
    broadcastEvent("permission-resolved", { actionId, status: "allowed" });
    if (result.sessionId) {
      broadcastEvent("session-update", { sessionId: result.sessionId });
    }
  } catch (err) {
    console.error("Error retrying with permissions:", err);
    try {
      await postResponse(client, channel, `:x: Retry failed: ${err.message}`, threadTs);
    } catch {}
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
    // Clear all thread sessions in this channel
    const channelSessions = sessions.getByChannel(channel);
    for (const [key, entry] of Object.entries(channelSessions)) {
      sessions.clear(entry.channelId, entry.threadTs);
    }
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
    const msg = {
      channel: pending.channel,
      text: ":no_entry_sign: Permission denied. Claude will work without those tools.",
    };
    if (pending.threadTs) msg.thread_ts = pending.threadTs;
    await client.chat.postMessage(msg);
  }
  broadcastEvent("permission-resolved", { actionId, status: "denied" });
});

// --- Catch-up: process missed messages after sleep/reconnect ---
async function catchUpMissedMessages(client) {
  // Gather all channels we care about: session channels + project bindings
  const channelIds = new Set();
  for (const [key, entry] of Object.entries(sessions.all())) {
    const { channelId } = sessions.parseKey(key);
    channelIds.add(channelId);
  }
  for (const ch of Object.keys(projects.all())) {
    channelIds.add(ch);
  }

  for (const channel of channelIds) {
    try {
      const result = await client.conversations.history({
        channel,
        limit: 5,
      });

      if (!result.messages || result.messages.length === 0) continue;

      // Find the latest user message (not from bot, no subtype)
      const lastUserMsg = result.messages.find(
        (m) => !m.bot_id && !m.subtype && m.text?.trim()
      );
      if (!lastUserMsg) continue;

      // Determine thread context
      const threadTs = lastUserMsg.thread_ts || lastUserMsg.ts;

      // Check if the bot already replied after this message
      const botRepliedAfter = result.messages.some(
        (m) => m.bot_id && parseFloat(m.ts) > parseFloat(lastUserMsg.ts)
      );
      if (botRepliedAfter) continue;

      // Check if we already processed this message
      const threadKey = sessions.makeKey(channel, threadTs);
      const lastTs = lastProcessedTs.get(threadKey);
      if (lastTs && parseFloat(lastTs) >= parseFloat(lastUserMsg.ts)) continue;

      console.log(`Catching up missed message in ${channel}: "${lastUserMsg.text.slice(0, 50)}..."`);

      lastProcessedTs.set(threadKey, lastUserMsg.ts);
      await addReaction(client, channel, lastUserMsg.ts);

      // Process through the lock like a normal message
      await withThreadLock(channel, threadTs, async () => {
        const text = lastUserMsg.text.trim();
        const sessionId = sessions.get(channel, threadTs);
        const cwd = projects.get(channel) || undefined;

        if (sessionId) {
          await handlePrompt(client, channel, lastUserMsg.ts, threadTs, text, {
            prompt: text,
            resume: sessionId,
            cwd,
          });
        } else {
          await handlePrompt(client, channel, lastUserMsg.ts, threadTs, text, {
            prompt: text,
            cwd,
          });
        }
      });
    } catch (err) {
      // conversations.history may fail for channels the bot can't access
      console.error(`Catch-up failed for ${channel}:`, err.message);
    }
  }
}

// --- Scheduled commands ---

const runningSchedules = new Set();

async function runSchedule(client, id, schedule) {
  if (runningSchedules.has(id)) return;
  runningSchedules.add(id);

  try {
    const cwd = projects.get(schedule.sourceChannel);
    if (!cwd) {
      console.error(`Schedule ${id}: no project bound to ${schedule.sourceChannel}`);
      return;
    }

    const cmdFile = path.join(cwd, ".claude", "commands", `${schedule.command}.md`);
    if (!fs.existsSync(cmdFile)) {
      console.error(`Schedule ${id}: command file not found: ${cmdFile}`);
      return;
    }

    const template = fs.readFileSync(cmdFile, "utf-8");
    const prompt = template.replace(/\$ARGUMENTS/g, schedule.args || "");

    // Fresh session each run — don't resume, so past permission denials don't accumulate
    // Pre-allow tools so scheduled commands run unattended (Edit excluded — use Write instead)
    const sessionOpts = {
      prompt,
      cwd,
      allowedTools: schedule.allowedTools || ["Bash", "Read", "Write", "Glob", "Grep", "mcp__*"],
      context: "You are running as an automated scheduled command. The Edit tool is not available. Use the Write tool to create or update files (write the full file content). Never use the Edit tool.",
    };

    console.log(`Schedule ${id}: running "${schedule.command}" (args: ${schedule.args || "none"})`);

    const result = await withThreadLock(schedule.sourceChannel, null, async () => {
      return claude.run(sessionOpts);
    });

    // Attach CWD so permission retries use the correct project directory
    result._cwd = cwd;

    const responseText = result.response || "";
    const isNoChange = !result.error && !result.permissionDenials?.length &&
      /no (new |updates|changes|mentions)|same \d+ mentions|nothing new/i.test(responseText);

    // Clear error tracking on success
    if (!result.error) {
      delete schedule.lastError;
      delete schedule.lastErrorTs;
    }

    if (isNoChange && schedule.lastMessageTs) {
      // Edit the previous message in-place instead of posting a new one
      const editText = `:white_check_mark: Last run: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })} — No new updates.`;
      try {
        await client.chat.update({
          channel: schedule.outputChannel,
          ts: schedule.lastMessageTs,
          text: editText,
        });
      } catch {
        // Message may be too old to edit, post new instead
        await postResponse(client, schedule.outputChannel, editText);
      }
    } else if (result.error) {
      const isSameError = schedule.lastError === result.error && schedule.lastErrorTs;
      const errorText = `:x: Schedule error: ${result.error}\n_Last occurred: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })}_`;

      if (isSameError) {
        // Same error repeating — edit the previous message instead of spamming
        try {
          await client.chat.update({
            channel: schedule.outputChannel,
            ts: schedule.lastErrorTs,
            text: errorText,
          });
        } catch {
          const posted = await client.chat.postMessage({
            channel: schedule.outputChannel,
            text: errorText,
          });
          schedule.lastErrorTs = posted.ts;
        }
      } else {
        // New error — post fresh message and track it
        const posted = await client.chat.postMessage({
          channel: schedule.outputChannel,
          text: errorText,
        });
        schedule.lastErrorTs = posted.ts;
      }
      schedule.lastError = result.error;
    } else if (result.permissionDenials?.length) {
      result._originalPrompt = prompt;
      await postWithPermissionRequest(client, schedule.outputChannel, undefined, result);
    } else if (responseText) {
      // Post via postResponse (handles splitting + file uploads)
      await postResponse(client, schedule.outputChannel, responseText);
      // Post a separate trackable status message we can edit later
      const status = await client.chat.postMessage({
        channel: schedule.outputChannel,
        text: `:white_check_mark: Last run: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })}`,
      });
      schedule.lastMessageTs = status.ts;
    } else {
      // No response at all — post a status update
      const posted = await client.chat.postMessage({
        channel: schedule.outputChannel,
        text: `:white_check_mark: Last run: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })} — No new updates.`,
      });
      schedule.lastMessageTs = posted.ts;
    }

    schedule.lastRun = new Date().toISOString();
    schedules.set(id, schedule);
    broadcastEvent("schedule-update", { id, schedule });
    console.log(`Schedule ${id}: completed`);
  } catch (err) {
    console.error(`Schedule ${id} failed:`, err.message);
  } finally {
    runningSchedules.delete(id);
  }
}

function tickSchedules(client) {
  const all = schedules.all();
  const now = Date.now();

  for (const [id, schedule] of Object.entries(all)) {
    if (!schedule.enabled) continue;
    if (runningSchedules.has(id)) continue;

    const interval = (schedule.intervalMinutes || 5) * 60 * 1000;
    const lastRun = schedule.lastRun ? new Date(schedule.lastRun).getTime() : 0;

    if (now - lastRun >= interval) {
      runSchedule(client, id, schedule);
    }
  }
}

(async () => {
  try {
    await app.start();
    console.log("Epiphany is running!");

    // Catch up any messages missed during downtime/sleep
    setTimeout(() => catchUpMissedMessages(app.client), 3000);

    // Also catch up on WebSocket reconnect (e.g. after laptop wakes from sleep)
    if (app.receiver?.client) {
      app.receiver.client.on("connected", () => {
        console.log("WebSocket reconnected, checking for missed messages...");
        setTimeout(() => catchUpMissedMessages(app.client), 2000);
      });
    }

    // Start web dashboard
    const dashboardPort = parseInt(process.env.DASHBOARD_PORT, 10) || 3141;
    killOldInstance(dashboardPort);
    const dashboardApp = createDashboard({ sessions, projects, history, claude, pendingPermissions, schedules, slackClient: app.client });
    dashboardApp.listen(dashboardPort, () => {
      console.log(`Dashboard running at http://localhost:${dashboardPort}`);
    });

    // Tick scheduled commands every 60 seconds
    setInterval(() => tickSchedules(app.client), 60_000);
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
})();
