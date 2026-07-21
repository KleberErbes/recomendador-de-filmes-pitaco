import { useState, useEffect, useRef, useMemo } from "react";

/*
  PITACO — arquivo pessoal de cinema com IA
  ------------------------------------------------------------------
  Redesign editorial "arquivo de cinema":
  · Tipografia gigante (Archivo Black) em página corrida com seções
    preto → papel → laranja, no espírito de zine/archive.
  · Parede de pôsteres retroiluminados (lightboxes) no herói, com
    leve curvatura 3D como um corredor de cinema.
  · Interface em liquid glass: painéis de vidro fosco com blobs de
    luz líquida derretendo por trás (backdrop-filter).
  · Efeitos semânticos: caixas de luz que "acendem" piscando,
    scanline vermelha varrendo o frame na identificação, lupa de
    vidro seguindo o cursor na tabela, lanterna no escuro, grão vivo.

  Funções: Descobrir (IA) · Identificar por print (visão) ·
           Listas personalizadas (persistência) · Pôsteres TMDB
*/

// ============================ CONFIG ============================
// As chaves NÃO ficam aqui no front — elas vivem no servidor, dentro das
// serverless functions em /api (ver pasta api/). O navegador só conversa
// com os nossos próprios endpoints:
//   POST /api/recomendar  → repassa para a Anthropic (chave no servidor)
//   GET  /api/tmdb         → repassa para o TMDB     (chave no servidor)
//
// Assim as chaves nunca aparecem no código que vai para o navegador.
//
// Deixe TMDB_ATIVO = true depois de configurar a variável de ambiente
// TMDB_API_KEY na Vercel (Settings → Environment Variables). Se deixar
// false, o app funciona normal — só mostra caixas de luz decorativas no
// lugar dos pôsteres.
const TMDB_ATIVO = true;

// Parede de pôsteres do herói: quantas colunas e quantos pôsteres no total.
// (No celular, as duas colunas das pontas são escondidas para não espremer.)
const COLUNAS_PAREDE = 6;
const ITENS_PAREDE = 24;

const EXEMPLOS = [
  "Suspense psicológico que embola a cabeça",
  "Comédia leve pra ver com a família no domingo",
  "Série curta pra maratonar no fim de semana",
  "Algo emocionante baseado em história real",
];

const FRASES_DESCOBRIR = [
  "consultando o arquivo…",
  "cruzando gêneros…",
  "separando as fitas…",
  "imprimindo a seleção…",
];

const FRASES_IDENTIFICAR = [
  "varrendo o fotograma…",
  "medindo o grão…",
  "reconhecendo rostos…",
  "batendo com o arquivo…",
];

// ====================== UTILIDADES DE JSON ======================
// Extrai o JSON da resposta; se vier cortado, recupera os objetos completos
// Extrai o primeiro objeto JSON completo e balanceado de dentro de um texto,
// ignorando qualquer "lixo" antes ou depois (ex.: quando o modelo escreve um
// raciocínio ou contagem de palavras junto). Varre caractere a caractere
// respeitando strings e escapes, então para no fecha-chaves que zera o nível.
function extrairJson(texto) {
  const limpo = texto.replace(/```json|```/g, "").trim();
  const inicio = limpo.indexOf("{");
  if (inicio === -1) throw new Error("resposta sem JSON");

  // 1) Tentativa robusta: acha o objeto balanceado começando no primeiro "{".
  let nivel = 0;
  let emString = false;
  let escape = false;
  for (let i = inicio; i < limpo.length; i++) {
    const c = limpo[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { emString = !emString; continue; }
    if (emString) continue;
    if (c === "{") nivel++;
    else if (c === "}") {
      nivel--;
      if (nivel === 0) {
        const candidato = limpo.slice(inicio, i + 1);
        try { return JSON.parse(candidato); } catch (e) { break; }
      }
    }
  }

  // 2) Plano B: reaproveita objetos soltos dentro do primeiro array, montando
  // { recomendacoes: [...] } — cobre casos de JSON cortado no fim (max tokens).
  const bruto = limpo.slice(inicio);
  const abre = bruto.indexOf("[");
  if (abre === -1) throw new Error("JSON inválido na resposta");
  const objetos = [];
  nivel = 0; emString = false; escape = false;
  let inicioObj = -1;
  for (let i = abre + 1; i < bruto.length; i++) {
    const c = bruto[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { emString = !emString; continue; }
    if (emString) continue;
    if (c === "{") { if (nivel === 0) inicioObj = i; nivel++; }
    else if (c === "}") {
      nivel--;
      if (nivel === 0 && inicioObj !== -1) {
        try { objetos.push(JSON.parse(bruto.slice(inicioObj, i + 1))); } catch (e) {}
        inicioObj = -1;
      }
    } else if (c === "]" && nivel === 0) { break; }
  }
  if (objetos.length === 0) throw new Error("JSON inválido na resposta");
  return { recomendacoes: objetos };
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ========================= CHAMADA DA IA =========================
// Fala com a NOSSA function /api/recomendar, que repassa para a Anthropic
// com a chave guardada no servidor. Aceita string (texto puro) OU array de
// blocos (texto + imagem, usado na identificação por frame).
async function chamarIA(conteudo, querJson = false, esquema = null) {
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const response = await fetch("/api/recomendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: conteudo }],
          json: querJson,
          esquema,
        }),
      });
      const data = await response.json();
      if (!response.ok || data?.type === "error" || data?.error) {
        throw new Error(data?.error?.message || `HTTP ${response.status}`);
      }
      const texto = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (texto.trim()) return texto;
      throw new Error("Resposta vazia da API");
    } catch (e) {
      ultimoErro = e;
      if (tentativa < 3) await esperar(700 * tentativa);
    }
  }
  throw ultimoErro || new Error("Falha ao chamar a IA");
}

// ======================= PÔSTERES (TMDB) ========================
const posterCache = new Map();

function chaveObra(obra) {
  return `${(obra.titulo || "").trim().toLowerCase()}|${obra.ano || ""}`;
}

async function buscarPosterTMDB(obra) {
  if (!TMDB_ATIVO || !obra.titulo) return null;
  const chave = chaveObra(obra);
  if (posterCache.has(chave)) return posterCache.get(chave);
  let poster = null;
  try {
    const url =
      "/api/tmdb?rota=search/multi&language=pt-BR&include_adult=false&query=" +
      encodeURIComponent(obra.titulo);
    const resp = await fetch(url);
    const dados = await resp.json();
    let resultados = (dados.results || []).filter(
      (r) => r.media_type === "movie" || r.media_type === "tv"
    );
    if (obra.ano) {
      const proximos = resultados.filter((r) => {
        const dataLanc = r.release_date || r.first_air_date || "";
        const anoR = parseInt(dataLanc.slice(0, 4), 10);
        return anoR && Math.abs(anoR - obra.ano) <= 1;
      });
      if (proximos.length > 0) resultados = proximos;
    }
    const melhor = resultados[0];
    if (melhor && melhor.poster_path) {
      poster = "https://image.tmdb.org/t/p/w342" + melhor.poster_path;
    }
  } catch (e) {
    // Sem rede ou bloqueado pelo ambiente: segue sem pôster
  }
  posterCache.set(chave, poster);
  return poster;
}

// Tendências da semana para acender a parede do herói
async function buscarTendencias() {
  if (!TMDB_ATIVO) return [];
  try {
    // Duas páginas de tendências para encher a parede inteira
    const paginas = await Promise.all(
      [1, 2].map((p) =>
        fetch("/api/tmdb?rota=trending/all/week&language=pt-BR&page=" + p)
          .then((r) => r.json())
          .catch(() => ({ results: [] }))
      )
    );
    const juntos = paginas.flatMap((d) => d.results || []);
    return juntos
      .filter((r) => r.poster_path && (r.media_type === "movie" || r.media_type === "tv"))
      .slice(0, ITENS_PAREDE)
      .map((r) => ({
        titulo: r.title || r.name,
        ano: parseInt((r.release_date || r.first_air_date || "").slice(0, 4), 10) || null,
        tipo: r.media_type === "movie" ? "filme" : "série",
        poster: "https://image.tmdb.org/t/p/w342" + r.poster_path,
      }));
  } catch (e) {
    return [];
  }
}

// ================== PREPARO DA IMAGEM (PRINT) ===================
// Reduz para no máximo 1400px e converte para JPEG antes do envio.
async function prepararImagem(arquivo) {
  const dataUrl = await new Promise((res, rej) => {
    const leitor = new FileReader();
    leitor.onload = () => res(leitor.result);
    leitor.onerror = () => rej(new Error("Falha ao ler a imagem"));
    leitor.readAsDataURL(arquivo);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Arquivo de imagem inválido"));
    i.src = dataUrl;
  });
  const MAX = 1400;
  const escala = Math.min(1, MAX / Math.max(img.width, img.height));
  const jaLeve = escala === 1 && arquivo.type === "image/jpeg" && arquivo.size < 2.5 * 1024 * 1024;
  if (jaLeve) {
    return { data: dataUrl.split(",")[1], media_type: "image/jpeg", preview: dataUrl };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * escala));
  canvas.height = Math.max(1, Math.round(img.height * escala));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = canvas.toDataURL("image/jpeg", 0.85);
  return { data: jpeg.split(",")[1], media_type: "image/jpeg", preview: jpeg };
}

// ================= PERSISTÊNCIA DAS LISTAS ======================
//   1) window.storage  → ambiente de artifact do Claude
//   2) localStorage    → deploy próprio (Vercel etc.)
//   3) memória         → fallback dentro da sessão
const CHAVE_LISTAS = "pitaco-listas-v1";
let listasMemoria = null;

async function carregarListasSalvas() {
  if (typeof window !== "undefined" && window.storage && typeof window.storage.get === "function") {
    try {
      const r = await window.storage.get(CHAVE_LISTAS);
      if (r && r.value) return JSON.parse(r.value);
    } catch (e) {
      // Chave ainda não existe: começa vazio
    }
    return listasMemoria || [];
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const bruto = window.localStorage.getItem(CHAVE_LISTAS);
      if (bruto) return JSON.parse(bruto);
    }
  } catch (e) {}
  return listasMemoria || [];
}

async function salvarListasNoStorage(listas) {
  listasMemoria = listas;
  const json = JSON.stringify(listas);
  if (typeof window !== "undefined" && window.storage && typeof window.storage.set === "function") {
    try { await window.storage.set(CHAVE_LISTAS, json); } catch (e) {}
    return;
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(CHAVE_LISTAS, json);
    }
  } catch (e) {}
}

function novoId(prefixo) {
  return prefixo + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function mesmaObra(a, b) {
  return (
    (a.titulo || "").trim().toLowerCase() === (b.titulo || "").trim().toLowerCase() &&
    (!a.ano || !b.ano || a.ano === b.ano)
  );
}

// ============== COMPARTILHAR LISTA COMO PNG ==================
// Desenha a watchlist inteira num canvas com a identidade do Pitaco
// (fundo escuro, marca, nome gigante, grade de pôsteres) e devolve um
// Blob PNG pronto para o compartilhamento nativo ou download.

function quebrarTexto(ctx, texto, larguraMax) {
  const palavras = String(texto).split(/\s+/).filter(Boolean);
  const linhas = [];
  let atual = "";
  for (const p of palavras) {
    const teste = atual ? atual + " " + p : p;
    if (ctx.measureText(teste).width <= larguraMax || !atual) atual = teste;
    else { linhas.push(atual); atual = p; }
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [""];
}

function caminhoArredondado(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Desenha a imagem preenchendo a área (corte central, tipo object-fit: cover)
function desenharCapa(ctx, img, x, y, w, h, r) {
  ctx.save();
  caminhoArredondado(ctx, x, y, w, h, r);
  ctx.clip();
  const razaoImg = img.width / img.height;
  const razaoAlvo = w / h;
  let sw = img.width, sh = img.height, sx = 0, sy = 0;
  if (razaoImg > razaoAlvo) {
    sw = img.height * razaoAlvo;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / razaoAlvo;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}

// Carrega um pôster com CORS liberado (o CDN do TMDB permite), para o
// canvas não ficar "contaminado" e o PNG poder ser exportado.
function carregarImagem(url) {
  return new Promise((res) => {
    if (!url) return res(null);
    const im = new Image();
    im.crossOrigin = "anonymous";
    const t = setTimeout(() => res(null), 7000);
    im.onload = () => { clearTimeout(t); res(im); };
    im.onerror = () => { clearTimeout(t); res(null); };
    im.src = url;
  });
}

async function gerarImagemLista(lista, urls) {
  // Garante que as fontes da identidade estejam prontas para o canvas
  try {
    await Promise.all([
      document.fonts.load("80px 'Archivo Black'"),
      document.fonts.load("700 26px 'Archivo'"),
      document.fonts.load("20px 'Space Mono'"),
    ]);
    await document.fonts.ready;
  } catch (e) {}

  const itens = lista.itens;
  const imgs = await Promise.all(urls.map((u) => carregarImagem(u)));

  const W = 1080;
  const M = 72;                 // margem lateral
  const COLS = 3;
  const GAP = 28;
  const CW = Math.floor((W - M * 2 - GAP * (COLS - 1)) / COLS);
  const PH = Math.round(CW * 1.5);   // altura do pôster (2:3)
  const CAPH = 100;                  // legenda abaixo do pôster

  // Mede o nome da lista para saber a altura total
  const med = document.createElement("canvas").getContext("2d");
  med.font = "80px 'Archivo Black', sans-serif";
  const nomeLinhas = quebrarTexto(med, (lista.nome || "").toUpperCase(), W - M * 2).slice(0, 3);

  const topoH = 176;
  const nomeH = nomeLinhas.length * 84 + 30;
  const linhas = Math.ceil(itens.length / COLS);
  const gridH = linhas * (PH + CAPH) + Math.max(0, linhas - 1) * GAP;
  const rodH = 130;
  const H = topoH + nomeH + gridH + rodH;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Fundo escuro com respingos de luz âmbar/vermelha (as "luzes líquidas")
  ctx.fillStyle = "#0d0b09";
  ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(W * 0.2, 0, 0, W * 0.2, 0, H * 0.7);
  g.addColorStop(0, "rgba(240,146,30,0.15)");
  g.addColorStop(1, "rgba(240,146,30,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(W, H, 0, W, H, H * 0.8);
  g.addColorStop(0, "rgba(230,57,43,0.10)");
  g.addColorStop(1, "rgba(230,57,43,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Marca no topo
  ctx.fillStyle = "#e6392b";
  ctx.beginPath();
  ctx.arc(M + 8, 88, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f6f3ec";
  ctx.font = "34px 'Archivo Black', sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("P I T A C O", M + 32, 90);
  ctx.font = "19px 'Space Mono', monospace";
  ctx.fillStyle = "rgba(246,243,236,0.5)";
  ctx.textAlign = "right";
  ctx.fillText("ARQUIVO PESSOAL DE CINEMA", W - M, 90);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Rótulo da watchlist
  ctx.font = "21px 'Space Mono', monospace";
  ctx.fillStyle = "#e6392b";
  const plural = itens.length === 1 ? "TÍTULO" : "TÍTULOS";
  ctx.fillText("/// WATCHLIST \u00b7 " + itens.length + " " + plural, M, 156);

  // Nome da lista, gigante
  ctx.fillStyle = "#f6f3ec";
  ctx.font = "80px 'Archivo Black', sans-serif";
  nomeLinhas.forEach((ln, i) => ctx.fillText(ln, M, topoH + 60 + i * 84));

  // Grade de pôsteres (caixas de luz)
  const gy0 = topoH + nomeH;
  itens.forEach((item, i) => {
    const col = i % COLS;
    const lin = Math.floor(i / COLS);
    const x = M + col * (CW + GAP);
    const y = gy0 + lin * (PH + CAPH + GAP);

    // moldura
    ctx.fillStyle = "#181310";
    caminhoArredondado(ctx, x, y, CW, PH, 14);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    caminhoArredondado(ctx, x, y, CW, PH, 14);
    ctx.stroke();

    const im = imgs[i];
    if (im) {
      desenharCapa(ctx, im, x + 8, y + 8, CW - 16, PH - 16, 8);
    } else {
      // sem pôster: inicial do título, como no site
      ctx.fillStyle = "rgba(255,217,163,0.6)";
      ctx.font = "110px 'Archivo Black', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((item.titulo || "?").trim().charAt(0).toUpperCase(), x + CW / 2, y + PH / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }

    // brilho de topo da caixa de luz
    const gs = ctx.createLinearGradient(0, y, 0, y + PH * 0.34);
    gs.addColorStop(0, "rgba(255,235,200,0.14)");
    gs.addColorStop(1, "rgba(255,235,200,0)");
    ctx.fillStyle = gs;
    caminhoArredondado(ctx, x, y, CW, PH, 14);
    ctx.fill();

    // legenda: título (até 2 linhas) + ano/tipo
    ctx.font = "700 26px 'Archivo', sans-serif";
    ctx.fillStyle = "#f6f3ec";
    const todas = quebrarTexto(ctx, item.titulo || "", CW);
    const tLinhas = todas.slice(0, 2);
    if (todas.length > 2) tLinhas[1] = tLinhas[1] + "\u2026";
    tLinhas.forEach((ln, k) => ctx.fillText(ln, x, y + PH + 38 + k * 31));
    ctx.font = "17px 'Space Mono', monospace";
    ctx.fillStyle = "rgba(246,243,236,0.55)";
    const meta = [item.ano, (item.tipo || "").toUpperCase()].filter(Boolean).join(" \u00b7 ");
    if (meta) ctx.fillText(meta, x, y + PH + 38 + tLinhas.length * 31 + 6);
  });

  // Rodapé
  const ry = H - 76;
  ctx.strokeStyle = "rgba(246,243,236,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(M, ry);
  ctx.lineTo(W - M, ry);
  ctx.stroke();
  ctx.font = "18px 'Space Mono', monospace";
  ctx.fillStyle = "#e6392b";
  ctx.fillText("FEITO NO PITACO", M, ry + 44);
  ctx.fillStyle = "rgba(246,243,236,0.5)";
  ctx.textAlign = "right";
  let host = "";
  try { host = (window.location.host || "").toUpperCase(); } catch (e) {}
  ctx.fillText(host || "ARQUIVO PESSOAL DE CINEMA", W - M, ry + 44);
  ctx.textAlign = "left";

  return await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Falha ao gerar o PNG"))), "image/png")
  );
}

// ==================== COMPONENTES DE APOIO ======================

// Pôster (imagem ou letreiro com a inicial quando não há imagem)
function Poster({ obra, url, classe }) {
  const [quebrou, setQuebrou] = useState(false);
  const base = "poster " + (classe || "");
  if (url && !quebrou) {
    return (
      <img
        className={base}
        src={url}
        alt={"Pôster de " + obra.titulo}
        loading="lazy"
        onError={() => setQuebrou(true)}
      />
    );
  }
  return (
    <div className={base + " poster-vazio"} aria-hidden="true">
      <span>{(obra.titulo || "?").trim().charAt(0).toUpperCase()}</span>
    </div>
  );
}

// Texto de status que cicla frases com cursor digitando
function StatusTipando({ frases }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % frases.length), 1300);
    return () => clearInterval(t);
  }, [frases]);
  return (
    <p className="status-tipo" role="status">
      <span className="status-luz" aria-hidden="true" />
      {frases[i]}
      <span className="cursor-tipo" aria-hidden="true">▮</span>
    </p>
  );
}

// Medidor de confiança da identificação
function MedidorConfianca({ nivel }) {
  const pct = nivel === "alta" ? 92 : nivel === "baixa" ? 26 : 56;
  return (
    <div className={"medidor " + (nivel === "alta" ? "alta" : nivel === "baixa" ? "baixa" : "media")}>
      <span className="medidor-rotulo">confiança · {nivel}</span>
      <span className="medidor-trilho" aria-hidden="true">
        <i style={{ width: pct + "%" }} />
      </span>
    </div>
  );
}

// Popover "salvar em" (vidro)
function BotaoSalvar({
  obra, listas, aberto, salvo,
  onAbrir, onFechar, onAlternar, onCriar,
  nomeNova, setNomeNova,
}) {
  return (
    <div className="salvar-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        className={"botao-salvar" + (salvo ? " salvo" : "")}
        onClick={() => (aberto ? onFechar() : onAbrir())}
        aria-expanded={aberto}
      >
        {salvo ? "✓ salvo" : "+ lista"}
      </button>

      {aberto && (
        <div className="menu-salvar vidro">
          <p className="menu-titulo">salvar em</p>

          {listas.length === 0 && (
            <p className="menu-vazio">Você ainda não tem listas — crie a primeira abaixo.</p>
          )}

          {listas.map((l) => {
            const dentro = l.itens.some((i) => mesmaObra(i, obra));
            return (
              <button
                key={l.id}
                className={"menu-lista" + (dentro ? " dentro" : "")}
                onClick={() => onAlternar(l.id)}
              >
                <span className="menu-check">{dentro ? "✓" : ""}</span>
                <span className="menu-nome">{l.nome}</span>
                <span className="menu-qtd">{l.itens.length}</span>
              </button>
            );
          })}

          <div className="menu-nova">
            <input
              value={nomeNova}
              placeholder="nova lista… ex.: com amigos"
              onChange={(e) => setNomeNova(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); onCriar(); }
              }}
            />
            <button onClick={onCriar}>criar</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ======================= COMPONENTE RAIZ ========================
export default function Pitaco() {
  // --- Navegação / página ---
  const [secaoAtiva, setSecaoAtiva] = useState("descobrir");

  // --- Descobrir ---
  const [descricao, setDescricao] = useState("");
  const [tipo, setTipo] = useState("tanto faz");
  const [recs, setRecs] = useState([]);
  const [jaSugeridos, setJaSugeridos] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [erroDetalhe, setErroDetalhe] = useState("");
  const [ultimoPedido, setUltimoPedido] = useState("");
  const [linhaAberta, setLinhaAberta] = useState(null);
  const [lenteObra, setLenteObra] = useState(null);
  const entradaRef = useRef(null);
  const lenteRef = useRef(null);

  // --- Identificar ---
  const [imagem, setImagem] = useState(null); // { data, media_type, preview }
  const [arrastando, setArrastando] = useState(false);
  const [carregandoId, setCarregandoId] = useState(false);
  const [resId, setResId] = useState(null);
  const [erroId, setErroId] = useState("");
  const inputArquivoRef = useRef(null);

  // --- Listas ---
  const [listas, setListas] = useState([]);
  const [listasProntas, setListasProntas] = useState(false);
  const [nomeNovaLista, setNomeNovaLista] = useState("");
  const [confirmaApagar, setConfirmaApagar] = useState(null);
  const [compartilhando, setCompartilhando] = useState(null);      // id da lista gerando PNG
  const [avisoCompartilhar, setAvisoCompartilhar] = useState(null); // { id, msg }

  // --- Popover "salvar em" ---
  const [menuSalvar, setMenuSalvar] = useState(null);
  const [nomeListaMenu, setNomeListaMenu] = useState("");

  // --- Pôsteres e parede ---
  const [posters, setPosters] = useState({});
  const [tendencias, setTendencias] = useState([]);

  const temPonteiroFino = useMemo(
    () => typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: fine)").matches,
    []
  );

  // Parede do herói: preenche os espaços (tendências ou caixas decorativas)
  const colunas = useMemo(() => {
    const base = tendencias.slice(0, ITENS_PAREDE);
    while (base.length < ITENS_PAREDE) base.push(null);
    const cols = Array.from({ length: COLUNAS_PAREDE }, () => []);
    base.forEach((obra, idx) => cols[idx % COLUNAS_PAREDE].push({ obra, idx }));
    return cols;
  }, [tendencias]);

  // ------------------------ EFEITOS ----------------------------
  // Listas salvas
  useEffect(() => {
    let ativo = true;
    (async () => {
      const salvas = await carregarListasSalvas();
      if (ativo) {
        setListas(Array.isArray(salvas) ? salvas : []);
        setListasProntas(true);
      }
    })();
    return () => { ativo = false; };
  }, []);

  useEffect(() => {
    if (listasProntas) salvarListasNoStorage(listas);
  }, [listas, listasProntas]);

  // Tendências para acender a parede
  useEffect(() => {
    let ativo = true;
    (async () => {
      const t = await buscarTendencias();
      if (ativo && t.length) setTendencias(t);
    })();
    return () => { ativo = false; };
  }, []);

  // Pôsteres pendentes (recomendações, identificação e listas)
  useEffect(() => {
    if (!TMDB_ATIVO) return;
    const alvo = [...recs];
    if (resId) {
      if (resId.encontrado) alvo.push(resId);
      (resId.alternativas || []).forEach((a) => alvo.push(a));
    }
    listas.forEach((l) => l.itens.forEach((i) => alvo.push(i)));

    const vistos = new Set();
    const pendentes = [];
    for (const obra of alvo) {
      if (!obra || !obra.titulo) continue;
      const c = chaveObra(obra);
      if (vistos.has(c) || posters[c] !== undefined) continue;
      vistos.add(c);
      pendentes.push(obra);
    }
    if (pendentes.length === 0) return;

    let ativo = true;
    (async () => {
      for (const obra of pendentes) {
        const url = await buscarPosterTMDB(obra);
        if (!ativo) return;
        const c = chaveObra(obra);
        setPosters((prev) => (prev[c] !== undefined ? prev : { ...prev, [c]: url }));
      }
    })();
    return () => { ativo = false; };
  }, [recs, resId, listas, posters]);

  // Colar um print em qualquer lugar da página → vai para Identificar
  useEffect(() => {
    function aoColar(e) {
      const itens = e.clipboardData && e.clipboardData.items;
      if (!itens) return;
      for (const it of itens) {
        if (it.type && it.type.startsWith("image/")) {
          const arq = it.getAsFile();
          if (arq) {
            e.preventDefault();
            receberArquivo(arq);
            irPara("identificar");
          }
          return;
        }
      }
    }
    document.addEventListener("paste", aoColar);
    return () => document.removeEventListener("paste", aoColar);
  }, []);

  // Fecha o popover "salvar em" ao clicar fora
  useEffect(() => {
    if (!menuSalvar) return;
    function fechar() { setMenuSalvar(null); setNomeListaMenu(""); }
    document.addEventListener("click", fechar);
    return () => document.removeEventListener("click", fechar);
  }, [menuSalvar]);

  // Revelação ao rolar (elementos com data-revelar).
  // Usamos um ATRIBUTO (data-visivel) em vez de classe: o React reescreve o
  // className de elementos com classe dinâmica (ex.: as linhas da tabela ao
  // abrir/fechar), o que apagava a classe adicionada por fora e fazia as
  // linhas sumirem. Atributos de dados o React não toca.
  useEffect(() => {
    const els = document.querySelectorAll("[data-revelar]:not([data-visivel])");
    if (!els.length) return;
    const obs = new IntersectionObserver(
      (entradas) => {
        entradas.forEach((en) => {
          if (en.isIntersecting) {
            en.target.setAttribute("data-visivel", "1");
            obs.unobserve(en.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [recs, resId, listas, carregando, carregandoId, tendencias, imagem]);

  // Scrollspy do menu de vidro
  useEffect(() => {
    const secs = ["descobrir", "identificar", "listas"]
      .map((id) => document.getElementById("secao-" + id))
      .filter(Boolean);
    if (!secs.length) return;
    const obs = new IntersectionObserver(
      (entradas) => {
        entradas.forEach((en) => {
          if (en.isIntersecting) setSecaoAtiva(en.target.dataset.sec);
        });
      },
      { rootMargin: "-40% 0px -55% 0px" }
    );
    secs.forEach((s) => obs.observe(s));
    return () => obs.disconnect();
  }, []);

  // Lanterna que segue o cursor + parallax da parede
  useEffect(() => {
    let rafLuz = 0;
    let rafRol = 0;
    const raiz = document.documentElement;
    function aoMover(e) {
      cancelAnimationFrame(rafLuz);
      rafLuz = requestAnimationFrame(() => {
        raiz.style.setProperty("--lx", e.clientX + "px");
        raiz.style.setProperty("--ly", e.clientY + "px");
      });
    }
    function aoRolar() {
      cancelAnimationFrame(rafRol);
      rafRol = requestAnimationFrame(() => {
        raiz.style.setProperty("--rol", String(window.scrollY || 0));
      });
    }
    window.addEventListener("mousemove", aoMover);
    window.addEventListener("scroll", aoRolar, { passive: true });
    aoRolar();
    return () => {
      window.removeEventListener("mousemove", aoMover);
      window.removeEventListener("scroll", aoRolar);
      cancelAnimationFrame(rafLuz);
      cancelAnimationFrame(rafRol);
    };
  }, []);

  // ----------------------- NAVEGAÇÃO ---------------------------
  function irPara(id) {
    const alvo = document.getElementById("secao-" + id);
    if (alvo) alvo.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const idxSecao = { descobrir: 0, identificar: 1, listas: 2 }[secaoAtiva] ?? 0;

  function usarTendencia(obra) {
    setDescricao("algo no clima de " + obra.titulo);
    irPara("descobrir");
    setTimeout(() => entradaRef.current && entradaRef.current.focus(), 450);
  }

  // Lupa de vidro que acompanha o cursor sobre a tabela
  function moverLente(e) {
    if (!lenteRef.current) return;
    lenteRef.current.style.transform =
      "translate(" + (e.clientX + 22) + "px, " + (e.clientY - 150) + "px)";
  }

  // ------------------------- DESCOBRIR -------------------------
  async function buscar(maisDoMesmo = false) {
    const pedido = maisDoMesmo ? ultimoPedido : descricao.trim();
    if (!pedido) {
      setErro("Descreva o que você está a fim de assistir para receber sugestões.");
      return;
    }
    setErro("");
    setErroDetalhe("");
    setCarregando(true);
    if (!maisDoMesmo) {
      setRecs([]);
      setJaSugeridos([]);
      setLinhaAberta(null);
    }

    const filtroTipo =
      tipo === "filme"
        ? "Recomende APENAS filmes."
        : tipo === "série"
        ? "Recomende APENAS séries."
        : "Pode recomendar filmes e séries, o que combinar melhor.";

    const excluidos =
      (maisDoMesmo ? jaSugeridos : []).length > 0
        ? `\nNÃO repita estes títulos já sugeridos: ${jaSugeridos.join(", ")}.`
        : "";

    const prompt = `Você é um curador de cinema e séries recomendando para uma pessoa no Brasil.

Pedido da pessoa: "${pedido}"
${filtroTipo}${excluidos}

Dê exatamente 4 recomendações variadas entre si. Use o título pelo qual a obra é conhecida no Brasil. Seja muito conciso: "sinopse" e "porque" com no máximo 15 palavras cada.

Responda SOMENTE com JSON válido, sem markdown, sem crase, sem nenhum texto antes ou depois, exatamente neste formato:
{"recomendacoes":[{"titulo":"...","ano":2014,"tipo":"filme ou série","generos":["...","..."],"sinopse":"frase curta, sem spoiler","porque":"por que combina com o pedido"}]}`;

    try {
      const texto = await chamarIA(prompt, true, "recomendacoes");

      let parsed;
      try {
        parsed = extrairJson(texto);
      } catch (eParse) {
        throw new Error("Formato inesperado: " + texto.slice(0, 140));
      }
      const novas = Array.isArray(parsed.recomendacoes) ? parsed.recomendacoes : [];

      if (novas.length === 0) throw new Error("Lista de recomendações veio vazia");

      setRecs((prev) => (maisDoMesmo ? [...prev, ...novas] : novas));
      setJaSugeridos((prev) => [...prev, ...novas.map((r) => r.titulo)]);
      setUltimoPedido(pedido);
    } catch (e) {
      console.error(e);
      setErro("Não consegui montar as sugestões agora. Tente de novo em alguns segundos.");
      setErroDetalhe(String(e && e.message ? e.message : e).slice(0, 300));
    } finally {
      setCarregando(false);
    }
  }

  // ------------------------ IDENTIFICAR ------------------------
  async function receberArquivo(arquivo) {
    if (!arquivo) return;
    if (!arquivo.type || !arquivo.type.startsWith("image/")) {
      setErroId("Esse arquivo não parece ser uma imagem. Envie um print em JPG ou PNG.");
      return;
    }
    setErroId("");
    setResId(null);
    try {
      const prep = await prepararImagem(arquivo);
      setImagem(prep);
    } catch (e) {
      console.error(e);
      setErroId("Não consegui ler essa imagem. Tente um print em JPG ou PNG.");
    }
  }

  async function identificar() {
    if (!imagem) {
      setErroId("Escolha ou cole um print do filme ou série primeiro.");
      return;
    }
    setErroId("");
    setResId(null);
    setCarregandoId(true);

    const prompt = `Você é um especialista em cinema e séries com memória enciclopédica de cenas, elencos e fotografia.
Analise a imagem (um frame, print de tela ou foto de um filme ou série) e identifique de qual obra ela é.

Use pistas como: atores reconhecíveis, cenário, figurino, época, estilo de fotografia, texto ou legendas visíveis, interface de streaming aparecendo no print.

Responda SOMENTE com JSON válido, sem markdown, sem crase, sem nenhum texto antes ou depois, exatamente neste formato:
{"encontrado":true,"titulo":"título pelo qual a obra é conhecida no Brasil","titulo_original":"título original","ano":2010,"tipo":"filme ou série","generos":["...","..."],"confianca":"alta, média ou baixa","pistas":"o que na imagem indica essa obra, em até 20 palavras","alternativas":[{"titulo":"...","ano":2000,"tipo":"filme ou série"}]}

Regras:
- "alternativas": no máximo 2, somente se houver dúvida real entre obras parecidas; senão use [].
- Se não conseguir identificar, responda: {"encontrado":false,"pistas":"o que dá para ver na imagem, em até 20 palavras","alternativas":[até 3 palpites prováveis]}`;

    try {
      const texto = await chamarIA([
        {
          type: "image",
          source: { type: "base64", media_type: imagem.media_type, data: imagem.data },
        },
        { type: "text", text: prompt },
      ], true, "identificar");

      let parsed;
      try {
        parsed = extrairJson(texto);
      } catch (eParse) {
        throw new Error("Formato inesperado: " + texto.slice(0, 140));
      }
      if (typeof parsed.encontrado === "undefined") parsed.encontrado = Boolean(parsed.titulo);
      parsed.alternativas = Array.isArray(parsed.alternativas)
        ? parsed.alternativas.filter((a) => a && a.titulo)
        : [];
      setResId(parsed);
    } catch (e) {
      console.error(e);
      setErroId("Não consegui analisar a imagem agora. Tente de novo em alguns segundos.");
    } finally {
      setCarregandoId(false);
    }
  }

  function limparImagem() {
    setImagem(null);
    setResId(null);
    setErroId("");
    if (inputArquivoRef.current) inputArquivoRef.current.value = "";
  }

  // ------------------------- LISTAS ----------------------------
  function paraItem(obra) {
    return {
      id: novoId("item"),
      titulo: obra.titulo,
      ano: obra.ano || null,
      tipo: obra.tipo || "",
      generos: Array.isArray(obra.generos) ? obra.generos.slice(0, 3) : [],
    };
  }

  function criarLista(nome, obraInicial) {
    const limpo = (nome || "").trim();
    if (!limpo) return null;
    const nova = { id: novoId("lista"), nome: limpo, itens: [] };
    if (obraInicial) nova.itens.push(paraItem(obraInicial));
    setListas((prev) => [...prev, nova]);
    return nova.id;
  }

  function alternarNaLista(listaId, obra) {
    setListas((prev) =>
      prev.map((l) => {
        if (l.id !== listaId) return l;
        const existente = l.itens.find((i) => mesmaObra(i, obra));
        return existente
          ? { ...l, itens: l.itens.filter((i) => i.id !== existente.id) }
          : { ...l, itens: [...l.itens, paraItem(obra)] };
      })
    );
  }

  function removerItem(listaId, itemId) {
    setListas((prev) =>
      prev.map((l) =>
        l.id === listaId ? { ...l, itens: l.itens.filter((i) => i.id !== itemId) } : l
      )
    );
  }

  function apagarLista(listaId) {
    setListas((prev) => prev.filter((l) => l.id !== listaId));
    setConfirmaApagar(null);
  }

  function mostrarAvisoLista(id, msg) {
    setAvisoCompartilhar({ id, msg });
    setTimeout(
      () => setAvisoCompartilhar((a) => (a && a.id === id ? null : a)),
      2600
    );
  }

  // Gera o PNG da watchlist e abre a folha de compartilhamento nativa
  // (celular). Onde não dá para compartilhar arquivo, baixa o PNG.
  async function compartilharLista(lista) {
    if (compartilhando || !lista.itens.length) return;
    setCompartilhando(lista.id);
    try {
      // Garante o pôster de cada item (usa o cache; busca só o que faltar)
      const urls = await Promise.all(
        lista.itens.map(async (item) => {
          const c = chaveObra(item);
          if (posters[c] !== undefined) return posters[c];
          return await buscarPosterTMDB(item);
        })
      );

      const blob = await gerarImagemLista(lista, urls);
      const nomeArq =
        "pitaco-" +
        (lista.nome || "lista")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") +
        ".png";
      const arquivo = new File([blob], nomeArq, { type: "image/png" });

      if (
        typeof navigator !== "undefined" &&
        navigator.canShare &&
        navigator.canShare({ files: [arquivo] })
      ) {
        await navigator.share({
          files: [arquivo],
          title: "Watchlist no Pitaco",
          text: 'Minha lista "' + lista.nome + '" no Pitaco \uD83C\uDFAC',
        });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = nomeArq;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        mostrarAvisoLista(lista.id, "png baixado \u2713");
      }
    } catch (e) {
      if (e && e.name === "AbortError") {
        // pessoa fechou a folha de compartilhamento — tudo bem
      } else {
        console.error(e);
        mostrarAvisoLista(lista.id, "n\u00e3o deu \u2014 tente de novo");
      }
    } finally {
      setCompartilhando(null);
    }
  }

  function obraSalva(obra) {
    return listas.some((l) => l.itens.some((i) => mesmaObra(i, obra)));
  }

  const totalSalvos = listas.reduce((soma, l) => soma + l.itens.length, 0);

  function propsSalvar(chaveCard, obra) {
    return {
      obra,
      listas,
      aberto: menuSalvar === chaveCard,
      salvo: obraSalva(obra),
      onAbrir: () => { setMenuSalvar(chaveCard); setNomeListaMenu(""); },
      onFechar: () => { setMenuSalvar(null); setNomeListaMenu(""); },
      onAlternar: (listaId) => alternarNaLista(listaId, obra),
      onCriar: () => {
        const id = criarLista(nomeListaMenu, obra);
        if (id) setNomeListaMenu("");
      },
      nomeNova: nomeListaMenu,
      setNomeNova: setNomeListaMenu,
    };
  }

  const ITENS_TICKER = [
    "descobrir novos filmes",
    "identificar qualquer frame",
    "listas do seu jeito",
    "curadoria por ia",
    "arquivo pessoal de cinema",
  ];
  function fita(prefixo) {
    return ITENS_TICKER.map((t, i) => (
      <span key={prefixo + i}>
        {t}
        <i aria-hidden="true">✦</i>
      </span>
    ));
  }

  // =========================== RENDER ==========================
  return (
    <div className="raiz">
      <style>{css}</style>

      {/* luz líquida derretendo atrás dos painéis de vidro */}
      <div className="liquido" aria-hidden="true">
        <i className="blob b1" />
        <i className="blob b2" />
        <i className="blob b3" />
      </div>

      {/* lanterna que segue o cursor no escuro */}
      <div className="lanterna" aria-hidden="true" />

      {/* menu flutuante de vidro */}
      <nav className="navega vidro" aria-label="Seções">
        <button className="nav-marca" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          pitaco<i aria-hidden="true" />
        </button>
        <div className="nav-links">
          <span
            className="nav-indicador"
            style={{ transform: "translateX(" + idxSecao * 100 + "%)" }}
            aria-hidden="true"
          />
          {[
            ["descobrir", "descobrir"],
            ["identificar", "identificar"],
            ["listas", "listas"],
          ].map(([id, rotulo]) => (
            <button
              key={id}
              className={"nav-item" + (secaoAtiva === id ? " ativo" : "")}
              onClick={() => irPara(id)}
            >
              {rotulo}
              {id === "listas" && totalSalvos > 0 && <em>{totalSalvos}</em>}
            </button>
          ))}
        </div>
      </nav>

      {/* ========================= HERÓI ========================= */}
      <header className="heroi">
        <div className="parede-wrap" aria-hidden="true">
          <div className="parede">
            {colunas.map((col, c) => (
              <div key={c} className={"coluna col-" + c}>
                {col.map(({ obra, idx }) =>
                  obra ? (
                    <button
                      key={idx}
                      className="caixa acesa"
                      style={{ animationDelay: 0.2 + idx * 0.06 + "s" }}
                      onClick={() => usarTendencia(obra)}
                      title={"pedir algo no clima de " + obra.titulo}
                      tabIndex={-1}
                    >
                      <img src={obra.poster} alt="" loading="lazy" />
                    </button>
                  ) : (
                    <div
                      key={idx}
                      className="caixa acesa caixa-vazia"
                      style={{ animationDelay: 0.2 + idx * 0.06 + "s" }}
                    >
                      <span className="cv-num">{String(idx + 1).padStart(3, "0")}</span>
                      <span className="cv-rot">arquivo</span>
                    </div>
                  )
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="heroi-veu" aria-hidden="true" />

        <div className="heroi-conteudo">
          <p className="heroi-olho" data-revelar>
            arquivo pessoal de cinema · curadoria por ia
          </p>
          <h1 className="marco" aria-label="PITACO">
            {"PITACO".split("").map((l, i) => (
              <span className="letra" key={i}>
                <span style={{ animationDelay: 0.85 + i * 0.07 + "s" }}>{l}</span>
              </span>
            ))}
          </h1>
          <p className="heroi-sub">
            Descreva um clima, cole um frame, guarde tudo em prateleiras do seu jeito.
          </p>
          <div className="heroi-acoes">
            <button className="botao-cheio" onClick={() => irPara("descobrir")}>
              pedir pitacos ↓
            </button>
            <button className="botao-vidro" onClick={() => irPara("identificar")}>
              identificar um frame
            </button>
          </div>
        </div>
      </header>

      <div className="ticker" aria-hidden="true">
        <div className="ticker-fita">
          {fita("a")}
          {fita("b")}
        </div>
      </div>

      {/* ====================== 01 DESCOBRIR ===================== */}
      <section className="secao" id="secao-descobrir" data-sec="descobrir">
        <div className="molde">
          <header className="secao-cabeca" data-revelar>
            <span className="secao-num">01</span>
            <h2 className="secao-titulo">Descobrir</h2>
            <p className="secao-desc">Fale o clima — a IA puxa quatro fitas do arquivo.</p>
          </header>

          <div className="console vidro" data-revelar>
            <textarea
              ref={entradaRef}
              className="entrada"
              rows={3}
              value={descricao}
              placeholder="Descreva o clima, uma referência, com quem vai assistir… ex.: “algo tipo Interestelar, mas mais leve”"
              onChange={(e) => setDescricao(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!carregando) buscar(false);
                }
              }}
            />
            <div className="console-linha">
              <div className="tipos" role="group" aria-label="Tipo de obra">
                {["filme", "série", "tanto faz"].map((t) => (
                  <button
                    key={t}
                    className={"pill" + (tipo === t ? " ativo" : "")}
                    onClick={() => setTipo(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <button
                className="botao-cheio"
                onClick={() => buscar(false)}
                disabled={carregando}
              >
                {carregando ? "consultando…" : "pedir pitacos"}
              </button>
            </div>
          </div>

          {recs.length === 0 && !carregando && (
            <div className="exemplos" data-revelar>
              <span className="exemplos-rotulo">sem ideia? →</span>
              {EXEMPLOS.map((ex) => (
                <button
                  key={ex}
                  className="chip-vidro"
                  onClick={() => {
                    setDescricao(ex);
                    entradaRef.current && entradaRef.current.focus();
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
          )}

          {erro && (
            <div className="erro">
              <p>{erro}</p>
              {erroDetalhe && <p className="erro-detalhe">detalhe técnico: {erroDetalhe}</p>}
            </div>
          )}

          {carregando && (
            <div className="carregando">
              <div className="esqueleto" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <i key={i} style={{ animationDelay: i * 0.13 + "s" }} />
                ))}
              </div>
              <StatusTipando frases={FRASES_DESCOBRIR} />
            </div>
          )}
        </div>

        {recs.length > 0 && (
          <div className="papel">
            <div className="sprockets" aria-hidden="true" />
            <div className="molde">
              <header className="papel-cabeca" data-revelar>
                <h3 className="papel-titulo">
                  Seleções
                  <br />
                  da sessão
                </h3>
                <p className="papel-nota">
                  {recs.length} títulos · toque numa linha para abrir a ficha
                  {temPonteiroFino ? " · passe o mouse para espiar o pôster" : ""}
                </p>
              </header>

              <div
                className="tabela-wrap"
                onMouseMove={temPonteiroFino ? moverLente : undefined}
                onMouseLeave={() => setLenteObra(null)}
              >
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>nº</th>
                      <th>título</th>
                      <th className="col-ano">ano</th>
                      <th className="col-tipo">tipo</th>
                      <th className="col-gen">gênero</th>
                    </tr>
                  </thead>
                  {recs.map((r, i) => (
                    <tbody key={r.titulo + i}>
                      <tr
                        className={"linha" + (linhaAberta === i ? " aberta" : "")}
                        data-revelar
                        style={{ transitionDelay: (i % 6) * 0.05 + "s" }}
                        onMouseEnter={() => setLenteObra(r)}
                        onClick={() => setLinhaAberta(linhaAberta === i ? null : i)}
                      >
                        <td className="td-num">{String(i + 1).padStart(2, "0")}</td>
                        <td className="td-titulo">
                          {r.titulo}
                          <span className="td-seta" aria-hidden="true">
                            {linhaAberta === i ? "–" : "+"}
                          </span>
                        </td>
                        <td className="td-mono col-ano">{r.ano || "—"}</td>
                        <td className="td-mono col-tipo">{r.tipo || "—"}</td>
                        <td className="td-mono col-gen">
                          {(r.generos || []).slice(0, 2).join(" · ") || "—"}
                        </td>
                      </tr>
                      <tr className="linha-detalhe">
                        <td colSpan={5}>
                          <div className={"ficha" + (linhaAberta === i ? " aberta" : "")}>
                            <div className="ficha-grade">
                              <Poster obra={r} url={posters[chaveObra(r)]} classe="ficha-poster" />
                              <div className="ficha-texto">
                                <p className="ficha-meta">
                                  {[
                                    r.ano,
                                    (r.tipo || "").toUpperCase(),
                                    (r.generos || []).slice(0, 3).join(" · ").toUpperCase(),
                                  ]
                                    .filter(Boolean)
                                    .join("  ·  ")}
                                </p>
                                <p className="ficha-sinopse">{r.sinopse}</p>
                                <p className="ficha-porque">
                                  <span>por que combina</span> {r.porque}
                                </p>
                                <BotaoSalvar {...propsSalvar("rec-" + i, r)} />
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  ))}
                </table>
              </div>

              <button
                className="botao-tinta"
                onClick={() => buscar(true)}
                disabled={carregando}
              >
                {carregando ? "consultando…" : "+ mais sugestões"}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ===================== 02 IDENTIFICAR ==================== */}
      <section className="secao" id="secao-identificar" data-sec="identificar">
        <div className="faixa-ambar">
          <div className="molde">
            <header className="faixa-cabeca" data-revelar>
              <span className="secao-num escuro">02</span>
              <h2 className="faixa-titulo">
                Sintonize
                <br />o frame
              </h2>
              <p className="faixa-desc">
                Solte um print de filme ou série — a IA descobre de onde é.
              </p>
            </header>

            <div
              className={
                "zona" + (arrastando ? " arrastando" : "") + (imagem ? " com-imagem" : "")
              }
              onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
              onDragLeave={() => setArrastando(false)}
              onDrop={(e) => {
                e.preventDefault();
                setArrastando(false);
                receberArquivo(e.dataTransfer.files && e.dataTransfer.files[0]);
              }}
              onClick={() => inputArquivoRef.current && inputArquivoRef.current.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputArquivoRef.current && inputArquivoRef.current.click();
                }
              }}
              aria-label="Enviar print do filme ou série"
              data-revelar
            >
              {imagem ? (
                <div className={"quadro" + (carregandoId ? " escaneando" : "")}>
                  <img className="quadro-img" src={imagem.preview} alt="Frame enviado" />
                  <i className="mira m1" aria-hidden="true" />
                  <i className="mira m2" aria-hidden="true" />
                  <i className="mira m3" aria-hidden="true" />
                  <i className="mira m4" aria-hidden="true" />
                  <i className="scan" aria-hidden="true" />
                </div>
              ) : (
                <>
                  <span className="zona-frase">solte o print aqui</span>
                  <span className="zona-dica">clique · arraste · ou cole com ctrl+v</span>
                </>
              )}
            </div>
            <input
              ref={inputArquivoRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                receberArquivo(e.target.files && e.target.files[0]);
                e.target.value = "";
              }}
            />

            {imagem && (
              <div className="zona-acoes">
                <button className="botao-tinta fantasma" onClick={limparImagem}>
                  trocar imagem
                </button>
                <button
                  className="botao-tinta"
                  onClick={identificar}
                  disabled={carregandoId}
                >
                  {carregandoId ? "analisando…" : "identificar frame"}
                </button>
              </div>
            )}

            {carregandoId && (
              <div className="status-escuro">
                <StatusTipando frases={FRASES_IDENTIFICAR} />
              </div>
            )}

            {erroId && (
              <div className="erro na-faixa">
                <p>{erroId}</p>
              </div>
            )}
          </div>
        </div>

        {resId && !carregandoId && (
          <div className="molde resultado-area">
            {resId.encontrado ? (
              <div className="achado" data-revelar>
                <span className="achado-carimbo" aria-hidden="true">achei!</span>
                <div className="achado-grade">
                  <figure className="caixa grande acesa">
                    <Poster obra={resId} url={posters[chaveObra(resId)]} classe="caixa-img" />
                  </figure>
                  <div className="achado-info vidro">
                    <p className="info-meta">
                      {[
                        resId.ano,
                        (resId.tipo || "").toUpperCase(),
                        (resId.generos || []).slice(0, 2).join(" · ").toUpperCase(),
                      ]
                        .filter(Boolean)
                        .join("  ·  ")}
                    </p>
                    <h3 className="info-titulo">{resId.titulo}</h3>
                    {resId.titulo_original && resId.titulo_original !== resId.titulo && (
                      <p className="info-original">{resId.titulo_original}</p>
                    )}
                    {resId.confianca && <MedidorConfianca nivel={resId.confianca} />}
                    {resId.pistas && (
                      <p className="info-pistas">
                        <span>como identifiquei</span> {resId.pistas}
                      </p>
                    )}
                    <div className="info-acoes">
                      <BotaoSalvar {...propsSalvar("resid", resId)} />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="nao-achado vidro" data-revelar>
                <p className="nao-titulo">não bati o martelo…</p>
                <p className="nao-texto">
                  {resId.pistas
                    ? "O que dá para ver: " + resId.pistas
                    : "A imagem não trouxe pistas suficientes."}
                </p>
              </div>
            )}

            {resId.alternativas && resId.alternativas.length > 0 && (
              <div className="alternativas" data-revelar>
                <p className="alt-rotulo">
                  {resId.encontrado ? "também pode ser" : "meus palpites"}
                </p>
                <div className="alt-grade">
                  {resId.alternativas.map((alt, i) => (
                    <div className="alt-item" key={alt.titulo + i}>
                      <figure
                        className="caixa mini acesa"
                        style={{ animationDelay: i * 0.12 + "s" }}
                      >
                        <Poster obra={alt} url={posters[chaveObra(alt)]} classe="caixa-img" />
                      </figure>
                      <div className="alt-info">
                        <p className="alt-meta">
                          {[alt.ano, (alt.tipo || "").toUpperCase()]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        <p className="alt-titulo">{alt.titulo}</p>
                        <BotaoSalvar {...propsSalvar("alt-" + i, alt)} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ====================== 03 SUAS LISTAS =================== */}
      <section className="secao" id="secao-listas" data-sec="listas">
        <div className="molde">
          <header className="secao-cabeca" data-revelar>
            <span className="secao-num">03</span>
            <h2 className="secao-titulo">Suas listas</h2>
            <p className="secao-desc">
              {totalSalvos === 0
                ? "Prateleiras do seu jeito — comece criando uma."
                : "Prateleiras do seu jeito — " + totalSalvos + " títulos guardados."}
            </p>
          </header>

          <div className="console vidro nova-lista" data-revelar>
            <input
              className="entrada-lista"
              value={nomeNovaLista}
              placeholder="nome da nova lista — ex.: assistir com amigos"
              onChange={(e) => setNomeNovaLista(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (criarLista(nomeNovaLista)) setNomeNovaLista("");
                }
              }}
            />
            <button
              className="botao-cheio"
              onClick={() => {
                if (criarLista(nomeNovaLista)) setNomeNovaLista("");
              }}
            >
              criar lista
            </button>
          </div>

          {listas.length === 0 ? (
            <div className="arquivo-vazio" data-revelar>
              <p className="av-num" aria-hidden="true">000</p>
              <p className="av-texto">
                arquivo vazio — salve títulos pelo botão “+ lista” nas seções 01 e 02
              </p>
            </div>
          ) : (
            listas.map((l, li) => (
              <article
                className="prateleira"
                key={l.id}
                data-revelar
                style={{ transitionDelay: li * 0.06 + "s" }}
              >
                <header className="prat-cabeca">
                  <span className="prat-marca" aria-hidden="true">///</span>
                  <h3 className="prat-nome">{l.nome}</h3>
                  <span className="prat-qtd">
                    {l.itens.length} {l.itens.length === 1 ? "título" : "títulos"}
                  </span>
                  <div className="prat-acoes">
                    {l.itens.length > 0 && (
                      <button
                        className="prat-compartilhar"
                        onClick={() => compartilharLista(l)}
                        disabled={compartilhando !== null}
                      >
                        {compartilhando === l.id
                          ? "gerando png…"
                          : avisoCompartilhar && avisoCompartilhar.id === l.id
                          ? avisoCompartilhar.msg
                          : "compartilhar"}
                      </button>
                    )}
                    <button
                      className="prat-apagar"
                      onClick={() => {
                        if (confirmaApagar === l.id) {
                          apagarLista(l.id);
                        } else {
                          setConfirmaApagar(l.id);
                          setTimeout(
                            () => setConfirmaApagar((c) => (c === l.id ? null : c)),
                            3000
                          );
                        }
                      }}
                    >
                      {confirmaApagar === l.id ? "apagar mesmo?" : "apagar"}
                    </button>
                  </div>
                </header>

                {l.itens.length === 0 ? (
                  <p className="prat-vazia">
                    prateleira vazia — use “+ lista” num título para guardar aqui.
                  </p>
                ) : (
                  <div className="prat-grade">
                    {l.itens.map((item, ii) => (
                      <figure
                        className="caixa mini acesa prat-item"
                        key={item.id}
                        style={{ animationDelay: (ii % 8) * 0.06 + "s" }}
                      >
                        <Poster obra={item} url={posters[chaveObra(item)]} classe="caixa-img" />
                        <figcaption>
                          <span className="pi-titulo">{item.titulo}</span>
                          <span className="pi-meta">
                            {[item.ano, item.tipo].filter(Boolean).join(" · ")}
                          </span>
                        </figcaption>
                        <button
                          className="pi-remover"
                          aria-label={"Remover " + item.titulo + " da lista"}
                          onClick={() => removerItem(l.id, item.id)}
                        >
                          ×
                        </button>
                      </figure>
                    ))}
                  </div>
                )}
              </article>
            ))
          )}
        </div>
      </section>

      {/* ========================= RODAPÉ ======================== */}
      <footer className="rodape">
        <div className="molde rodape-linhas">
          <p>sugestões e identificação geradas por ia — confira a disponibilidade no seu streaming.</p>
          {TMDB_ATIVO && (
            <p>
              pôsteres via tmdb · este produto usa a api do tmdb mas não é endossado nem
              certificado pelo tmdb.
            </p>
          )}
        </div>
        <p className="rodape-marca" aria-hidden="true">pitaco</p>
      </footer>

      {/* lupa de vidro sobre a tabela */}
      {lenteObra && temPonteiroFino && (
        <div className="lente vidro" ref={lenteRef} aria-hidden="true">
          <Poster obra={lenteObra} url={posters[chaveObra(lenteObra)]} classe="lente-poster" />
          <p className="lente-titulo">{lenteObra.titulo}</p>
        </div>
      )}

      {/* grão de filme por cima de tudo */}
      <div className="graos" aria-hidden="true" />
    </div>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Archivo:wght@400;500;700&family=Space+Mono:wght@400;700&display=swap');

/* ============================ BASE ============================ */
html { scroll-behavior: smooth; }
html, body { margin: 0; padding: 0; background: #0d0b09; }
::selection { background: #e6392b; color: #fff; }
::-webkit-scrollbar { width: 10px; }
::-webkit-scrollbar-track { background: #0d0b09; }
::-webkit-scrollbar-thumb { background: rgba(246,243,236,0.18); border-radius: 99px; }
::-webkit-scrollbar-thumb:hover { background: rgba(246,243,236,0.3); }

.raiz {
  --preto: #0d0b09;
  --preto2: #181310;
  --papel: #efece3;
  --tinta: #17140f;
  --branco: #f6f3ec;
  --vermelho: #e6392b;
  --ambar: #f0921e;
  --luz: #ffd9a3;
  min-height: 100vh;
  background: var(--preto);
  color: var(--branco);
  font-family: 'Archivo', system-ui, sans-serif;
  font-weight: 400;
  overflow-x: hidden;
  position: relative;
}
.raiz *, .raiz *::before, .raiz *::after { box-sizing: border-box; }

.raiz button { font-family: inherit; }
.raiz button:focus-visible,
.raiz [role="button"]:focus-visible,
.raiz input:focus-visible,
.raiz textarea:focus-visible {
  outline: 2px solid var(--vermelho);
  outline-offset: 2px;
}

.molde {
  width: min(1180px, 100%);
  margin-inline: auto;
  padding-inline: clamp(20px, 5vw, 64px);
}

/* =================== LUZ LÍQUIDA (blobs) ===================== */
.liquido {
  position: fixed; inset: 0; z-index: 0;
  pointer-events: none; overflow: hidden;
  filter: blur(72px) saturate(1.25);
}
.blob {
  position: absolute; display: block;
  mix-blend-mode: screen; opacity: 0.5;
  border-radius: 46% 54% 60% 40% / 50% 44% 56% 50%;
  animation: derreter 24s ease-in-out infinite alternate;
}
.b1 { width: 46vw; height: 46vw; left: -10%; top: -12%;
  background: radial-gradient(closest-side, rgba(240,146,30,0.55), transparent 72%); }
.b2 { width: 38vw; height: 38vw; right: -12%; top: 28%;
  background: radial-gradient(closest-side, rgba(230,57,43,0.45), transparent 72%);
  animation-duration: 29s; animation-delay: -8s; }
.b3 { width: 34vw; height: 34vw; left: 20%; bottom: -14%;
  background: radial-gradient(closest-side, rgba(255,217,163,0.35), transparent 72%);
  animation-duration: 21s; animation-delay: -14s; }
@keyframes derreter {
  0%   { transform: translate(0,0) rotate(0deg) scale(1);
         border-radius: 46% 54% 60% 40% / 50% 44% 56% 50%; }
  50%  { border-radius: 58% 42% 38% 62% / 42% 60% 40% 58%; }
  100% { transform: translate(6vw,-5vh) rotate(30deg) scale(1.14);
         border-radius: 40% 60% 55% 45% / 55% 40% 60% 45%; }
}

/* lanterna que segue o cursor */
.lanterna {
  position: fixed; inset: 0; z-index: 2; pointer-events: none;
  mix-blend-mode: screen;
  background: radial-gradient(320px circle at var(--lx, 50%) var(--ly, 38%),
    rgba(255,214,160,0.07), transparent 62%);
}
@media (pointer: coarse) { .lanterna { display: none; } }

/* ====================== RECEITA DE VIDRO ===================== */
.vidro {
  position: relative;
  background: linear-gradient(140deg,
    rgba(255,255,255,0.12), rgba(255,255,255,0.03) 45%, rgba(255,255,255,0.07));
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
  backdrop-filter: blur(20px) saturate(1.5);
  border: 1px solid rgba(255,255,255,0.16);
  border-radius: 20px;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.25),
    inset 0 -1px 0 rgba(0,0,0,0.3),
    0 20px 50px rgba(0,0,0,0.45);
}

/* ====================== MENU DE VIDRO ======================== */
.navega {
  position: fixed; top: 14px; left: 50%;
  transform: translateX(-50%);
  z-index: 90;
  width: min(640px, calc(100% - 24px));
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 10px 20px;
  border-radius: 999px;
}
.nav-marca {
  font-family: 'Archivo Black', sans-serif;
  font-size: 15px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--branco);
  background: none; border: none; cursor: pointer;
  display: inline-flex; align-items: center; gap: 9px;
  padding: 6px 0;
}
.nav-marca i {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--vermelho);
  box-shadow: 0 0 10px var(--vermelho);
  animation: pulsoLuz 2.2s ease-in-out infinite;
}
.nav-links {
  position: relative;
  display: grid; grid-template-columns: repeat(3, 1fr);
}
.nav-indicador {
  position: absolute; top: 4px; bottom: 4px; left: 0;
  width: calc(100% / 3);
  background: rgba(255,255,255,0.14);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 999px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.25);
  transition: transform 0.55s cubic-bezier(0.3, 1.5, 0.35, 1);
}
.nav-item {
  position: relative; z-index: 1;
  font-family: 'Space Mono', monospace;
  font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
  color: rgba(246,243,236,0.6);
  padding: 13px 18px;
  background: none; border: none; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  white-space: nowrap;
  transition: color 0.2s ease;
}
.nav-item:hover { color: var(--branco); }
.nav-item.ativo { color: var(--branco); }
.nav-item em {
  font-style: normal; font-size: 9px;
  background: var(--vermelho); color: #fff;
  padding: 1px 6px; border-radius: 999px;
}

/* ========================== HERÓI ============================ */
.heroi {
  position: relative; z-index: 1;
  min-height: 100svh;
  display: flex; align-items: flex-end;
  padding-bottom: clamp(40px, 7vh, 84px);
  overflow: hidden;
}
.parede-wrap {
  position: absolute; left: 0; right: 0; top: 0; height: 74%;
  perspective: 1100px; perspective-origin: 50% 28%;
  overflow: hidden;
  transform: translate3d(0, calc(var(--rol, 0) * -0.14px), 0);
  -webkit-mask-image: linear-gradient(180deg, #000 55%, transparent 97%);
  mask-image: linear-gradient(180deg, #000 55%, transparent 97%);
}
.parede {
  display: flex; justify-content: center; gap: 16px;
  padding: 44px 20px 0;
  transform-style: preserve-3d;
}
.coluna {
  flex: 1; max-width: 150px;
  display: flex; flex-direction: column; gap: 16px;
}
.col-0 { transform: rotateY(24deg) translateZ(-72px); }
.col-1 { transform: rotateY(14deg) translateZ(-28px); }
.col-2 { transform: rotateY(5deg); }
.col-3 { transform: rotateY(-5deg); }
.col-4 { transform: rotateY(-14deg) translateZ(-28px); }
.col-5 { transform: rotateY(-24deg) translateZ(-72px); }
.heroi-veu {
  position: absolute; inset: 0; z-index: 1;
  background: linear-gradient(180deg,
    rgba(13,11,9,0.3), rgba(13,11,9,0.12) 34%,
    rgba(13,11,9,0.9) 76%, var(--preto) 94%);
}
.heroi-conteudo {
  position: relative; z-index: 2;
  width: 100%;
  padding-inline: clamp(20px, 5vw, 64px);
}
.heroi-olho {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase;
  color: var(--vermelho);
  margin: 0 0 10px;
}
.marco {
  display: flex; flex-wrap: wrap;
  font-family: 'Archivo Black', sans-serif;
  font-size: clamp(72px, 17vw, 210px);
  line-height: 0.8; letter-spacing: -0.035em;
  text-transform: uppercase;
  color: var(--branco);
  margin: 0;
  text-shadow: 0 20px 60px rgba(0,0,0,0.6);
}
.letra { display: inline-block; overflow: hidden; }
.letra span {
  display: inline-block;
  transform: translateY(118%);
  animation: subirLetra 0.8s cubic-bezier(0.16, 0.84, 0.26, 1) forwards;
}
@keyframes subirLetra { to { transform: translateY(0); } }
.heroi-sub {
  font-size: clamp(15px, 1.6vw, 18px);
  color: rgba(246,243,236,0.8);
  max-width: 540px;
  margin: 20px 0 26px;
  opacity: 0; transform: translateY(14px);
  animation: surgir 0.8s ease 1.35s forwards;
}
.heroi-acoes {
  display: flex; gap: 12px; flex-wrap: wrap;
  opacity: 0; transform: translateY(14px);
  animation: surgir 0.8s ease 1.5s forwards;
}
@keyframes surgir { to { opacity: 1; transform: translateY(0); } }

/* ==================== CAIXA DE LUZ (pôster) ================== */
.caixa {
  display: block; position: relative;
  margin: 0; padding: 7px;
  background: var(--preto2);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow:
    0 0 0 1px rgba(0,0,0,0.6),
    inset 0 0 0 1px rgba(255,255,255,0.05),
    inset 0 -18px 30px rgba(0,0,0,0.35),
    inset 0 6px 22px rgba(255,205,140,0.1),
    0 0 28px rgba(255,175,90,0.12),
    0 18px 34px rgba(0,0,0,0.55);
  transition: transform 0.3s ease, filter 0.3s ease, box-shadow 0.3s ease;
}
.caixa::after {
  content: ""; position: absolute; inset: 0;
  border-radius: inherit; pointer-events: none;
  background: linear-gradient(180deg, rgba(255,235,200,0.16), rgba(255,255,255,0) 34%);
}
.caixa img, .caixa-img {
  display: block; width: 100%;
  aspect-ratio: 2 / 3; object-fit: cover;
  border-radius: 4px;
}
button.caixa { cursor: pointer; width: 100%; text-align: inherit; }
.parede .caixa:hover { filter: brightness(1.16); transform: scale(1.03); }
.acesa { animation: acender 1.1s ease both; }
@keyframes acender {
  0%       { opacity: 0; filter: brightness(0.2); }
  8%       { opacity: 1; filter: brightness(1.7); }
  13%      { opacity: 0.25; filter: brightness(0.4); }
  21%      { opacity: 1; filter: brightness(1.3); }
  29%      { opacity: 0.5; filter: brightness(0.7); }
  40%, 100% { opacity: 1; filter: brightness(1); }
}
.caixa-vazia {
  aspect-ratio: 2 / 3;
  display: grid; place-content: center; gap: 6px;
  text-align: center;
  animation: acender 1.1s ease both, vagalume 4.5s ease-in-out infinite alternate;
}
.cv-num {
  font-family: 'Space Mono', monospace; font-size: 21px;
  color: rgba(255,217,163,0.6);
}
.cv-rot {
  font-family: 'Space Mono', monospace; font-size: 9px;
  letter-spacing: 0.3em; text-transform: uppercase;
  color: rgba(255,217,163,0.35);
}
@keyframes vagalume {
  from { box-shadow: 0 0 0 1px rgba(0,0,0,0.6), inset 0 0 26px rgba(255,190,110,0.08),
         0 0 22px rgba(255,175,90,0.08), 0 18px 34px rgba(0,0,0,0.55); }
  to   { box-shadow: 0 0 0 1px rgba(0,0,0,0.6), inset 0 0 40px rgba(255,190,110,0.2),
         0 0 40px rgba(255,175,90,0.2), 0 18px 34px rgba(0,0,0,0.55); }
}
.caixa.grande { width: 100%; padding: 10px; border-radius: 12px; }
.caixa.mini { width: 96px; flex: none; padding: 5px; border-radius: 6px; }

.poster-vazio {
  display: grid; place-items: center;
  background: var(--preto2);
  color: rgba(255,217,163,0.65);
  font-family: 'Archivo Black', sans-serif;
  font-size: 34px;
}
.mini .poster-vazio { font-size: 24px; }

/* ========================== TICKER =========================== */
.ticker {
  position: relative; z-index: 1;
  border-block: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.02);
  overflow: hidden;
}
.ticker-fita { display: flex; width: max-content; animation: rolarFita 26s linear infinite; }
.ticker:hover .ticker-fita { animation-play-state: paused; }
.ticker-fita span {
  display: flex; align-items: center; gap: 26px;
  padding: 12px 13px;
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
  color: rgba(246,243,236,0.55);
  white-space: nowrap;
}
.ticker-fita i { color: var(--vermelho); font-style: normal; }
@keyframes rolarFita { to { transform: translateX(-50%); } }

/* ========================== SEÇÕES =========================== */
.secao { position: relative; z-index: 1; padding-top: clamp(80px, 12vh, 140px); }
#secao-listas { padding-bottom: clamp(80px, 12vh, 140px); }

.secao-cabeca {
  display: grid; grid-template-columns: auto 1fr;
  gap: 8px 22px; align-items: start;
  margin-bottom: 42px;
}
.secao-num {
  font-family: 'Space Mono', monospace;
  font-size: 13px; letter-spacing: 0.2em;
  color: var(--vermelho);
  border: 1px solid rgba(230,57,43,0.5);
  border-radius: 4px;
  padding: 6px 10px;
  margin-top: 8px;
}
.secao-num.escuro { color: #1c1206; border-color: rgba(28,18,6,0.55); }
.secao-titulo {
  font-family: 'Archivo Black', sans-serif;
  font-size: clamp(46px, 8vw, 110px);
  line-height: 0.85; letter-spacing: -0.03em;
  text-transform: uppercase;
  margin: 0;
}
.secao-desc {
  grid-column: 2;
  font-size: 15px; color: rgba(246,243,236,0.65);
  max-width: 560px; margin: 14px 0 0;
}

/* ================== CONSOLE DE VIDRO (inputs) ================ */
.console { padding: 18px; border-radius: 24px; margin-bottom: 22px; }
.entrada {
  width: 100%;
  background: transparent; border: none; resize: none;
  color: var(--branco);
  font: inherit; font-size: 16.5px; line-height: 1.55;
  outline: none;
}
.entrada::placeholder { color: rgba(246,243,236,0.42); }
.console-linha {
  display: flex; flex-wrap: wrap; gap: 12px;
  justify-content: space-between; align-items: center;
  border-top: 1px dashed rgba(255,255,255,0.16);
  margin-top: 12px; padding-top: 14px;
}
.tipos { display: flex; gap: 6px; flex-wrap: wrap; }
.pill {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 8px 14px; border-radius: 999px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.14);
  color: rgba(246,243,236,0.6);
  cursor: pointer;
  transition: all 0.18s ease;
}
.pill:hover { color: var(--branco); }
.pill.ativo {
  background: var(--vermelho); border-color: var(--vermelho); color: #fff;
  box-shadow: 0 4px 18px rgba(230,57,43,0.35);
}

/* ========================== BOTÕES =========================== */
.botao-cheio {
  position: relative; overflow: hidden;
  font-family: 'Archivo', sans-serif; font-weight: 700;
  font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 14px 26px; border-radius: 999px;
  background: var(--vermelho); color: #fff;
  border: none; cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.2s ease;
}
.botao-cheio::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: -45%;
  width: 34%;
  background: linear-gradient(105deg, transparent, rgba(255,255,255,0.5), transparent);
  transform: skewX(-18deg);
  transition: left 0.55s ease;
  pointer-events: none;
}
.botao-cheio:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 10px 30px rgba(230,57,43,0.45);
}
.botao-cheio:hover:not(:disabled)::after { left: 125%; }
.botao-cheio:active:not(:disabled) { transform: scale(0.97); }
.botao-cheio:disabled { opacity: 0.55; cursor: wait; }

.botao-vidro {
  font-family: 'Archivo', sans-serif; font-weight: 700;
  font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 14px 26px; border-radius: 999px;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.2);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  color: var(--branco); cursor: pointer;
  transition: all 0.2s ease;
}
.botao-vidro:hover { background: rgba(255,255,255,0.15); transform: translateY(-2px); }
.botao-vidro:active { transform: scale(0.97); }

.botao-tinta {
  font-family: 'Archivo', sans-serif; font-weight: 700;
  font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 13px 22px; border-radius: 999px;
  background: var(--tinta); color: var(--papel);
  border: 1px solid var(--tinta); cursor: pointer;
  margin-top: 26px;
  transition: transform 0.15s ease, box-shadow 0.2s ease;
}
.botao-tinta:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 10px 24px rgba(23,20,15,0.35);
}
.botao-tinta:active:not(:disabled) { transform: scale(0.97); }
.botao-tinta:disabled { opacity: 0.55; cursor: wait; }
.botao-tinta.fantasma { background: transparent; color: var(--tinta); }
.faixa-ambar .botao-tinta { background: #1c1206; border-color: #1c1206; color: #ffe9c9; }
.faixa-ambar .botao-tinta.fantasma {
  background: transparent; color: #1c1206; border-color: rgba(28,18,6,0.5);
}

/* ==================== EXEMPLOS / ERROS ======================= */
.exemplos { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.exemplos-rotulo {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--vermelho); margin-right: 4px;
}
.chip-vidro {
  font-size: 13px;
  padding: 8px 14px; border-radius: 999px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.12);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  color: rgba(246,243,236,0.7);
  cursor: pointer;
  transition: all 0.18s ease;
}
.chip-vidro:hover {
  color: var(--branco);
  border-color: rgba(230,57,43,0.6);
  transform: translateY(-1px);
}

.erro {
  margin-top: 18px; font-size: 14px;
  color: #f2a79e;
  background: rgba(230,57,43,0.09);
  border: 1px solid rgba(230,57,43,0.3);
  border-radius: 14px; padding: 12px 16px;
}
.erro p { margin: 0; }
.erro-detalhe {
  font-family: 'Space Mono', monospace;
  font-size: 11px; line-height: 1.5;
  color: #c98d84; margin-top: 6px !important;
  word-break: break-word;
}
.erro.na-faixa {
  background: rgba(20,15,6,0.12);
  border-color: rgba(28,18,6,0.4);
  color: #3d1c07;
}

/* ================== CARREGANDO (esqueleto) =================== */
.carregando { margin-top: 34px; }
.esqueleto {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 14px; max-width: 640px;
}
.esqueleto i {
  display: block; aspect-ratio: 2 / 3; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.08);
  background: linear-gradient(120deg, #181310 30%, #262019 50%, #181310 70%);
  background-size: 220% 100%;
  box-shadow: inset 0 0 24px rgba(255,190,110,0.06);
  animation: cintilar 1.3s linear infinite;
}
@keyframes cintilar { to { background-position: -120% 0; } }
.status-tipo {
  margin: 18px 0 0;
  font-family: 'Space Mono', monospace;
  font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--vermelho);
  display: flex; align-items: center; gap: 10px;
}
.status-luz {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--vermelho);
  box-shadow: 0 0 10px var(--vermelho);
  animation: pulsoLuz 1s ease-in-out infinite;
}
.cursor-tipo { color: var(--vermelho); animation: piscarCursor 1s steps(2) infinite; }
@keyframes piscarCursor { 50% { opacity: 0; } }
@keyframes pulsoLuz { 50% { opacity: 0.35; } }
.status-escuro .status-tipo { color: #2b1503; }
.status-escuro .status-luz { background: #2b1503; box-shadow: none; }
.status-escuro .cursor-tipo { color: #2b1503; }

/* =================== PAPEL (tabela editorial) ================ */
.papel {
  background: var(--papel); color: var(--tinta);
  margin-top: 70px; padding-bottom: 64px;
  position: relative;
}
.sprockets {
  height: 28px;
  background-image: radial-gradient(circle at 50% 50%, var(--preto) 5px, transparent 5.6px);
  background-size: 34px 28px;
  background-repeat: repeat-x;
  background-position: center;
}
.papel-cabeca {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 20px; flex-wrap: wrap;
  padding-top: 30px; margin-bottom: 26px;
}
.papel-titulo {
  font-family: 'Archivo Black', sans-serif;
  font-size: clamp(40px, 6.5vw, 86px);
  line-height: 0.86; letter-spacing: -0.03em;
  text-transform: uppercase; margin: 0;
}
.papel-nota {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
  color: rgba(23,20,15,0.55);
  max-width: 300px; text-align: right;
  margin: 0; line-height: 1.7;
}

.tabela { width: 100%; border-collapse: collapse; }
.tabela thead th {
  font-family: 'Space Mono', monospace; font-weight: 400;
  font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  text-align: left; color: rgba(23,20,15,0.5);
  padding: 0 14px 12px;
  border-bottom: 2px solid var(--tinta);
}
.tabela thead th:first-child { width: 54px; }
.linha { cursor: pointer; transition: background 0.18s ease; }
.linha td { border-top: 1px solid rgba(23,20,15,0.18); }
tbody:first-of-type .linha td { border-top: none; }
.linha:hover, .linha.aberta { background: rgba(23,20,15,0.05); }
.tabela td { padding: 16px 14px; vertical-align: baseline; }
.td-num {
  font-family: 'Space Mono', monospace; font-size: 12px;
  color: var(--vermelho);
}
.td-titulo {
  font-weight: 700;
  font-size: clamp(19px, 2.4vw, 26px);
  letter-spacing: -0.01em;
  position: relative; padding-right: 44px;
}
.td-seta {
  position: absolute; right: 12px; top: 50%;
  transform: translateY(-50%);
  font-family: 'Space Mono', monospace; font-size: 17px;
  color: var(--vermelho);
  transition: transform 0.2s ease;
}
.linha:hover .td-seta { transform: translateY(-50%) scale(1.3); }
.td-mono {
  font-family: 'Space Mono', monospace; font-size: 12px;
  color: rgba(23,20,15,0.65);
  white-space: nowrap;
}
.linha-detalhe td { padding: 0; border: none; }
.ficha {
  max-height: 0; overflow: hidden;
  transition: max-height 0.5s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.ficha.aberta { max-height: 460px; }
.ficha-grade {
  display: grid; grid-template-columns: 120px 1fr;
  gap: 20px;
  padding: 6px 14px 28px 68px;
}
.ficha-poster {
  width: 120px; aspect-ratio: 2 / 3; object-fit: cover;
  border-radius: 6px;
  box-shadow: 0 14px 30px rgba(23,20,15,0.28);
}
.ficha-meta {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.08em;
  color: var(--vermelho); margin: 0;
}
.ficha-sinopse { font-size: 15px; line-height: 1.6; margin: 8px 0 0; }
.ficha-porque {
  font-size: 14px; line-height: 1.6;
  color: rgba(23,20,15,0.72);
  border-left: 3px solid var(--vermelho);
  padding-left: 12px;
  margin: 12px 0 16px;
}
.ficha-porque span {
  display: block;
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--vermelho); margin-bottom: 3px;
}

/* lupa de vidro sobre a tabela */
.lente {
  position: fixed; left: 0; top: 0; z-index: 120;
  width: 180px; padding: 10px; border-radius: 16px;
  pointer-events: none;
  transform: translate(-500px, -500px);
  will-change: transform;
  background: linear-gradient(140deg, rgba(20,16,12,0.88), rgba(20,16,12,0.72));
  border-color: rgba(255,255,255,0.18);
}
.lente-poster {
  width: 100%; aspect-ratio: 2 / 3; object-fit: cover;
  border-radius: 10px; display: block;
}
.lente .poster-vazio.lente-poster { font-size: 40px; }
.lente-titulo {
  margin: 8px 2px 0;
  font-weight: 700; font-size: 13px; line-height: 1.2;
  color: var(--branco);
}
@media (pointer: coarse) { .lente { display: none; } }

/* ================ FAIXA ÂMBAR (identificar) ================== */
.faixa-ambar {
  background: var(--ambar); color: #1c1206;
  border-block: 6px solid var(--preto);
  padding: clamp(56px, 9vh, 96px) 0 60px;
  position: relative;
}
.faixa-cabeca {
  display: grid; grid-template-columns: auto 1fr;
  gap: 8px 22px; align-items: start;
}
.faixa-titulo {
  font-family: 'Archivo Black', sans-serif;
  font-size: clamp(44px, 7.5vw, 100px);
  line-height: 0.85; letter-spacing: -0.03em;
  text-transform: uppercase; margin: 0;
}
.faixa-desc {
  grid-column: 2;
  font-size: 15px; color: rgba(28,18,6,0.75);
  max-width: 520px; margin: 12px 0 0;
}

.zona {
  margin-top: 36px;
  border: 2px dashed rgba(28,18,6,0.6);
  border-radius: 18px;
  min-height: 220px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; padding: 22px;
  text-align: center; cursor: pointer;
  background: rgba(255,255,255,0.14);
  transition: transform 0.2s ease, background 0.2s ease,
    box-shadow 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}
.zona:hover { background: rgba(255,255,255,0.24); }
.zona.arrastando {
  transform: scale(1.012);
  background: #1c1206; color: var(--ambar);
  border-color: #1c1206;
  box-shadow: 0 24px 60px rgba(28,18,6,0.35);
}
.zona.com-imagem { padding: 14px; background: rgba(28,18,6,0.08); }
.zona-frase {
  font-family: 'Archivo Black', sans-serif;
  font-size: clamp(20px, 3vw, 30px);
  letter-spacing: -0.01em; text-transform: uppercase;
}
.zona-dica {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  opacity: 0.7;
}
.zona-acoes {
  display: flex; gap: 12px; justify-content: flex-end;
  flex-wrap: wrap; margin-top: 16px;
}
.zona-acoes .botao-tinta { margin-top: 0; }

/* quadro do frame + varredura de scanner */
.quadro { position: relative; max-width: 100%; }
.quadro-img {
  display: block; max-width: 100%; max-height: 380px;
  border-radius: 10px;
}
.mira {
  position: absolute; width: 26px; height: 26px;
  border: 3px solid var(--vermelho);
}
.m1 { top: -7px; left: -7px; border-right: none; border-bottom: none; }
.m2 { top: -7px; right: -7px; border-left: none; border-bottom: none; }
.m3 { bottom: -7px; left: -7px; border-right: none; border-top: none; }
.m4 { bottom: -7px; right: -7px; border-left: none; border-top: none; }
.scan {
  position: absolute; left: 6px; right: 6px; top: 4px;
  height: 3px; border-radius: 2px;
  background: var(--vermelho);
  box-shadow: 0 0 18px var(--vermelho), 0 0 46px rgba(230,57,43,0.7);
  opacity: 0;
}
.escaneando .scan {
  opacity: 1;
  animation: varrer 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite alternate;
}
@keyframes varrer { from { top: 4px; } to { top: calc(100% - 8px); } }
.escaneando::after {
  content: ""; position: absolute; inset: 0;
  border-radius: 10px; pointer-events: none;
  background: repeating-linear-gradient(180deg,
    transparent 0 5px, rgba(28,18,6,0.12) 5px 6px);
}
.escaneando .quadro-img { animation: tremorScan 0.4s steps(2) infinite; }
@keyframes tremorScan {
  0%, 100% { filter: contrast(1); }
  50% { filter: contrast(1.12) brightness(1.04); }
}

/* ================= RESULTADO DA IDENTIFICAÇÃO ================ */
.resultado-area { padding-top: 64px; }
.achado { position: relative; }
.achado-carimbo {
  position: absolute; top: -18px; right: 4%; z-index: 3;
  font-family: 'Archivo Black', sans-serif;
  font-size: 15px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--vermelho);
  border: 3px solid var(--vermelho);
  border-radius: 8px; padding: 8px 14px;
  background: rgba(230,57,43,0.08);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  transform: rotate(8deg);
  animation: carimbar 0.55s cubic-bezier(0.2, 1.6, 0.35, 1) 0.25s both;
}
@keyframes carimbar {
  0%   { opacity: 0; transform: rotate(8deg) scale(2.6); }
  70%  { opacity: 1; transform: rotate(6deg) scale(0.94); }
  100% { opacity: 1; transform: rotate(8deg) scale(1); }
}
.achado-grade {
  display: grid;
  grid-template-columns: minmax(200px, 300px) 1fr;
  gap: clamp(20px, 4vw, 44px);
  align-items: start;
}
.achado-info { padding: clamp(20px, 3vw, 30px); border-radius: 22px; }
.info-meta {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.08em;
  color: var(--vermelho); margin: 0 0 10px;
}
.info-titulo {
  font-family: 'Archivo Black', sans-serif;
  font-size: clamp(30px, 4.5vw, 54px);
  line-height: 0.92; letter-spacing: -0.02em;
  text-transform: uppercase; margin: 0;
}
.info-original {
  font-family: 'Space Mono', monospace; font-size: 11px;
  color: rgba(246,243,236,0.5); margin: 8px 0 0;
}
.medidor { margin-top: 18px; }
.medidor-rotulo {
  display: block;
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(246,243,236,0.7);
  margin-bottom: 8px;
}
.medidor-trilho {
  display: block; height: 8px; max-width: 260px;
  border-radius: 999px;
  background: rgba(255,255,255,0.12);
  border: 1px solid rgba(255,255,255,0.14);
  overflow: hidden;
}
.medidor-trilho i {
  display: block; height: 100%;
  background: var(--vermelho);
  border-radius: inherit;
  box-shadow: 0 0 14px rgba(230,57,43,0.6);
  transform-origin: left;
  animation: crescerBarra 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) 0.3s both;
}
.medidor.alta i { background: linear-gradient(90deg, var(--vermelho), var(--ambar)); }
@keyframes crescerBarra { from { transform: scaleX(0); } }
.info-pistas {
  margin: 18px 0 0;
  font-size: 14px; line-height: 1.6;
  color: rgba(246,243,236,0.75);
  border-left: 3px solid var(--vermelho);
  padding-left: 12px;
}
.info-pistas span {
  display: block;
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--vermelho); margin-bottom: 3px;
}
.info-acoes { margin-top: 20px; }

.nao-achado { padding: 26px; border-radius: 20px; }
.nao-titulo {
  font-family: 'Archivo Black', sans-serif;
  font-size: 26px; text-transform: uppercase;
  letter-spacing: -0.01em; margin: 0;
}
.nao-texto { font-size: 14.5px; color: rgba(246,243,236,0.7); margin: 10px 0 0; }

.alternativas { margin-top: 44px; }
.alt-rotulo {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--vermelho); margin: 0 0 16px;
}
.alt-grade {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 18px;
}
.alt-item { display: flex; gap: 14px; align-items: flex-start; }
.alt-info { min-width: 0; }
.alt-meta {
  font-family: 'Space Mono', monospace; font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--vermelho); margin: 2px 0 4px;
}
.alt-titulo { font-weight: 700; font-size: 17px; line-height: 1.15; margin: 0 0 10px; }

/* =================== SALVAR EM LISTA (popover) =============== */
.salvar-wrap { position: relative; display: inline-block; }
.botao-salvar {
  font-family: 'Space Mono', monospace;
  font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 8px 14px; border-radius: 999px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.3);
  color: rgba(246,243,236,0.75);
  cursor: pointer; white-space: nowrap;
  transition: all 0.18s ease;
}
.botao-salvar:hover { border-color: var(--vermelho); color: var(--branco); }
.botao-salvar.salvo { background: var(--vermelho); border-color: var(--vermelho); color: #fff; }
.papel .botao-salvar {
  border-color: rgba(23,20,15,0.45);
  color: rgba(23,20,15,0.75);
}
.papel .botao-salvar:hover { border-color: var(--tinta); color: var(--tinta); }
.papel .botao-salvar.salvo { background: var(--tinta); border-color: var(--tinta); color: var(--papel); }

.menu-salvar {
  position: absolute; right: 0; bottom: calc(100% + 10px);
  width: 240px; padding: 12px;
  border-radius: 16px; z-index: 50;
  text-align: left;
  background: linear-gradient(150deg, rgba(24,19,15,0.92), rgba(24,19,15,0.8));
  border: 1px solid rgba(255,255,255,0.16);
  box-shadow: 0 18px 44px rgba(0,0,0,0.5);
  animation: brotarMenu 0.25s cubic-bezier(0.2, 1.2, 0.3, 1) both;
  transform-origin: bottom right;
}
@keyframes brotarMenu {
  from { opacity: 0; transform: scale(0.86) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.menu-titulo {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--vermelho); margin: 0 0 8px;
}
.menu-vazio { font-size: 12.5px; color: rgba(246,243,236,0.6); margin: 0 0 8px; line-height: 1.4; }
.menu-lista {
  display: flex; width: 100%; align-items: center; gap: 8px;
  font-size: 13.5px; color: var(--branco);
  background: none; border: none; border-radius: 8px;
  padding: 8px; cursor: pointer; text-align: left;
  transition: background 0.15s ease;
}
.menu-lista:hover { background: rgba(255,255,255,0.08); }
.menu-check { width: 14px; flex: none; font-size: 12px; color: var(--vermelho); }
.menu-lista.dentro .menu-nome { color: var(--luz); }
.menu-nome {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.menu-qtd {
  font-family: 'Space Mono', monospace; font-size: 10px;
  color: rgba(246,243,236,0.5);
}
.menu-nova {
  display: flex; gap: 6px;
  margin-top: 10px; padding-top: 10px;
  border-top: 1px dashed rgba(255,255,255,0.16);
}
.menu-nova input {
  flex: 1; min-width: 0;
  font: inherit; font-size: 13px;
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.16);
  color: var(--branco);
  border-radius: 8px; padding: 8px 10px;
  outline: none;
}
.menu-nova input::placeholder { color: rgba(246,243,236,0.4); }
.menu-nova input:focus { border-color: rgba(230,57,43,0.6); }
.menu-nova button {
  font-family: 'Archivo', sans-serif; font-weight: 700;
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 8px 12px; border-radius: 8px;
  border: none; background: var(--vermelho); color: #fff;
  cursor: pointer;
}

/* ======================= SUAS LISTAS ========================= */
.console.nova-lista {
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  padding: 12px 12px 12px 20px;
}
.entrada-lista {
  flex: 1; min-width: 220px;
  background: transparent; border: none; outline: none;
  color: var(--branco);
  font: inherit; font-size: 16px;
  padding: 8px 2px;
}
.entrada-lista::placeholder { color: rgba(246,243,236,0.42); }

.arquivo-vazio {
  margin-top: 40px;
  display: flex; align-items: center; gap: 26px; flex-wrap: wrap;
}
.av-num {
  font-family: 'Archivo Black', sans-serif;
  font-size: clamp(70px, 12vw, 140px); line-height: 1;
  color: transparent;
  -webkit-text-stroke: 2px rgba(246,243,236,0.22);
  margin: 0; user-select: none;
}
.av-texto {
  font-family: 'Space Mono', monospace;
  font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(246,243,236,0.55);
  max-width: 360px; line-height: 1.9; margin: 0;
}

.prateleira { margin-top: 52px; }
.prat-cabeca {
  display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
  border-bottom: 1px solid rgba(255,255,255,0.14);
  padding-bottom: 12px; margin-bottom: 18px;
}
.prat-marca {
  font-family: 'Space Mono', monospace; font-weight: 700;
  font-size: 13px; letter-spacing: 0.1em;
  color: var(--vermelho);
}
.prat-nome {
  font-family: 'Archivo Black', sans-serif;
  font-size: clamp(24px, 3.6vw, 40px);
  line-height: 0.95; letter-spacing: -0.02em;
  text-transform: uppercase; margin: 0;
  min-width: 0; overflow-wrap: anywhere;
}
.prat-qtd {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(246,243,236,0.5);
}
.prat-acoes {
  margin-left: auto;
  display: flex; gap: 8px; flex-wrap: wrap;
  align-items: center;
}
.prat-compartilhar {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 7px 12px; border-radius: 999px;
  background: transparent;
  border: 1px solid rgba(240,146,30,0.55);
  color: var(--ambar); cursor: pointer;
  transition: all 0.2s ease;
}
.prat-compartilhar:hover:not(:disabled) {
  background: rgba(240,146,30,0.16);
  color: var(--luz);
}
.prat-compartilhar:disabled { opacity: 0.6; cursor: wait; }
.prat-apagar {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 7px 12px; border-radius: 999px;
  background: transparent;
  border: 1px solid rgba(230,57,43,0.45);
  color: #f2a79e; cursor: pointer;
  transition: all 0.2s ease;
}
.prat-apagar:hover { background: rgba(230,57,43,0.16); color: #fff; }
.prat-vazia {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(246,243,236,0.45);
  border: 1px dashed rgba(255,255,255,0.18);
  border-radius: 12px; padding: 18px; margin: 0;
  line-height: 1.8;
}
.prat-grade { display: flex; flex-wrap: wrap; gap: 16px; }
.prat-item { position: relative; width: 118px; }
.prat-item:hover { filter: brightness(1.12); transform: translateY(-4px); }
.prat-item figcaption { padding: 8px 3px 2px; display: grid; gap: 2px; }
.pi-titulo {
  font-weight: 700; font-size: 12.5px; line-height: 1.2;
  color: var(--branco);
  display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
}
.pi-meta {
  font-family: 'Space Mono', monospace;
  font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase;
  color: rgba(246,243,236,0.5);
}
.pi-remover {
  position: absolute; top: 10px; right: 10px; z-index: 2;
  width: 26px; height: 26px; border-radius: 50%;
  background: rgba(13,11,9,0.72);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.25);
  color: var(--branco); cursor: pointer;
  font-size: 15px; line-height: 1;
  opacity: 0; transform: scale(0.7);
  transition: all 0.2s ease;
}
.prat-item:hover .pi-remover,
.prat-item:focus-within .pi-remover { opacity: 1; transform: scale(1); }
.pi-remover:hover { background: var(--vermelho); border-color: var(--vermelho); }
@media (pointer: coarse) { .pi-remover { opacity: 1; transform: none; } }

/* ========================== RODAPÉ =========================== */
.rodape {
  position: relative; z-index: 1;
  border-top: 1px solid rgba(255,255,255,0.12);
  margin-top: 40px; padding-top: 34px;
  overflow: hidden;
}
.rodape-linhas {
  display: flex; flex-wrap: wrap;
  gap: 8px 40px; justify-content: space-between;
}
.rodape-linhas p {
  font-family: 'Space Mono', monospace;
  font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase;
  color: rgba(246,243,236,0.45);
  margin: 0; line-height: 1.8; max-width: 460px;
}
.rodape-marca {
  font-family: 'Archivo Black', sans-serif;
  font-size: clamp(90px, 21vw, 300px);
  line-height: 0.78; letter-spacing: -0.03em;
  text-transform: uppercase; text-align: center;
  color: transparent;
  -webkit-text-stroke: 2px rgba(246,243,236,0.2);
  margin: 30px 0 -0.08em;
  user-select: none;
  transition: color 0.4s ease;
}
.rodape-marca:hover { color: rgba(246,243,236,0.07); }

/* ==================== GRÃO DE FILME ========================== */
.graos {
  position: fixed; inset: -44px; z-index: 130;
  pointer-events: none; opacity: 0.06;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='180'%20height='180'%3E%3Cfilter%20id='n'%3E%3CfeTurbulence%20type='fractalNoise'%20baseFrequency='0.85'%20numOctaves='2'%20stitchTiles='stitch'/%3E%3C/filter%3E%3Crect%20width='100%25'%20height='100%25'%20filter='url(%23n)'/%3E%3C/svg%3E");
  animation: graos 0.5s steps(3) infinite;
}
@keyframes graos {
  0%   { transform: translate(0, 0); }
  33%  { transform: translate(-13px, 9px); }
  66%  { transform: translate(11px, -11px); }
  100% { transform: translate(0, 0); }
}

/* ================== REVELAÇÃO AO ROLAR ======================= */
[data-revelar] {
  opacity: 0; transform: translateY(28px);
  transition: opacity 0.8s ease, transform 0.8s cubic-bezier(0.2, 0.75, 0.2, 1);
}
[data-revelar][data-visivel] { opacity: 1; transform: translateY(0); }

/* ======================== RESPONSIVO ========================= */
@media (max-width: 760px) {
  .nav-marca { font-size: 12px; }
  .nav-item { font-size: 11px; padding: 11px 10px; }
  .parede { gap: 10px; padding: 34px 12px 0; }
  .coluna { gap: 10px; max-width: 104px; }
  .col-0, .col-5 { display: none; }
  .col-1 { transform: rotateY(18deg) translateZ(-40px); }
  .col-4 { transform: rotateY(-18deg) translateZ(-40px); }
  .secao-cabeca, .faixa-cabeca { grid-template-columns: 1fr; }
  .secao-desc, .faixa-desc { grid-column: 1; }
  .secao-num { justify-self: start; margin-top: 0; }
  .col-ano, .col-tipo, .col-gen { display: none; }
  .td-titulo { font-size: 18px; }
  .ficha-grade { grid-template-columns: 92px 1fr; padding: 6px 14px 26px; }
  .ficha-poster { width: 92px; }
  .ficha.aberta { max-height: 560px; }
  .papel-nota { text-align: left; }
  .achado-grade { grid-template-columns: 1fr; }
  .caixa.grande { width: min(260px, 82%); margin-inline: auto; }
  .achado-carimbo { right: 2%; top: -14px; }
  .rodape-linhas { flex-direction: column; }
  .prat-item { width: 104px; }
}
@media (max-width: 430px) {
  .esqueleto { grid-template-columns: repeat(2, 1fr); }
  .alt-grade { grid-template-columns: 1fr; }
  .prat-item { width: 96px; }
  .ticker-fita span { gap: 16px; padding: 10px 8px; }
}

/* ==================== MOVIMENTO REDUZIDO ===================== */
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .raiz *, .raiz *::before, .raiz *::after {
    animation: none !important;
    transition: none !important;
  }
  .graos, .liquido, .lanterna, .scan { display: none !important; }
  [data-revelar] { opacity: 1 !important; transform: none !important; }
  .letra span { transform: none !important; }
  .heroi-sub, .heroi-acoes { opacity: 1 !important; transform: none !important; }
  .acesa, .caixa-vazia { opacity: 1 !important; filter: none !important; }
  .medidor-trilho i { transform: none !important; }
  .menu-salvar { opacity: 1 !important; transform: none !important; }
}
`;