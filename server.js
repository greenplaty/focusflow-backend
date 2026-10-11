require("dotenv").config();

const http = require("http");

const PORT = process.env.PORT || 3000;
const BACKEND_VERSION = "v4.2-conversational";
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const EXTENSION_SHARED_KEY = process.env.EXTENSION_SHARED_KEY;
const AI_TIMEOUT_MS = 20000; // fail fast instead of hanging if the AI provider stalls
const MAX_BODY_BYTES = 16000; // room for a question plus a few turns of history

// Feedback email (optional). Uses Resend's API: https://resend.com
// Without your own domain, Resend can only deliver to the email you signed up with.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FEEDBACK_EMAIL_TO = process.env.FEEDBACK_EMAIL_TO;
const FEEDBACK_EMAIL_FROM = process.env.FEEDBACK_EMAIL_FROM || "FocusFlow Feedback <onboarding@resend.dev>";

// -----------------------------
// RATE LIMITING (simple in-memory, per IP)
// -----------------------------
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 20;
const FEEDBACK_RATE_LIMIT_MAX_REQUESTS = 5;
const requestLog = new Map(); // "bucket:ip" -> array of timestamps

function isRateLimited(ip, bucket, maxRequests) {
  const key = (bucket || "coach") + ":" + ip;
  const limit = maxRequests || RATE_LIMIT_MAX_REQUESTS;
  const now = Date.now();
  const timestamps = (requestLog.get(key) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );

  timestamps.push(now);
  requestLog.set(key, timestamps);

  return timestamps.length > limit;
}

// Render puts the real client IP first in X-Forwarded-For ("client, proxy1, ...")
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

// Reads a JSON body with a size cap. Calls back with (error, data).
function readJsonBody(req, res, callback) {
  let body = "";
  let tooLarge = false;

  req.on("data", function (chunk) {
    if (tooLarge) return;
    body += chunk;

    if (body.length > MAX_BODY_BYTES) {
      tooLarge = true;
      sendJSON(res, 413, { error: "Request too large" });
      req.destroy();
    }
  });

  req.on("end", function () {
    if (tooLarge) return;

    let data;
    try {
      data = JSON.parse(body || "{}");
    } catch (e) {
      sendJSON(res, 400, { error: "Invalid JSON" });
      return;
    }

    callback(data);
  });
}

// Occasionally clear out old entries so the map doesn't grow forever
setInterval(function () {
  const now = Date.now();
  for (const [ip, timestamps] of requestLog.entries()) {
    const fresh = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) {
      requestLog.delete(ip);
    } else {
      requestLog.set(ip, fresh);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Extension-Key"
  });

  res.end(JSON.stringify(data));
}
 
function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}
 
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Emails one feedback entry. Returns true if sent, false if skipped or failed.
// Never throws, so a mail problem can't break the feedback form.
async function sendFeedbackEmail(entry) {
  if (!RESEND_API_KEY || !FEEDBACK_EMAIL_TO) {
    return false;
  }

  const typeLabels = {
    idea: "Idea",
    bug: "Bug",
    coach: "AI coach answer",
    other: "Other"
  };
  const typeLabel = typeLabels[entry.type] || "Other";
  const preview = entry.message.replace(/\s+/g, " ").slice(0, 60);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Authorization": "Bearer " + RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FEEDBACK_EMAIL_FROM,
        to: [FEEDBACK_EMAIL_TO],
        subject: "[FocusFlow " + typeLabel + "] " + preview,
        text:
          "Type: " + typeLabel + "\n" +
          "Extension version: " + (entry.extensionVersion || "unknown") + "\n" +
          "Received: " + entry.receivedAt + "\n\n" +
          entry.message,
        html:
          "<p><strong>Type:</strong> " + escapeHtml(typeLabel) + "<br>" +
          "<strong>Extension version:</strong> " + escapeHtml(entry.extensionVersion || "unknown") + "<br>" +
          "<strong>Received:</strong> " + escapeHtml(entry.receivedAt) + "</p>" +
          "<p style=\"white-space: pre-wrap\">" + escapeHtml(entry.message) + "</p>"
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Feedback email failed:", response.status, detail.slice(0, 300));
      return false;
    }

    return true;
  } catch (error) {
    console.error("Feedback email error:", error.message);
    return false;
  }
}

function buildCoachPrompt(data) {
  const task = cleanText(data.task, 120) || "your task";
  const firstStep = cleanText(data.firstStep, 120) || "your first tiny step";
  const category = cleanText(data.category, 50) || "Other";
  const question = cleanText(data.question, 500) || "I need help getting started.";
 
  return (
    "Task: " + task + "\n" +
    "First tiny step: " + firstStep + "\n" +
    "Category: " + category + "\n" +
    "Student question: " + question
  );
}

function buildHistoryMessages(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];

  return rawHistory
    .filter(function (message) {
      return (
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0
      );
    })
    .slice(-8)
    .map(function (message) {
      return {
        role: message.role,
        content: cleanText(message.content, 800)
      };
    });
}
 
async function getAIResponse(data) {
  if (!AI_API_KEY || AI_API_KEY === "replace_this_with_your_key_later") {
    throw new Error("Missing AI API key");
  }
 
  const prompt = buildCoachPrompt(data);
  const historyMessages = buildHistoryMessages(data.history);
 
  const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: {
      "Authorization": "Bearer " + AI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are FocusFlow Coach, a short, practical productivity coach for students. Keep responses under 3 sentences. Do not solve full assignments. Help the student take the next tiny step. You may be given earlier turns of this conversation for context - build on them naturally instead of repeating earlier advice."
        },
        ...historyMessages,
        {
          role: "user",
          content:
`Here is the student's current situation:
 
${prompt}
 
You help students overcome procrastination and stay focused.
 
Always answer using exactly this format:
 
NEXT STEP:
(one specific action)
 
WHY THIS HELPS:
(one sentence)
 
2-MINUTE CHALLENGE:
(one tiny action)
 
Rules:
- Keep the total response under 100 words.
- Never solve homework for the student.
- Use the student's task and first step whenever possible.
- Directly address the student's question above.
- If earlier conversation turns were provided, treat this as a follow-up and build on them rather than repeating the same advice.
- Be practical, encouraging, and specific.`
        }
      ],
      max_tokens: 150,
      temperature: 0.7
    })
  });
 
  const result = await aiResponse.json();
 
  if (!aiResponse.ok) {
    console.error("AI API error:", result);
    throw new Error(result.error?.message || "AI request failed");
  }
 
  const text = result.choices?.[0]?.message?.content;
 
  if (!text) {
    console.error("Unexpected AI response:", JSON.stringify(result, null, 2));
    throw new Error("No AI response text found");
  }
 
  return text.trim();
}
 
const server = http.createServer(function (req, res) {
  if (req.method === "OPTIONS") {
    sendJSON(res, 200, {});
    return;
  }
 
  if (req.method === "GET" && req.url === "/") {
    sendJSON(res, 200, {
      message: "FocusFlow backend is running.",
      version: BACKEND_VERSION,
      aiKeyLoaded: Boolean(AI_API_KEY && AI_API_KEY !== "replace_this_with_your_key_later"),
      model: AI_MODEL,
      feedbackEmail: Boolean(RESEND_API_KEY && FEEDBACK_EMAIL_TO)
    });
    return;
  }

  if (req.method === "POST" && req.url === "/coach") {
    const ip = getClientIp(req);

    if (EXTENSION_SHARED_KEY && req.headers["x-extension-key"] !== EXTENSION_SHARED_KEY) {
      sendJSON(res, 401, { error: "Unauthorized" });
      return;
    }

    if (isRateLimited(ip, "coach", RATE_LIMIT_MAX_REQUESTS)) {
      sendJSON(res, 429, { error: "Too many requests, try again later" });
      return;
    }

    readJsonBody(req, res, async function (data) {
      try {
        const response = await getAIResponse(data);

        sendJSON(res, 200, {
          response: response
        });
      } catch (error) {
        console.error("Coach error:", error.message);

        sendJSON(res, 500, {
          error: error.message === "Missing AI API key"
            ? "AI coach unavailable: no AI_API_KEY set in .env"
            : "AI coach unavailable"
        });
      }
    });

    return;
  }

  // Feedback from the in-extension "Send feedback" form. Logged so it shows up
  // in the Render dashboard logs (search for "[feedback]").
  if (req.method === "POST" && req.url === "/feedback") {
    const ip = getClientIp(req);

    if (EXTENSION_SHARED_KEY && req.headers["x-extension-key"] !== EXTENSION_SHARED_KEY) {
      sendJSON(res, 401, { error: "Unauthorized" });
      return;
    }

    if (isRateLimited(ip, "feedback", FEEDBACK_RATE_LIMIT_MAX_REQUESTS)) {
      sendJSON(res, 429, { error: "Too many requests, try again later" });
      return;
    }

    readJsonBody(req, res, async function (data) {
      const message = cleanText(data.message, 2000);

      if (!message) {
        sendJSON(res, 400, { error: "Feedback message is empty" });
        return;
      }

      const entry = {
        type: cleanText(data.type, 30) || "other",
        message: message,
        extensionVersion: cleanText(data.extensionVersion, 20),
        receivedAt: new Date().toISOString()
      };

      // Always log it, so nothing is lost even if the email fails
      console.log("[feedback] " + JSON.stringify(entry));

      const emailed = await sendFeedbackEmail(entry);
      sendJSON(res, 200, { ok: true, emailed: emailed });
    });

    return;
  }

  sendJSON(res, 404, {
    error: "Route not found"
  });
});
 
server.listen(PORT, function () {
  console.log("FocusFlow backend running at http://localhost:" + PORT);
  console.log("Backend version:", BACKEND_VERSION);
  console.log(
    "AI key loaded:",
    Boolean(AI_API_KEY && AI_API_KEY !== "replace_this_with_your_key_later")
  );
  console.log("AI model:", AI_MODEL);
});
