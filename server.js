import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;

// Healthcheck
app.get("/", (_req, res) => res.send("Voice Gateway is live"));

// Accept Twilio's required subprotocol "audio"
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    if (Array.isArray(protocols) && protocols.includes("audio")) return "audio";
    return false; // reject if "audio" not offered
  },
});

wss.on("connection", async (twilioWS, req) => {
  const leadId = new URL(req.url, "http://gw").searchParams.get("leadId") || "unknown";
  console.log("✅ Twilio stream connected", { leadId, protocol: twilioWS.protocol });

  twilioWS.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg.toString());
      switch (evt.event) {
        case "start":
          console.log(`📞 Call started: ${evt.start.callSid}`);
          console.log("  -> media format:", evt.start.mediaFormat);
          break;
        case "media":
          // evt.media.payload is base64 PCM µ-law 8k
          // (Next step: forward to OpenAI Realtime)
          break;
        case "stop":
          console.log("🛑 Call ended");
          break;
        default:
          // mark, ping, etc.
          break;
      }
    } catch (e) {
      console.error("WS message parse error:", e);
    }
  });

  twilioWS.on("close", (code, reason) => {
    console.log("❎ Twilio stream closed", code, reason?.toString());
  });

  twilioWS.on("error", (err) => {
    console.error("WS error:", err);
  });
});

// Upgrade HTTP → WS for /stream
const server = app.listen(PORT, () => console.log(`🚀 Voice Gateway listening on ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/stream")) {
    // Log the subprotocol Twilio is requesting
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
