// ================== CONFIGURAÇÃO ==================
const DATABASE_URL = "https://detector-5e5ec-default-rtdb.firebaseio.com";
const POLL_MS = 1000;

// key = nó no Firebase (esp/<key>/movimento) | match = trecho do nome gravado pelo ESP32
const ROOMS = [
  { key: "pir_1", match: "recep", nome: "Recepção",    pir: "PIR 1", x: 40,  y: 40,  w: 330, h: 230 },
  { key: "pir_2", match: "escrit", nome: "Escritório", pir: "PIR 2", x: 390, y: 40,  w: 250, h: 230 },
  { key: "pir_3", match: "mezan", nome: "Mezanino",    pir: "PIR 3", x: 660, y: 40,  w: 200, h: 230 },
  { key: "pir_4", match: "almox", nome: "Almoxarifado", pir: "PIR 4", x: 40, y: 290, w: 520, h: 210 }
];

// ================== PLANTA (SVG) ==================
const svg = document.getElementById("planta");
let html = `
  <g class="decor">
    <rect x="580" y="290" width="280" height="210" rx="6"/>
    <text x="720" y="400">Entrada / Vitrine</text>
  </g>`;
ROOMS.forEach(r => {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  html += `
  <g class="room" id="room-${r.key}">
    <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6"/>
    <text class="nome" x="${cx}" y="${cy + 55}">${r.nome}</text>
    <text class="pir" x="${cx}" y="${cy + 75}">${r.pir}</text>
    <circle class="ring" cx="${cx}" cy="${cy - 10}" r="10"/>
    <circle class="sensor-dot" cx="${cx}" cy="${cy - 10}" r="12"/>
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="14" fill="#0f1720">●</text>
  </g>`;
});
html += `
  <line class="porta" x1="230" y1="270" x2="290" y2="270"/>
  <line class="porta" x1="480" y1="270" x2="540" y2="270"/>
  <line class="porta" x1="730" y1="270" x2="790" y2="270"/>
  <line class="porta" x1="560" y1="360" x2="560" y2="420"/>`;
svg.innerHTML = html;

// ================== ESTADO / RENDER ==================
const $ = id => document.getElementById(id);
const latched = new Set();     // sensores que dispararam durante o alarme atual
let alarmeAnterior = false;
let primeiraLeitura = true;
let baseline = new Set();      // eventos que já existiam quando o alarme começou
let demoAte = 0;
let somLigado = false;
let audioCtx = null, beepTimer = null;

function render(s) {
  const alarme = s.armado && s.alarme;

  // controla sensores "travados" durante o alarme
  if (alarme && !alarmeAnterior) {
    latched.clear();
    baseline = primeiraLeitura ? new Set() : new Set(s.eventos.map(e => e.id));
  }
  if (!alarme) latched.clear();
  if (alarme) {
    ROOMS.forEach(r => { if (s.mov[r.key]) latched.add(r.key); });
    const ult = [...s.eventos].reverse().find(e => e.tipo === "INTRUSAO" && !baseline.has(e.id));
    const sala = ult && ROOMS.find(r => (ult.sensor || "").toLowerCase().includes(r.match));
    if (sala) latched.add(sala.key);
  }
  alarmeAnterior = alarme;
  primeiraLeitura = false;

  // planta
  ROOMS.forEach(r => {
    const el = $("room-" + r.key);
    el.classList.toggle("alarm", alarme && latched.has(r.key));
    el.classList.toggle("mov", !!s.mov[r.key] && !(alarme && latched.has(r.key)));
  });

  // tela e banner
  document.body.classList.toggle("alarm", alarme);
  const banner = $("banner");
  banner.classList.toggle("armado", s.armado && !alarme);
  if (alarme) {
    const nomes = ROOMS.filter(r => latched.has(r.key)).map(r => r.nome);
    banner.textContent = "🚨 INTRUSÃO DETECTADA — Sensor: " + (nomes.join(", ") || "identificando...");
  } else if (s.armado) {
    banner.textContent = "🔒 Sistema ARMADO — monitorando";
  } else {
    banner.textContent = "🔓 Sistema DESARMADO";
  }

  // pílulas
  const ps = $("pillSistema");
  ps.textContent = "Sistema: " + (s.armado ? "ARMADO" : "DESARMADO");
  ps.className = "pill" + (s.armado ? " armado" : " ok");
  $("pillOcorrencias").textContent = "Ocorrências: " + s.ocorrencias;

  // eventos
  const ul = $("eventos");
  ul.innerHTML = s.eventos.length ? "" : '<li class="vazio">Sem eventos</li>';
  [...s.eventos].reverse().forEach(e => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="tag ${e.tipo}">${e.tipo}</span> — ${e.sensor}<small>${e.horario || ""}</small>`;
    ul.appendChild(li);
  });

  atualizarSom(alarme);
}

// ================== FIREBASE (polling REST) ==================
async function get(path, query = "") {
  const r = await fetch(`${DATABASE_URL}/${path}.json${query}`);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function tick() {
  if (Date.now() < demoAte) return;
  const pc = $("pillConexao");
  try {
    const q = `?orderBy=${encodeURIComponent('"$key"')}&limitToLast=8`;
    const [sis, ev, ...movs] = await Promise.all([
      get("esp/sistema"),
      get("esp/eventos", q),
      ...ROOMS.map(r => get(`esp/${r.key}/movimento`))
    ]);
    const mov = {};
    ROOMS.forEach((r, i) => mov[r.key] = movs[i] === true);
    const eventos = Object.entries(ev || {})
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, v]) => ({ id, ...v }));

    render({
      armado: !!(sis && sis.armado),
      alarme: !!(sis && sis.alarme),
      ocorrencias: (sis && sis.ocorrencias) || 0,
      mov, eventos
    });
    pc.textContent = "Firebase: conectado";
    pc.className = "pill ok";
  } catch (err) {
    pc.textContent = "Firebase: erro (" + err.message + ")";
    pc.className = "pill erro";
  }
}

// ================== SOM DO ALARME ==================
$("btnSom").onclick = () => {
  somLigado = !somLigado;
  if (somLigado && !audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  $("btnSom").textContent = somLigado ? "🔊 Som ligado" : "🔇 Som desligado";
  if (!somLigado) atualizarSom(false);
};

function beep() {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = "square"; o.frequency.value = 880; g.gain.value = 0.08;
  o.connect(g); g.connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + 0.18);
}

function atualizarSom(alarme) {
  if (alarme && somLigado && !beepTimer) beepTimer = setInterval(beep, 450);
  if ((!alarme || !somLigado) && beepTimer) { clearInterval(beepTimer); beepTimer = null; }
}

// ================== TESTE LOCAL ==================
$("btnTeste").onclick = () => {
  const sala = ROOMS[Math.floor(Math.random() * ROOMS.length)];
  const mov = {}; ROOMS.forEach(r => mov[r.key] = r.key === sala.key);
  demoAte = Date.now() + 6000;
  render({
    armado: true, alarme: true, ocorrencias: 1, mov,
    eventos: [{ id: "demo", tipo: "INTRUSAO", sensor: sala.nome, horario: "TESTE" }]
  });
};

tick();
setInterval(tick, POLL_MS);
