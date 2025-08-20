// server.js — shared scoreboard with UNIQUE outcomes + Admin panel support.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_FRIENDS = [
  "David J","David L","Zac","Zach","Will",
  "Jimmy","Scott","Nick","Joey","Brandy"
];

const PORT = process.env.PORT || 3000;
const RESET_SECRET = process.env.RESET_SECRET || ""; // optional legacy reset
const STATE_FILE = process.env.STATE_FILE || "";     // e.g. "/data/state.json" on Render (with disk)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "buck"; // per your request

let state = {
  friends: [...DEFAULT_FRIENDS],
  results: {},
  updatedAt: new Date().toISOString()
};

function loadFromDisk() {
  if (!STATE_FILE) return;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(data.friends)) state.friends = data.friends;
      if (data.results && typeof data.results === 'object') state.results = data.results;
      if (data.updatedAt) state.updatedAt = data.updatedAt;
    }
  } catch (e) { console.error("STATE_FILE load failed:", e.message); }
}
function saveToDisk() {
  if (!STATE_FILE) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error("STATE_FILE save failed:", e.message); }
}
loadFromDisk();

// Cee Lo logic
function d6(){ return 1 + Math.floor(Math.random()*6); }
function rollCeeLo(){
  while(true){
    const d = [d6(),d6(),d6()].sort((a,b)=>a-b);
    const [a,b,c] = d;
    if (a===4 && b===5 && c===6) return { dice:d, label:"4-5-6 (auto win)", type:"456" };
    if (a===1 && b===2 && c===3) return { dice:d, label:"1-2-3 (auto loss)", type:"123" };
    if (a===b && b===c)         return { dice:d, label:`Triple ${a}`, type:"triple", triple:a };
    if (a===b && b!==c)         return { dice:d, label:`Point ${c}`,  type:"point",  point:c };
    if (b===c && a!==b)         return { dice:d, label:`Point ${a}`,  type:"point",  point:a };
    if (a===c && b!==a)         return { dice:d, label:`Point ${b}`,  type:"point",  point:b };
  }
}
function rankScore(h){
  if(!h) return -1;
  if(h.type==='456')   return 400;
  if(h.type==='triple')return 300 + h.triple;
  if(h.type==='point') return 100 + h.point;
  if(h.type==='123')   return 0;
  return -1;
}
function computeLeaders(results){
  const entries = state.friends.map(name => ({ name, hand: results[name]||null }));
  const rolled = entries.filter(e => !!e.hand);
  if (rolled.length !== state.friends.length) return { ready:false };
  const withScores = rolled.map(e => ({ ...e, score: rankScore(e.hand) }))
                           .sort((A,B)=>B.score-A.score || A.name.localeCompare(B.name));
  const topScore = withScores[0].score;
  const leaders = withScores.filter(e => e.score === topScore);
  return { ready:true, leaders, topScore };
}

// Unique-outcome enforcement
function outcomeKey(h){
  if (!h) return "";
  if (h.type === "456" || h.type === "123") return h.type;
  if (h.type === "triple") return `triple:${h.triple}`;
  if (h.type === "point")  return `point:${h.point}`;
  return h.label;
}
const MAX_UNIQUE = 14; // 4-5-6, 1-2-3, six triples, six points

// Simple admin tokens
const adminTokens = new Set();
function issueAdminToken(){
  const t = crypto.randomBytes(16).toString('hex');
  adminTokens.add(t);
  return t;
}
function getToken(req){
  const h = req.headers['authorization'] || "";
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.body && req.body.token) return String(req.body.token);
  return "";
}
function requireAdmin(req,res,next){
  const t = getToken(req);
  if (!t || !adminTokens.has(t)) return res.status(401).json({ error: "Not authorized" });
  next();
}

// App
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (req,res)=>{
  res.json({
    friends: state.friends,
    results: state.results,
    updatedAt: state.updatedAt,
    winner: computeLeaders(state.results)
  });
});

app.post("/api/roll", (req,res)=>{
  const name = (req.body && req.body.name || "").trim();
  if (!state.friends.includes(name)) return res.status(400).json({ error: "Name not in league" });
  if (state.results[name])          return res.status(409).json({ error: "Already rolled" });

  const used = new Set(Object.values(state.results).map(outcomeKey));
  if (used.size >= MAX_UNIQUE) return res.status(409).json({ error: "All unique outcomes exhausted" });

  let hand, key, tries = 0;
  do {
    hand = rollCeeLo();
    key  = outcomeKey(hand);
    tries++;
    if (tries > 20000) return res.status(500).json({ error: "Exceeded attempts for unique outcome" });
  } while (used.has(key));

  state.results[name] = hand;
  state.updatedAt = new Date().toISOString();
  saveToDisk();
  res.json({ ok:true, hand, updatedAt: state.updatedAt, winner: computeLeaders(state.results) });
});

// Legacy reset with secret (optional for non-admin)
app.post("/api/reset", (req,res)=>{
  const { secret } = req.body || {};
  if (!RESET_SECRET || secret !== RESET_SECRET) return res.status(403).json({ error: "Bad secret" });
  state.results = {};
  state.updatedAt = new Date().toISOString();
  saveToDisk();
  res.json({ ok:true, updatedAt: state.updatedAt });
});

// Admin endpoints
app.post("/api/admin/login", (req,res)=>{
  const { password } = req.body || {};
  if (!password || String(password) !== ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong password" });
  const token = issueAdminToken();
  res.json({ ok:true, token });
});

app.post("/api/admin/set-names", requireAdmin, (req,res)=>{
  let { friends } = req.body || {};
  if (!Array.isArray(friends)) return res.status(400).json({ error: "friends must be an array" });
  friends = friends.map(s => String(s).trim()).filter(Boolean);
  const seen = new Set(); friends = friends.filter(n => (seen.has(n)?false:(seen.add(n),true)));
  if (friends.length === 0) return res.status(400).json({ error: "Need at least one name" });

  const newResults = {};
  for (const n of friends){ if (state.results[n]) newResults[n] = state.results[n]; }
  state.friends = friends;
  state.results = newResults;
  state.updatedAt = new Date().toISOString();
  saveToDisk();
  res.json({ ok:true, friends: state.friends, updatedAt: state.updatedAt });
});

app.post("/api/admin/reset", requireAdmin, (req,res)=>{
  state.results = {};
  state.updatedAt = new Date().toISOString();
  saveToDisk();
  res.json({ ok:true, updatedAt: state.updatedAt });
});

app.get("/health", (_,res)=>res.send("ok"));
app.listen(PORT, ()=> console.log(`Cee Lo running on :${PORT}`));
