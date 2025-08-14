/**
 * Vala Q Voice Gateway
 * Twilio Media Streams  <->  OpenAI Realtime (bi-directional audio)
 *
 * Env (Render -> Environment):
 *  - OPENAI_API_KEY=sk-...
 *  - N8N_OUTCOME_URL=https://valaqdesigns.app.n8n.cloud/webhook/call-outcome   (optional)
 */

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const N8N_OUTCOME_URL = process.env.N8N_OUTCOME_URL || null;

// ---- Healthcheck
app.get("/", (_req, res) => res.send("Voice Gateway is live"));

// ---- WebSocket server (Twilio <Start><Stream>)
const wss = new WebSocketServer({
  noServer: true,
  // Twilio may send "audio" subprotocol; accept it (or be permissive)
  handleProtocols: (protocols) => {
    if (Array.isArray(protocols) && protocols.includes("audio")) return "audio";
    return "audio";
  },
});

wss.on("connection", async (twilioWS, req) => {
  const url = new URL(req.url, "http://gw.local");
  const leadId = url.searchParams.get("leadId") || "unknown";

  console.log("✅ Twilio stream connected", { leadId, protocol: twilioWS.protocol });

  // ---- OpenAI Realtime WS
  const oa = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1", // REQUIRED for Realtime beta
      },
    }
  );

  // State
  let openaiReady = false;
  let speaking = false;
  let twilioClosed = false;
  let callSid = null;
  let callStartTs = Date.now();
  let transcript = ""; // build simple transcript
  let summary = "";    // optional quick summary at end
  let flushTimer = null;

  // Helper: send a Twilio media frame (base64 μ-law 8k)
  function twilioSendMedia(base64Audio) {
    if (twilioClosed) return;
    try {
      twilioWS.send(JSON.stringify({
        event: "media",
        media: { payload: base64Audio }
      }));
    } catch (e) {
      console.error("Error sending media to Twilio:", e);
    }
  }

  function cleanup() {
    try { if (flushTimer) clearInterval(flushTimer); } catch {}
    try { if (oa && oa.readyState === WebSocket.OPEN) oa.close(); } catch {}
    try { if (twilioWS && twilioWS.readyState === WebSocket.OPEN) twilioWS.close(); } catch {}
  }

  // ----- OpenAI events
  oa.on("open", () => {
    openaiReady = true;

    // Configure session for μ-law 8k + barge-in + concise replies
    oa.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: `
You are Vala Q Designs' AI phone agent calling US businesses in Washington.
Goal: book a 15-minute intro about website redesign ($300 one-page) and automations (n8n, WhatsApp/Telegram bots).
Style: brief, friendly, natural. One or two short sentences max. Don't monologue.
Disclose you're an AI assistant if asked. Be polite and efficient.
        `.trim(),
        modalities: ["audio"],
        voice: { provider: "openai", name: "alloy" },
        input_audio_format:  { type: "mulaw", sample_rate: 8000 },
        output_audio_format: { type: "mulaw", sample_rate: 8000 },
        turn_detection: { type: "server_vad" },
        text: { max_output_tokens: 90 }
      }
    }));

    // Optional: brief opening line
    oa.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Hi! This is Vala Q Designs. Do you handle your company's website?" }
    }));

    // Periodically flush input buffer (extra safety alongside VAD)
    flushTimer = setInterval(() => {
      try {
        oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch {}
    }, 250);
  });

  oa.on("message", (data) => {
    try {
      const evt = JSON.parse(data.toString());

      // Accumulate lightweight transcript (optional)
      if (evt.type === "response.transcript.delta" && evt.delta) {
        transcript += evt.delta;
      }
      if (evt.type === "response.output_text.delta" && evt.delta) {
        summary += evt.delta; // if we asked for a summary near the end
      }

      // Audio back to Twilio (μ-law 8k base64)
      if (evt.type === "response.audio.delta" && evt.audio) {
        speaking = true;
        twilioSendMedia(evt.audio);
      }

      if (evt.type === "response.completed") {
        speaking = false;
      }

      // TODO: Tool calls (e.g., book_meeting) can be handled here
      // if (evt.type === "response.function_call" && evt.name === "book_meeting") { ... }

    } catch (e) {
      console.error("OpenAI message parse error:", e);
    }
  });

  oa.on("close", (code, reason) => {
    console.log("🔻 OpenAI WS closed", code, reason?.toString());
    cleanup();
  });

  oa.on("error", (err) => {
    console.error("OpenAI WS error:", err);
    cleanup();
  });

  // ----- Twilio events
  twilioWS.on("message", async (msg) => {
    try {
      const evt = JSON.parse(msg.toString());

      switch (evt.event) {
        case "start":
          callSid = evt.start?.callSid || null;
          console.log(`📞 Call started: ${callSid}`);
          console.log("  -> media format:", evt.start.mediaFormat);
          break;

        case "media":
          // Base64 μ-law frames from Twilio → append into OpenAI input buffer
          if (openaiReady) {
            oa.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: evt.media.payload
            }));

            // If user speaks while agent is speaking → cancel (barge-in)
            if (speaking) {
              oa.send(JSON.stringify({ type: "response.cancel" }));
              speaking = false;
            }
          }
          break;

        case "stop":
          console.log("🛑 Call ended");
          // Optional: ask OA to produce a quick summary before we post outcome
          try {
            oa.send(JSON.stringify({
              type: "response.create",
              response: { instructions: "Give a 2-sentence summary of the call outcome." }
            }));
          } catch {}

          // Post outcome to n8n (non-blocking)
          if (N8N_OUTCOME_URL) {
            const payload = {
              leadId, callSid,
              status: "completed",
              startedAt: callStartTs,
              endedAt: Date.now(),
              summary,
              transcript
            };
            try {
              // Node 18+ has global fetch
              fetch(N8N_OUTCOME_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
              }).catch(err => console.error("Outcome POST failed:", err));
            } catch (e) {
              console.error("Outcome POST error:", e);
            }
          }

          try { twilioWS.close(); } catch {}
          break;

        default:
          // ping/mark etc.
          break;
      }
    } catch (e) {
      console.error("WS message parse error:", e);
    }
  });

  twilioWS.on("close", (code, reason) => {
    console.log("❎ Twilio stream closed", code, reason?.toString());
    cleanup();
  });

  twilioWS.on("error", (err) => {
    console.error("Twilio WS error:", err);
    cleanup();
  });
});

// ---- HTTP → WS upgrade
const server = app.listen(PORT, () => {
  console.log(`🚀 Voice Gateway listening on ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/stream")) {
    const protoHeader = req.headers["sec-websocket-protocol"];
    console.log("Upgrade requested with subprotocol(s):", protoHeader);
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("WS upgraded. Agreed subprotocol:", ws.protocol);
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
