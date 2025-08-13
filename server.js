/**
 * Vala Q Voice Gateway
 * Twilio Media Streams  <->  OpenAI Realtime (bi-directional audio)
 *
 * Requirements:
 * - Env: OPENAI_API_KEY
 * - TwiML uses <Start><Stream url="wss://.../stream?leadId=XYZ"/></Start>
 * - This server is deployed behind TLS (Render)
 */

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- Healthcheck
app.get("/", (_req, res) => res.send("Voice Gateway is live"));

// --- WS server that accepts Twilio Media Streams
const wss = new WebSocketServer({
  noServer: true,
  // Accept Twilio's required subprotocol "audio"
  handleProtocols: (protocols) => {
    if (Array.isArray(protocols) && protocols.includes("audio")) return "audio";
    return "audio"; // be permissive if Twilio omits it
  },
});

wss.on("connection", async (twilioWS, req) => {
  const params = new URL(req.url, "http://gw.local").searchParams;
  const leadId = params.get("leadId") || "unknown";

  console.log("✅ Twilio stream connected", { leadId, protocol: twilioWS.protocol });

  // ---- OpenAI Realtime WS
const oa = new WebSocket(
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
  {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  }
);

  let speaking = false;          // whether the agent is currently speaking
  let openaiReady = false;       // session open
  let twilioClosed = false;

  const flushIntervalMs = 250;   // how often to "commit" user audio segments
  let flushTimer = null;

  oa.on("open", () => {
    openaiReady = true;

    // Configure the session: μ-law 8k in/out + barge-in + short replies
    oa.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: `
You are Vala Q Designs' AI phone agent calling US businesses (Washington).
Goal: book a 15-minute intro about website ($300 one-pager) and automation (n8n, WhatsApp/Telegram bots).
Style: brief, friendly, natural. One or two short sentences max.
Disclose you are an AI assistant if asked.
When you get a time agreement, ask to confirm and keep it concise.
          `.trim(),
          modalities: ["audio"],
          voice: { provider: "openai", name: "alloy" },
          // Request μ-law 8k both ways so we can directly pass frames to Twilio
          input_audio_format: { type: "mulaw", sample_rate: 8000 },
          output_audio_format: { type: "mulaw", sample_rate: 8000 },
          turn_detection: { type: "server_vad" }, // barge-in
          // Keep answers tight to reduce latency
          text: { max_output_tokens: 80 },
        },
      })
    );

    // Start a response immediately (optional greeting on connect)
    oa.send(JSON.stringify({ type: "response.create", response: { instructions: "Hello! This is Vala Q Designs. Is now a bad time?" } }));

    // Start periodic flush of input buffer (if VAD doesn't auto-commit)
    flushTimer = setInterval(() => {
      if (openaiReady) {
        oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
    }, flushIntervalMs);
  });

  oa.on("message", (data) => {
    try {
      const evt = JSON.parse(data.toString());

      // OpenAI partial transcripts/events (optional to log)
      if (evt.type === "response.transcript.delta") {
        // console.log("ASR:", evt.delta);
      }

      // The important one: audio chunks (μ-law 8k) to send back to Twilio
      if (evt.type === "response.audio.delta" && evt.audio) {
        speaking = true;
        // Send straight back to Twilio as a media frame (payload must be base64)
        twilioSendMedia(evt.audio);
      }

      if (evt.type === "response.completed") {
        speaking = false;
      }

      // Tool calls etc. would be handled here (e.g., booking)
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

  // --- Twilio -> OpenAI: receive caller audio frames
  twilioWS.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg.toString());

      switch (evt.event) {
        case "start":
          console.log(`📞 Call started: ${evt.start.callSid}`);
          console.log("  -> media format:", evt.start.mediaFormat);
          break;

        case "media":
          // Base64 μ-law 8k frames from Twilio
          if (openaiReady) {
            // Append to OpenAI input audio buffer
            oa.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: evt.media.payload, // pass-through base64 mulaw
              })
            );

            // If the agent is speaking and the user talks, cancel speaking (barge-in)
            if (speaking) {
              oa.send(JSON.stringify({ type: "response.cancel" }));
              speaking = false;
            }
          }
          break;

        case "stop":
          console.log("🛑 Call ended");
          twilioWS.close();
          break;

        default:
          // "mark", "ping", etc.
          break;
      }
    } catch (e) {
      console.error("WS message parse error:", e);
    }
  });

  twilioWS.on("close", (code, reason) => {
    twilioClosed = true;
    console.log("❎ Twilio stream closed", code, reason?.toString());
    cleanup();
  });

  twilioWS.on("error", (err) => {
    console.error("Twilio WS error:", err);
    twilioClosed = true;
    cleanup();
  });

  // Helper: send a Twilio media frame
  function twilioSendMedia(base64Audio) {
    if (twilioClosed) return;
    try {
      const payload = {
        event: "media",
        media: { payload: base64Audio }, // base64 μ-law 8k
      };
      twilioWS.send(JSON.stringify(payload));
    } catch (e) {
      console.error("Error sending media to Twilio:", e);
    }
  }

  function cleanup() {
    try {
      if (flushTimer) clearInterval(flushTimer);
      if (oa && oa.readyState === 1) oa.close();
      if (twilioWS && twilioWS.readyState === 1) twilioWS.close();
    } catch (_) {}
  }
});

// --- HTTP -> WS upgrade
const server = app.listen(PORT, () => console.log(`🚀 Voice Gateway listening on ${PORT}`));

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
