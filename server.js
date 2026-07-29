require("dotenv").config();
 
const http = require("http");
 
const PORT = 3000;
const BACKEND_VERSION = "v3.9-real-ai-chat";
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
 
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
 
  res.end(JSON.stringify(data));
}
 
function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
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
 
async function getAIResponse(data) {
  if (!AI_API_KEY || AI_API_KEY === "replace_this_with_your_key_later") {
    throw new Error("Missing AI API key");
  }
 
  const prompt = buildCoachPrompt(data);
 
  const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
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
            "You are FocusFlow Coach, a short, practical productivity coach for students. Keep responses under 3 sentences. Do not solve full assignments. Help the student take the next tiny step."
        },
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
- Be practical, encouraging, and specific.`
        }
      ],
      max_tokens: 120,
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
      model: AI_MODEL
    });
    return;
  }
 
  if (req.method === "POST" && req.url === "/coach") {
    let body = "";
 
    req.on("data", function (chunk) {
      body += chunk;
 
      if (body.length > 5000) {
        req.destroy();
      }
    });
 
    req.on("end", async function () {
      try {
        const data = JSON.parse(body);
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