const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT, 10) || 300_000;

const SLACK_CONTEXT = [
  "You are being used through a Slack integration, not a terminal.",
  "The user is chatting with you from Slack.",
  "Your responses will be displayed as Slack messages (markdown formatting works).",
  "You cannot open URLs in a browser — the user has no terminal visible.",
  "To send a file to the user, include its absolute path on a line by itself prefixed with [FILE]: for example: [FILE]: /path/to/image.png",
  "The integration will automatically upload that file to Slack. You can send images, text files, PDFs, etc.",
  "If the user asks to see something and there's no file, output the content as text in your response.",
].join(" ");

function run({ prompt, sessionId, resume, continueSession, allowedTools, cwd, context }) {
  return new Promise((resolve) => {
    let settled = false;
    function settle(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    const args = [];

    if (continueSession) {
      args.push("--continue");
    } else if (resume) {
      args.push("--resume", resume);
    } else {
      const id = sessionId || uuidv4();
      args.push("--session-id", id);
    }

    args.push("-p", prompt, "--output-format", "stream-json", "--verbose");
    args.push("--append-system-prompt", context || SLACK_CONTEXT);

    if (allowedTools && allowedTools.length > 0) {
      args.push("--allowedTools", ...allowedTools);
    }

    let buffer = "";
    let stderr = "";
    let resultEvent = null;

    const spawnOpts = {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    };
    if (cwd) spawnOpts.cwd = cwd;

    const proc = spawn("claude", args, spawnOpts);

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5_000);
      settle({
        response: null,
        sessionId: null,
        error: "Claude timed out",
        permissionDenials: [],
      });
    }, TIMEOUT);

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "result") {
            resultEvent = event;
          }
        } catch {
          // Skip malformed lines
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        settle({
          response: null,
          sessionId: null,
          error: "Claude CLI not found. Make sure `claude` is installed and on your PATH.",
          permissionDenials: [],
        });
      } else {
        settle({
          response: null,
          sessionId: null,
          error: err.message,
          permissionDenials: [],
        });
      }
    });

    proc.on("close", (code) => {
      // Try to parse any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "result") {
            resultEvent = event;
          }
        } catch {
          // ignore
        }
      }

      if (resultEvent) {
        settle({
          response: resultEvent.result || null,
          sessionId: resultEvent.session_id || null,
          error: resultEvent.is_error ? resultEvent.result : null,
          permissionDenials: resultEvent.permission_denials || [],
        });
        return;
      }

      if (code !== 0) {
        settle({
          response: null,
          sessionId: null,
          error: stderr.trim() || `Claude exited with code ${code}`,
          permissionDenials: [],
        });
        return;
      }

      settle({
        response: null,
        sessionId: null,
        error: "No result event received from Claude",
        permissionDenials: [],
      });
    });
  });
}

function runStreaming({ prompt, sessionId, resume, cwd, context, onEvent }) {
  const args = [];

  if (resume) {
    args.push("--resume", resume);
  } else {
    const id = sessionId || uuidv4();
    args.push("--session-id", id);
  }

  args.push("-p", prompt, "--output-format", "stream-json", "--verbose");
  args.push("--append-system-prompt", context || SLACK_CONTEXT);

  let buffer = "";
  let stderr = "";

  const spawnOpts = {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (cwd) spawnOpts.cwd = cwd;

  const proc = spawn("claude", args, spawnOpts);

  const timer = setTimeout(() => {
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5_000);
    onEvent({ type: "error", error: "Claude timed out" });
  }, TIMEOUT);

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        onEvent(event);
      } catch {
        // skip malformed
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  proc.on("error", (err) => {
    clearTimeout(timer);
    onEvent({ type: "error", error: err.message });
  });

  proc.on("close", (code) => {
    clearTimeout(timer);
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        onEvent(event);
      } catch {}
    }
    if (code !== 0 && !buffer.trim()) {
      onEvent({ type: "error", error: stderr.trim() || `Claude exited with code ${code}` });
    }
  });

  return proc;
}

module.exports = { run, runStreaming };
