/* Pouch Run — an arcade runner driven by Squeektoshi's real wheel on Squeekchain.
 * Community project. Reads the public Squeekchain API (no key, CORS open).
 * Live data used in gameplay:
 *   /v1/status               measurement.rpmMilli  -> track speed and score multiplier
 *                            measurement.coreStatus / freshness -> day or night
 *                            measurement.distanceMm -> his distance today (menu, board)
 *                            builder.projected.blockHeight -> block height
 *   /v1/measurement/blocks   each newly revealed provisional Squeek block -> a golden Block Seed
 * If the API can't be reached, the game says so and runs Practice mode with simulated data.
 */
(() => {
  "use strict";

  const API = "https://api.squeekchain.com/v1";
  const REPO = "https://github.com/ld668668/pouch-run";
  const SQK = "0xd78a3956cF63164d1Fa1C622ad3c66623162Fa1e"; // SqueekToken on Sepolia (docs.squeekchain.com/developers)
  const SEPOLIA = "0xaa36a7";

  // ---------- canvas ----------
  const cv = document.getElementById("game");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const LANES = 3, LANE_W = 88, TRACK_X = (W - LANES * LANE_W) / 2;
  const laneX = (l) => TRACK_X + LANE_W * l + LANE_W / 2;
  const PLAYER_Y = H - 110;

  // ---------- live wheel state ----------
  const wheel = {
    source: "connecting", // live | practice | connecting
    running: false,
    rpm: 0,
    distanceKm: null,
    height: null,
    lastBlock: null,       // highest provisional block height seen
    pendingGold: 0,        // golden seeds waiting to drop
    goldLabels: [],
    failures: 0,
  };

  const $ = (id) => document.getElementById(id);
  document.getElementById("repoLink").href = REPO;

  async function getJSON(path) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    try {
      const r = await fetch(API + path, { headers: { accept: "application/json" }, cache: "no-store", signal: ac.signal });
      if (!r.ok) throw new Error(path + " " + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async function pollStatus() {
    try {
      const s = await getJSON("/status");
      const m = s.measurement;
      wheel.failures = 0;
      wheel.source = "live";
      if (m) {
        const online = m.freshness === "online";
        wheel.rpm = online ? Math.max(0, (m.rpmMilli || 0) / 1000) : 0;
        wheel.running = online && m.coreStatus === "ACTIVE" && wheel.rpm > 1;
        wheel.distanceKm = typeof m.distanceMm === "number" ? m.distanceMm / 1e6 : null;
      } else {
        wheel.running = false; wheel.rpm = 0;
      }
      if (s.builder && s.builder.status === "available") {
        wheel.height = (s.builder.projected || s.builder.anchor).blockHeight;
      }
    } catch (e) {
      wheel.failures++;
      if (wheel.failures >= 2) wheel.source = "practice";
    }
    renderLive();
  }

  async function pollBlocks() {
    if (wheel.source !== "live") return;
    try {
      const b = await getJSON("/measurement/blocks");
      if (b.status !== "available" || !Array.isArray(b.blocks)) return;
      let top = wheel.lastBlock;
      for (const blk of b.blocks) {
        const h = BigInt(blk.height);
        if (wheel.lastBlock !== null && h > wheel.lastBlock) {
          wheel.pendingGold = Math.min(wheel.pendingGold + 1, 4);
          wheel.goldLabels.push(blk.height);
        }
        if (top === null || h > top) top = h;
      }
      if (wheel.goldLabels.length > 8) wheel.goldLabels.splice(0, wheel.goldLabels.length - 8);
      wheel.lastBlock = top;
    } catch (e) { /* provisional blocks are optional */ }
  }

  // Practice mode: simulated wheel, clearly labelled.
  let simT = 0;
  function simulate(dt) {
    if (wheel.source !== "practice") return;
    simT += dt;
    const phase = (simT % 90) / 90;           // 90 s cycle: run 60 s, sleep 30 s
    wheel.running = phase < 0.66;
    wheel.rpm = wheel.running ? 70 + 25 * Math.sin(simT / 4) : 0;
    if (wheel.running && Math.random() < dt / 9) { wheel.pendingGold = Math.min(wheel.pendingGold + 1, 4); wheel.goldLabels.push("practice"); }
  }

  function renderLive() {
    const dot = $("liveDot"), txt = $("liveText");
    dot.className = "dot";
    if (wheel.source === "live") {
      if (wheel.running) { dot.classList.add("on"); txt.textContent = `LIVE · Squeektoshi running · ${wheel.rpm.toFixed(0)} RPM`; }
      else { dot.classList.add("sleep"); txt.textContent = "LIVE · Squeektoshi is resting · night run"; }
    } else if (wheel.source === "practice") {
      dot.classList.add("off"); txt.textContent = "API unreachable · Practice mode (simulated wheel)";
    } else txt.textContent = "Connecting to the wheel…";
    $("wStatus").textContent = wheel.source === "practice" ? "Practice" : wheel.running ? "Running" : wheel.source === "live" ? "Resting" : "–";
    $("wRpm").textContent = wheel.source === "live" ? wheel.rpm.toFixed(1) : "–";
    $("wDist").textContent = wheel.distanceKm !== null ? wheel.distanceKm.toFixed(2) + " km" : "–";
    $("wHeight").textContent = wheel.height ?? "–";
    $("todayGoal").textContent = wheel.distanceKm !== null
      ? `Squeektoshi has run ${wheel.distanceKm.toFixed(2)} km today.` : "";
  }

  pollStatus(); pollBlocks();
  setInterval(pollStatus, 5000);
  setInterval(pollBlocks, 6000);

  // ---------- game state ----------
  let G = null;
  function newGame() {
    G = {
      t: 0, dist: 0, lane: 1, px: laneX(1), lives: 3, inv: 0,
      score: 0, pouch: 0, pouchVal: 0, banked: 0, golds: 0, stashes: 0, crashes: 0,
      objs: [], spawnT: 0.6, burrowT: 9, over: false, flash: 0, msg: "", msgT: 0, scroll: 0,
    };
    wheel.pendingGold = 0;
  }
  const POUCH_MAX = 25;

  const speedNow = () => {
    const base = 230 + Math.min(G.t, 120) * 1.6;              // slowly harder
    const boost = wheel.running ? Math.min(wheel.rpm, 130) * 2.2 : 0;
    return base + boost;
  };
  const multNow = () => {
    if (!wheel.running) return 2;                             // night: seeds double
    return Math.round((1 + Math.min(wheel.rpm, 130) / 65) * 10) / 10;
  };

  function spawn() {
    const lane = (Math.random() * LANES) | 0;
    const r = Math.random();
    const hard = Math.min(G.t / 90, 1);
    if (r < 0.48) {
      // seed row
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) G.objs.push({ k: "seed", lane, y: -30 - i * 46 });
    } else if (r < 0.48 + 0.34 + hard * 0.1) {
      G.objs.push({ k: Math.random() < 0.5 ? "rock" : "trap", lane, y: -40 });
      if (hard > 0.5 && Math.random() < 0.35) G.objs.push({ k: "rock", lane: (lane + 1 + ((Math.random() * 2) | 0)) % 3, y: -40 });
    } else {
      G.objs.push({ k: "seed", lane, y: -30 });
    }
  }

  function say(m) { G.msg = m; G.msgT = 1.8; }

  function stash() {
    if (G.pouchVal <= 0) return;
    const pts = Math.round(G.pouchVal * multNow());
    G.score += pts; G.banked += G.pouch; G.stashes++;
    say(`STASHED +${pts}`);
    G.pouch = 0; G.pouchVal = 0;
  }

  function update(dt) {
    simulate(dt);
    if (!G || G.over) return;
    G.t += dt;
    const v = speedNow();
    G.dist += v * dt / 40;
    G.scroll = (G.scroll + v * dt) % 64;
    G.px += (laneX(G.lane) - G.px) * Math.min(1, dt * 18);
    if (G.inv > 0) G.inv -= dt;
    if (G.msgT > 0) G.msgT -= dt;
    if (G.flash > 0) G.flash -= dt;

    G.spawnT -= dt;
    if (G.spawnT <= 0) { spawn(); G.spawnT = Math.max(0.38, 0.85 - G.t / 200) * (300 / v) * 1.6; }
    G.burrowT -= dt;
    if (G.burrowT <= 0) { G.objs.push({ k: "burrow", lane: (Math.random() * 3) | 0, y: -60 }); G.burrowT = 10 + Math.random() * 6; }
    if (wheel.pendingGold > 0) {
      wheel.pendingGold--;
      const label = wheel.goldLabels.shift();
      G.objs.push({ k: "gold", lane: (Math.random() * 3) | 0, y: -40, label });
      say(label && label !== "practice" ? `BLOCK #${label} MINED!` : "BLOCK SEED!");
    }

    for (const o of G.objs) o.y += v * dt;
    for (const o of G.objs) {
      if (o.dead || o.lane !== G.lane) continue;
      const dy = Math.abs(o.y - PLAYER_Y);
      if (o.k === "burrow" && dy < 46) { stash(); o.dead = true; continue; }
      if (dy > 26) continue;
      if (o.k === "seed") {
        if (G.pouch < POUCH_MAX) { G.pouch++; G.pouchVal += 10; o.dead = true; }
      } else if (o.k === "gold") {
        G.pouch++; G.pouchVal += 250; G.golds++; o.dead = true; say("+250 GOLDEN BLOCK SEED");
      } else if ((o.k === "rock" || o.k === "trap") && G.inv <= 0) {
        o.dead = true; G.lives--; G.crashes++; G.inv = 1.5; G.flash = 0.25;
        if (G.pouchVal > 0) say(`DROPPED ${G.pouch} SEEDS`);
        G.pouch = 0; G.pouchVal = 0;
        if (G.lives <= 0) endGame();
      }
    }
    G.objs = G.objs.filter((o) => !o.dead && o.y < H + 80);
  }

  // ---------- drawing ----------
  function drawHamster(x, y, s, blink) {
    ctx.save(); ctx.translate(x, y);
    if (blink) ctx.globalAlpha = 0.45;
    ctx.fillStyle = "#e39a4f"; ctx.beginPath(); ctx.ellipse(0, 0, 20 * s, 24 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f8e2c4"; ctx.beginPath(); ctx.ellipse(0, 6 * s, 12 * s, 14 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#c97a35";
    ctx.beginPath(); ctx.arc(-13 * s, -18 * s, 6 * s, 0, Math.PI * 2); ctx.arc(13 * s, -18 * s, 6 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1b1410";
    ctx.beginPath(); ctx.arc(-7 * s, -8 * s, 2.6 * s, 0, Math.PI * 2); ctx.arc(7 * s, -8 * s, 2.6 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ff8fa3"; ctx.beginPath(); ctx.arc(0, -3 * s, 2.4 * s, 0, Math.PI * 2); ctx.fill();
    // cheek pouches swell as the pouch fills
    const p = G ? G.pouch / POUCH_MAX : 0;
    ctx.fillStyle = "#f0b072";
    ctx.beginPath(); ctx.ellipse(-15 * s, 0, (4 + 7 * p) * s, (5 + 6 * p) * s, 0, 0, Math.PI * 2);
    ctx.ellipse(15 * s, 0, (4 + 7 * p) * s, (5 + 6 * p) * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawObj(o) {
    const x = laneX(o.lane), y = o.y;
    if (o.k === "seed") {
      ctx.fillStyle = "#e8b26a"; ctx.beginPath(); ctx.ellipse(x, y, 7, 11, 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#6b4a22"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - 3, y - 6); ctx.lineTo(x + 3, y + 6); ctx.stroke();
    } else if (o.k === "gold") {
      const pulse = 1 + 0.12 * Math.sin(performance.now() / 120);
      ctx.fillStyle = "rgba(255,194,61,.25)"; ctx.beginPath(); ctx.arc(x, y, 26 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffc23d"; ctx.beginPath(); ctx.ellipse(x, y, 11, 16, 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff3c4"; ctx.beginPath(); ctx.arc(x - 3, y - 5, 3, 0, Math.PI * 2); ctx.fill();
      if (o.label && o.label !== "practice") { ctx.fillStyle = "#ffc23d"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center"; ctx.fillText("#" + o.label, x, y + 30); }
    } else if (o.k === "rock") {
      ctx.fillStyle = "#6f6a66"; ctx.beginPath(); ctx.moveTo(x - 24, y + 16); ctx.lineTo(x - 16, y - 12); ctx.lineTo(x + 6, y - 18); ctx.lineTo(x + 24, y + 2); ctx.lineTo(x + 18, y + 16); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#8d8782"; ctx.beginPath(); ctx.moveTo(x - 12, y - 8); ctx.lineTo(x + 4, y - 13); ctx.lineTo(x + 2, y - 2); ctx.closePath(); ctx.fill();
    } else if (o.k === "trap") {
      ctx.fillStyle = "#8a3b2b"; ctx.fillRect(x - 26, y - 6, 52, 14);
      ctx.fillStyle = "#c9c2b8";
      for (let i = -22; i <= 22; i += 11) { ctx.beginPath(); ctx.moveTo(x + i - 5, y - 6); ctx.lineTo(x + i, y - 18); ctx.lineTo(x + i + 5, y - 6); ctx.fill(); }
    } else if (o.k === "burrow") {
      ctx.fillStyle = "#3b2a1c"; ctx.beginPath(); ctx.ellipse(x, y, 36, 22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#0e0906"; ctx.beginPath(); ctx.ellipse(x, y + 3, 26, 14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#5fe08a"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center"; ctx.fillText("STASH", x, y - 28);
    }
  }

  function draw() {
    const night = !wheel.running;
    ctx.fillStyle = night ? "#0d1020" : "#3d6b35"; ctx.fillRect(0, 0, W, H);
    // track
    ctx.fillStyle = night ? "#1d1a24" : "#c9a26b"; ctx.fillRect(TRACK_X, 0, LANES * LANE_W, H);
    ctx.strokeStyle = night ? "#2c2838" : "#b48c58"; ctx.lineWidth = 2; ctx.setLineDash([22, 42]);
    const off = G ? G.scroll : 0;
    for (let l = 1; l < LANES; l++) { ctx.lineDashOffset = -off; ctx.beginPath(); ctx.moveTo(TRACK_X + l * LANE_W, 0); ctx.lineTo(TRACK_X + l * LANE_W, H); ctx.stroke(); }
    ctx.setLineDash([]);
    // side tufts
    ctx.fillStyle = night ? "#1a2238" : "#4f8a44";
    for (let i = -1; i < 12; i++) { const y = i * 64 + off; ctx.fillRect(10, y, 8, 18); ctx.fillRect(W - 18, y + 30, 8, 18); }

    if (G) {
      for (const o of G.objs) drawObj(o);
      drawHamster(G.px, PLAYER_Y, 1, G.inv > 0 && Math.floor(G.inv * 10) % 2 === 0);
    } else drawHamster(laneX(1), PLAYER_Y, 1, false);

    if (night) {
      const g = ctx.createRadialGradient(G ? G.px : laneX(1), PLAYER_Y - 60, 40, G ? G.px : laneX(1), PLAYER_Y - 60, 230);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(3,4,12,0.93)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (G && G.flash > 0) { ctx.fillStyle = "rgba(255,80,80,.35)"; ctx.fillRect(0, 0, W, H); }

    if (G && !G.over) {
      // HUD
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(0, 0, W, 54);
      ctx.textAlign = "left"; ctx.fillStyle = "#f6ead8"; ctx.font = "bold 18px monospace"; ctx.fillText(String(G.score), 12, 24);
      ctx.font = "10px monospace"; ctx.fillStyle = "#a8957f"; ctx.fillText(`${Math.floor(G.dist)} m`, 12, 42);
      ctx.textAlign = "center"; ctx.fillStyle = night ? "#8f9cff" : "#ffc23d"; ctx.font = "bold 14px monospace";
      ctx.fillText(`x${multNow().toFixed(1)}`, W / 2, 22);
      ctx.font = "9px monospace"; ctx.fillStyle = "#a8957f";
      ctx.fillText(night ? "NIGHT · SEEDS x2" : `${wheel.rpm.toFixed(0)} RPM${wheel.source === "practice" ? " (sim)" : ""}`, W / 2, 38);
      ctx.textAlign = "right"; ctx.fillStyle = "#ff8fa3"; ctx.font = "14px monospace"; ctx.fillText("♥".repeat(Math.max(0, G.lives)), W - 12, 22);
      // pouch bar
      const bw = 90, bx = W - 12 - bw;
      ctx.fillStyle = "#3a2e24"; ctx.fillRect(bx, 32, bw, 10);
      ctx.fillStyle = G.pouch >= POUCH_MAX ? "#ff5d5d" : "#e8b26a"; ctx.fillRect(bx, 32, bw * G.pouch / POUCH_MAX, 10);
      ctx.fillStyle = "#f6ead8"; ctx.font = "9px monospace"; ctx.fillText(`POUCH ${G.pouchVal}`, W - 12, 52);
      if (G.msgT > 0) {
        ctx.globalAlpha = Math.min(1, G.msgT); ctx.textAlign = "center"; ctx.fillStyle = "#ffc23d"; ctx.font = "bold 16px monospace";
        ctx.fillText(G.msg, W / 2, 110); ctx.globalAlpha = 1;
      }
    }
  }

  // ---------- loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    update(dt); draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- input ----------
  const move = (d) => { if (G && !G.over) G.lane = Math.max(0, Math.min(LANES - 1, G.lane + d)); };
  window.addEventListener("keydown", (e) => {
    if (["ArrowLeft", "a", "A"].includes(e.key)) move(-1);
    else if (["ArrowRight", "d", "D"].includes(e.key)) move(1);
    else if (e.key === " ") {
      e.preventDefault();
      if (G && !G.over) { const b = G.objs.find((o) => o.k === "burrow" && o.lane === G.lane && Math.abs(o.y - PLAYER_Y) < 90); if (b) { stash(); b.dead = true; } }
    }
  });
  let tx0 = null;
  const stage = $("stage");
  stage.addEventListener("touchstart", (e) => { tx0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (tx0 === null) return;
    const dx = e.changedTouches[0].clientX - tx0; tx0 = null;
    if (Math.abs(dx) > 24) move(dx > 0 ? 1 : -1);
    else { const r = stage.getBoundingClientRect(); move(e.changedTouches[0].clientX < r.left + r.width / 2 ? -1 : 1); }
  });

  // ---------- menus, scores, share ----------
  const loadScores = () => { try { return JSON.parse(localStorage.getItem("pouchrun.scores") || "[]"); } catch { return []; } };
  function renderScores() {
    const s = loadScores();
    $("scores").innerHTML = s.length ? s.map((x) => `<li>${x.score} · ${x.dist} m · ${x.golds} block seeds</li>`).join("") : "<li>No runs yet</li>";
  }
  renderScores();

  function start() { newGame(); $("menu").classList.add("hidden"); $("over").classList.add("hidden"); $("signNote").textContent = defaultNote; }
  function endGame() {
    G.over = true;
    const run = { score: G.score, dist: Math.floor(G.dist), golds: G.golds, at: Date.now() };
    const s = loadScores(); const prevBest = s.length ? s[0].score : 0;
    s.push(run); s.sort((a, b) => b.score - a.score); localStorage.setItem("pouchrun.scores", JSON.stringify(s.slice(0, 5)));
    renderScores();
    $("finalScore").textContent = G.score;
    $("finalStats").innerHTML = `${run.dist} m run · ${G.banked} seeds stashed in ${G.stashes} burrows<br>${G.golds} golden Block Seeds · ${wheel.source === "practice" ? "practice wheel" : wheel.running ? "day run at " + wheel.rpm.toFixed(0) + " RPM" : "night run"}`;
    $("bestLine").textContent = G.score > prevBest ? "New personal best!" : `Best: ${prevBest}`;
    const text = `I stashed ${G.score} points in Pouch Run, racing beside Squeektoshi's real wheel on @squeekchain 🐹`;
    $("shareBtn").href = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(location.origin + "/");
    setTimeout(() => $("over").classList.remove("hidden"), 400);
  }
  $("playBtn").onclick = start;
  $("againBtn").onclick = start;

  // ---------- optional: sign the run on Sepolia (zero-value SQK approve to yourself) ----------
  const defaultNote = $("signNote").textContent;
  $("signBtn").onclick = async () => {
    const note = $("signNote");
    const eth = window.ethereum;
    if (!eth) { note.textContent = "No browser wallet found. Install one (for example MetaMask) to sign on Sepolia."; return; }
    try {
      const [from] = await eth.request({ method: "eth_requestAccounts" });
      try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA }] }); }
      catch (e) { note.textContent = "Please switch your wallet to the Sepolia testnet and try again."; return; }
      const data = "0x095ea7b3" + from.slice(2).toLowerCase().padStart(64, "0") + "0".repeat(64); // approve(self, 0)
      note.textContent = "Confirm in your wallet…";
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: SQK, data, value: "0x0" }] });
      note.innerHTML = `Signed! <a href="https://sepolia.etherscan.io/tx/${hash}" target="_blank" rel="noopener">View on Sepolia</a>`;
    } catch (e) {
      note.textContent = (e && e.message) ? "Not sent: " + e.message.slice(0, 120) : "Not sent.";
    }
  };
})();
