// server.js
// Minimal express server: returns pending LayerZero messages for OWNER
// No private keys required. Intended to run in Codespaces / VPS.
// Usage: set env OWNER and optionally PORT, then `node server.js`

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
require("dotenv").config();

const OWNER = (process.env.OWNER || "").toLowerCase(); // owner address to watch
const PORT = process.env.PORT || 3000;
const LZ_API_BASE = process.env.LZSCAN_API_BASE || "https://api.testnet.layerzeroscan.com";
const LZ_TX_BASE = process.env.LZSCAN_TX_BASE || "https://testnet.layerzeroscan.com/tx";

if(!OWNER){
  console.error("Please set OWNER env var (the wallet address that sent the bridge).");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

/** heuristics to extract sender32/payload from raw HTML or JSON */
function guessHexesFromText(text){
  const hexes = (text.match(/0x[0-9a-fA-F]{64,}/g) || []);
  const uniq = [...new Set(hexes)];
  const out = { sender32:null, payload:null };

  const senders = uniq.filter(h => h.length === 66);
  if(senders.length) out.sender32 = senders[0];

  const payloads = uniq.filter(h => h.length > 66 && h.length % 2 === 0);
  if(payloads.length) out.payload = payloads[0];

  return out;
}

async function fetchMessagesByOwner(owner, page=1, limit=50){
  try{
    const url = `${LZ_API_BASE}/messages?address=${owner}&page=${page}&limit=${limit}`;
    const r = await fetch(url);
    if(!r.ok) throw new Error(`LZ API ${r.status}`);
    const j = await r.json();
    return j.messages || [];
  }catch(e){
    console.warn("LZ API error:", e.message);
    return [];
  }
}

async function fetchTxHtml(txHash){
  try{
    const url = `${LZ_TX_BASE}/${txHash}`;
    const r = await fetch(url, { headers:{ "User-Agent":"auto-scan-worker/1.0" }});
    if(!r.ok) return null;
    return await r.text();
  }catch(e){
    return null;
  }
}

/** GET /pending
 * Returns array of { srcTxHash, dstEid, sender32, payload, statusSummary }
 */
app.get("/pending", async (req, res) => {
  try{
    const owner = OWNER;
    const msgs = await fetchMessagesByOwner(owner, 1, 50);
    const out = [];

    for(const m of msgs){
      // We only care messages where executor status is WAITING (pending exec)
      // Different API shapes exist; be defensive
      const execStatus = (m?.executorResult?.status) || (m?.executorStatus) || null;
      if(!execStatus || execStatus.toUpperCase() !== "WAITING") continue;

      const txHash = m.srcTxHash || m.txHash || m?.tx?.txHash;
      if(!txHash) continue;

      // attempt to extract sender/payload from API fields first
      let sender32 = m.sender32 || m.sender || null;
      let payload = m.payload || m.payloadHex || m.data || null;

      // if missing, fetch tx page and parse heuristically
      if(!sender32 || !payload){
        const html = await fetchTxHtml(txHash);
        if(html){
          const g = guessHexesFromText(html);
          if(!sender32 && g.sender32) sender32 = g.sender32;
          if(!payload && g.payload) payload = g.payload;
        }
      }

      out.push({
        srcTxHash: txHash,
        dstEid: m.dstEid || m.dst_eid || m.dst || null,
        sender32,
        payload,
        statusSummary: execStatus,
        lzTxPage: `${LZ_TX_BASE}/${txHash}`
      });
    }

    res.json({ ok:true, owner, count: out.length, results: out });
  }catch(e){
    console.error("Error /pending:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get("/", (req,res) => res.send("LayerZero auto-scan backend (no private keys). GET /pending"));

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} | OWNER=${OWNER}`);
});
