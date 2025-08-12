import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;

// Healthcheck route
app.get("/", (_req, res) => res.send("Voice Gateway is live"));

// WebSocket server for Twilio Media Streams
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (twilioWS, req) => {
  const search = new URL(req.url, "http://gateway.local").searchParams;
  const leadId = search.get("leadId") || "unknown";

  console.log("✅ Twilio stream connected", { leadId });

  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "start":
          console.log(`📞 Call started: ${data.start.callSid}`);
          break;

        case "media":
          // data.media.payload is base64-encoded PCM audio from Twilio
          // In the next step we will forward this to OpenAI Realtime.
          break;

        case "stop":
          console.log("🛑 Call ended");
          break;

        default:
          // other Twilio events: "mark", etc.
          break;
      }
    } catch (e) {
      console.error("WS message parse error:", e);
    }
  });

  twilioWS.on("close", () => {
    console.log("❎ Twilio stream closed");
  });
});

// Upgrade HTTP → WS for /stream
const server = app.listen(PORT, () => {
  console.log(`🚀 Voice Gateway listening on ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
