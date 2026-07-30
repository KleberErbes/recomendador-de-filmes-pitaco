import { useState, useEffect, useRef, useMemo } from "react";
import {
  contaLigada,
  pegarSessao,
  aoMudarSessao,
  entrar as entrarNaConta,
  criarConta,
  sair as sairDaConta,
  recuperarSenha,
  carregarListasDaNuvem,
  salvarListasNaNuvem,
  carregarAvaliacoesDaNuvem,
  salvarAvaliacoesNaNuvem,
  criarListaCompartilhada,
  entrarPorCodigo,
  carregarCompartilhadas,
  carregarMembros,
  adicionarItemCompartilhada,
  removerItemCompartilhada,
  definirPermissao,
  renomearCompartilhada,
  removerMembro,
  sairDaCompartilhada,
  apagarCompartilhada,
  ouvirCompartilhada,
} from "./nuvem.js";

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
async function chamarIA(conteudo, querJson = false, esquema = null, maxTokens = null) {
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
          ...(maxTokens ? { maxTokens } : {}),
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

// Busca títulos pelo nome (usada pela lupa do menu).
async function buscarObras(termo) {
  const limpo = (termo || "").trim();
  if (!TMDB_ATIVO || limpo.length < 2) return [];
  try {
    const resp = await fetch(
      "/api/tmdb?rota=search/multi&language=pt-BR&query=" + encodeURIComponent(limpo)
    );
    const dados = await resp.json();
    return (dados.results || [])
      .filter((r) => r.media_type === "movie" || r.media_type === "tv")
      .slice(0, 12)
      .map((r) => ({
        titulo: r.title || r.name,
        ano: parseInt((r.release_date || r.first_air_date || "").slice(0, 4), 10) || null,
        tipo: r.media_type === "movie" ? "filme" : "série",
        // A sinopse do TMDB é guardada junto ao salvar na lista, para a ficha do
        // item salvo já vir preenchida.
        sinopse: r.overview || "",
        poster: r.poster_path ? "https://image.tmdb.org/t/p/w342" + r.poster_path : null,
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
// Marca, por usuário, que a fusão única do localStorage com a nuvem já foi
// feita. Sem isso, todo F5 juntaria o localStorage de novo — e como a fusão só
// sabe ADICIONAR, uma lista apagada em outro aparelho voltava a cada recarga.
const CHAVE_FUNDIU = "pitaco-fundiu-";
let listasMemoria = null;

function jaFundiuLocal(uid) {
  if (!uid) return true;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem(CHAVE_FUNDIU + uid) === "1";
    }
  } catch (e) {}
  return false;
}

function marcarFundiuLocal(uid) {
  if (!uid) return;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(CHAVE_FUNDIU + uid, "1");
    }
  } catch (e) {}
}

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

// Junta as listas que estavam no aparelho com as que vieram da nuvem.
// Usado no primeiro login: em vez de escolher uma e descartar a outra, casamos
// pelo nome da lista e, dentro dela, evitamos repetir o mesmo título.
function juntarListas(daNuvem, doAparelho) {
  const resultado = (daNuvem || []).map((l) => ({ ...l, itens: [...(l.itens || [])] }));
  for (const local of doAparelho || []) {
    const igual = resultado.find(
      (l) => (l.nome || "").trim().toLowerCase() === (local.nome || "").trim().toLowerCase()
    );
    if (!igual) {
      resultado.push({ ...local, itens: [...(local.itens || [])] });
      continue;
    }
    for (const item of local.itens || []) {
      if (!igual.itens.some((i) => mesmaObra(i, item))) {
        igual.itens.push({ ...item, id: novoId("item") });
      }
    }
  }
  return resultado;
}

// Duas coleções de listas compartilhadas são "iguais" para a tela quando têm as
// mesmas listas, com o mesmo nome, permissão e os mesmos títulos dentro. Serve
// para não re-renderizar à toa a cada verificação periódica.
function mesmasListas(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (
      x.id !== y.id ||
      x.nome !== y.nome ||
      Boolean(x.somente_dono_edita) !== Boolean(y.somente_dono_edita) ||
      (x.itens || []).length !== (y.itens || []).length
    ) return false;
    const ix = x.itens || [], iy = y.itens || [];
    for (let j = 0; j < ix.length; j++) {
      if (ix[j].id !== iy[j].id) return false;
    }
  }
  return true;
}

function mesmaObra(a, b) {
  return (
    (a.titulo || "").trim().toLowerCase() === (b.titulo || "").trim().toLowerCase() &&
    (!a.ano || !b.ano || a.ano === b.ano)
  );
}

// Valida o FORMATO do e-mail (não garante que exista de verdade — isso só a
// confirmação por e-mail do Supabase garante). Rejeita os erros comuns: sem @,
// sem domínio, sem ponto no domínio, espaços, dois @, começo/fim inválidos.
function emailValido(email) {
  const e = (email || "").trim();
  if (!e || e.length > 254) return false;
  if (/\s/.test(e)) return false;
  // exatamente um @, parte local não vazia, domínio com ao menos um ponto e
  // extensão de 2+ letras (ex.: .com, .com.br).
  return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(e) && !e.includes("..");
}

// Domínios de e-mail com erro de digitação comum → sugere a correção.
const DOMINIOS_COMUNS = {
  "gmail.co": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "hotmail.co": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "outlook.co": "outlook.com",
  "yahoo.co": "yahoo.com",
  "icloud.co": "icloud.com",
};
function sugestaoEmail(email) {
  const e = (email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at === -1) return null;
  const dominio = e.slice(at + 1);
  const certo = DOMINIOS_COMUNS[dominio];
  return certo ? e.slice(0, at + 1) + certo : null;
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

// Converte uma URL de pôster do TMDB para a NOSSA rota /api/poster (mesma
// origem). Isso é essencial só na geração do PNG: imagens de outra origem
// "contaminam" o canvas e impedem o toBlob. Se não for uma URL do TMDB (ou já
// for local), devolve como está.
function urlMesmaOrigem(url) {
  if (!url) return url;
  const m = /^https?:\/\/image\.tmdb\.org\/t\/p\/[^/]+(\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp))$/i.exec(url);
  if (!m) return url;
  return "/api/poster?size=w500&path=" + encodeURIComponent(m[1]);
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
    // Passa pela nossa origem para o canvas exportar sem erro de CORS.
    im.src = urlMesmaOrigem(url);
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

// Popover "salvar em" (vidro).
// variante="inline": em vez de flutuar sobre o conteúdo, o menu entra no fluxo
// normal e empurra o que vem abaixo. É o que usamos dentro do painel de busca,
// que tem rolagem própria e cortaria um menu flutuante.
// Estrelas de avaliação (1 a 5). "nota" é a nota atual (0 = sem avaliar).
// Clicar numa estrela define a nota; clicar na mesma estrela de novo limpa.
// Sem conta, o clique dispara "onPrecisaConta" em vez de avaliar.
function Estrelas({ nota, onAvaliar, onPrecisaConta, liberado }) {
  const [hover, setHover] = useState(0);
  const ativo = hover || nota;
  return (
    <div
      className="estrelas"
      role="radiogroup"
      aria-label="Avaliar de 1 a 5 estrelas"
      onClick={(e) => e.stopPropagation()}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={"estrela" + (n <= ativo ? " cheia" : "")}
          aria-label={n + (n === 1 ? " estrela" : " estrelas")}
          aria-checked={n === nota}
          role="radio"
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={() => {
            if (!liberado) { onPrecisaConta && onPrecisaConta(); return; }
            onAvaliar(n === nota ? 0 : n);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.6 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
          </svg>
        </button>
      ))}
    </div>
  );
}

function BotaoSalvar({
  obra, listas, aberto, salvo,
  onAbrir, onFechar, onAlternar, onCriar,
  nomeNova, setNomeNova, variante,
  compartilhadas, usuarioId, onAlternarCompart,
}) {
  const compart = compartilhadas || [];
  return (
    <div
      className={"salvar-wrap" + (variante === "inline" ? " inline" : "")}
      onClick={(e) => e.stopPropagation()}
    >
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

          {listas.length === 0 && compart.length === 0 && (
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

          {compart.length > 0 && (
            <>
              <p className="menu-subtitulo">compartilhadas</p>
              {compart.map((l) => {
                const dentro = (l.itens || []).some((i) => mesmaObra(i, obra));
                return (
                  <button
                    key={l.id}
                    className={"menu-lista compart" + (dentro ? " dentro" : "")}
                    onClick={() => onAlternarCompart(l)}
                  >
                    <span className="menu-check">{dentro ? "✓" : ""}</span>
                    <span className="menu-nome">{l.nome}</span>
                    <span className="menu-qtd">{(l.itens || []).length}</span>
                  </button>
                );
              })}
            </>
          )}

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
  // Menu encolhe ao rolar para baixo e volta ao normal ao rolar para cima.
  const [navCompacta, setNavCompacta] = useState(false);
  // Busca por título (ícone de lupa no menu).
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [termoBusca, setTermoBusca] = useState("");
  const [resBusca, setResBusca] = useState([]);
  const [buscandoObras, setBuscandoObras] = useState(false);
  const campoBuscaRef = useRef(null);
  // Área do resultado da identificação, para rolar até ela quando o Pitaco acha.
  const resultadoIdRef = useRef(null);

  // --- Conta do usuário ---
  const [sessao, setSessao] = useState(null);
  const [sessaoPronta, setSessaoPronta] = useState(false);
  const [contaAberta, setContaAberta] = useState(false);
  const [modoConta, setModoConta] = useState("entrar"); // "entrar" | "criar"
  const [emailConta, setEmailConta] = useState("");
  const [senhaConta, setSenhaConta] = useState("");
  const [erroConta, setErroConta] = useState("");
  const [avisoConta, setAvisoConta] = useState("");
  const [ocupadoConta, setOcupadoConta] = useState(false);
  // Explica POR QUE a conta está sendo pedida (ex.: ao tentar salvar um filme).
  const [motivoConta, setMotivoConta] = useState("");
  const [sincronizando, setSincronizando] = useState(false);
  // Guarda o motivo quando a nuvem falha, para avisarmos na tela em vez de
  // deixar a pessoa achando que a sincronização "simplesmente não funciona".
  const [falhaNuvem, setFalhaNuvem] = useState("");
  const usuario = sessao && sessao.user ? sessao.user : null;

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
  // Item da lista atualmente expandido (formato "idLista:idItem"), para abrir a
  // mesma ficha das sugestões ao clicar num título salvo.
  const [itemListaAberto, setItemListaAberto] = useState(null);
  const [lenteObra, setLenteObra] = useState(null);
  const entradaRef = useRef(null);
  const lenteRef = useRef(null);

  // --- Identificar ---
  const [imagem, setImagem] = useState(null); // { data, media_type, preview }
  const [arrastando, setArrastando] = useState(false);
  const [carregandoId, setCarregandoId] = useState(false);
  const [resId, setResId] = useState(null);
  const [erroId, setErroId] = useState("");
  const [erroIdDetalhe, setErroIdDetalhe] = useState("");
  const inputArquivoRef = useRef(null);

  // --- Listas ---
  const [listas, setListas] = useState([]);
  const [listasProntas, setListasProntas] = useState(false);
  // Avaliações do usuário: [{ chave, titulo, ano, tipo, nota, quando }]. A chave
  // (titulo|ano) identifica o filme de forma estável entre sessões.
  const [avaliacoes, setAvaliacoes] = useState([]);
  // Listas compartilhadas de que o usuário é membro (vêm do banco, não do JSON
  // pessoal). Cada uma: { id, nome, codigo, dono, itens, ... }.
  const [compartilhadas, setCompartilhadas] = useState([]);
  const [painelCompartilhar, setPainelCompartilhar] = useState(null); // lista sendo compartilhada (mostra código/link)
  const [entrarAberto, setEntrarAberto] = useState(false);
  const [codigoEntrar, setCodigoEntrar] = useState("");
  const [erroCompart, setErroCompart] = useState("");
  const [ocupadoCompart, setOcupadoCompart] = useState(false);
  const [linkCopiado, setLinkCopiado] = useState(false);
  const [codigoCopiado, setCodigoCopiado] = useState(false);
  // Modal de criação: nome + quem pode editar.
  const [criarAberto, setCriarAberto] = useState(false);
  const [nomeCompart, setNomeCompart] = useState("");
  const [soDonoEdita, setSoDonoEdita] = useState(false);
  // Membros por lista: { [listaId]: [{ user_id, apelido, e_dono }] }
  const [membrosPorLista, setMembrosPorLista] = useState({});
  // Lista sendo renomeada (id) e o texto em edição.
  const [renomeando, setRenomeando] = useState(null);
  const [nomeRenomear, setNomeRenomear] = useState("");
  const [copiado, setCopiado] = useState(false);
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
  // Descobre se já existe alguém logado e fica de olho em entradas/saídas.
  useEffect(() => {
    let ativo = true;
    (async () => {
      const s = await pegarSessao();
      if (!ativo) return;
      setSessao(s);
      setSessaoPronta(true);
    })();
    const cancelar = aoMudarSessao((s) => {
      if (ativo) setSessao(s);
    });
    return () => { ativo = false; cancelar(); };
  }, []);

  // Marca que "listas" acabou de vir da nuvem, para o efeito de salvar não
  // regravar na hora o mesmo conteúdo (evita o eco leitura → escrita).
  const vindoDaNuvemRef = useRef(false);
  // Sempre com o valor mais recente, para os envios/flush usarem sem depender
  // do fechamento (closure) de um render antigo.
  const listasRef = useRef(listas);
  const usuarioIdRef = useRef(null);
  listasRef.current = listas;
  usuarioIdRef.current = usuario ? usuario.id : null;
  const avaliacoesRef = useRef(avaliacoes);
  avaliacoesRef.current = avaliacoes;
  // Verdadeiro enquanto há uma gravação na nuvem agendada e ainda não concluída.
  const envioPendenteRef = useRef(false);
  // Marca que "avaliacoes" acabou de vir da nuvem (evita regravar na hora).
  const avaliacoesDaNuvemRef = useRef(false);
  // Sempre com as compartilhadas atuais, para diagnósticos sem depender de
  // fechamento (closure) de um render antigo.
  const compartilhadasRef = useRef([]);
  compartilhadasRef.current = compartilhadas;

  // Traz as listas da nuvem para este aparelho.
  //
  // A fusão com o localStorage só acontece UMA VEZ na vida da conta, no primeiro
  // login (para não perder o que existia antes de ter conta). Depois disso —
  // inclusive a cada F5 — a NUVEM é a única fonte da verdade. Isso é o que
  // conserta o "apaguei e voltou": antes, todo recarregamento refazia a fusão, e
  // como fundir só sabe ADICIONAR, o localStorage de um aparelho ressuscitava
  // listas apagadas em outro.
  async function sincronizarComNuvem(uid, aberturaDaSessao) {
    if (!uid) return;
    setSincronizando(true);
    try {
      const daNuvem = await carregarListasDaNuvem(uid);
      const precisaFundir = aberturaDaSessao && !jaFundiuLocal(uid);

      if (precisaFundir) {
        const locais = await carregarListasSalvas();
        const listasLocais = Array.isArray(locais) ? locais : [];
        const juntas = listasLocais.length ? juntarListas(daNuvem, listasLocais) : daNuvem;
        setListas(juntas);
        setListasProntas(true);
        setFalhaNuvem("");
        if (listasLocais.length) {
          await salvarListasNaNuvem(uid, juntas);
        }
        marcarFundiuLocal(uid); // não funde de novo nas próximas cargas
      } else {
        // Fonte da verdade: a nuvem, como está.
        vindoDaNuvemRef.current = true;
        setListas(daNuvem);
        setListasProntas(true);
        setFalhaNuvem("");
      }

      // Avaliações: a nuvem é sempre a fonte da verdade (cada filme tem uma nota
      // só, então não há o problema de "ressuscitar" que as listas tinham).
      try {
        const avalsNuvem = await carregarAvaliacoesDaNuvem(uid);
        avaliacoesDaNuvemRef.current = true;
        setAvaliacoes(Array.isArray(avalsNuvem) ? avalsNuvem : []);
      } catch (e) {
        console.error("[Pitaco] Falha ao ler avaliações:", e);
      }
    } catch (e) {
      setFalhaNuvem(String(e.message || e));
      console.error("[Pitaco] Falha ao sincronizar com a nuvem:", e);
      // Se falhou logo na abertura e ainda não tínhamos nada em tela, mostramos
      // o que houver no aparelho para o app não abrir vazio.
      if (aberturaDaSessao && !listasProntas) {
        const locais = await carregarListasSalvas();
        setListas(Array.isArray(locais) ? locais : []);
        setListasProntas(true);
      }
    } finally {
      setSincronizando(false);
    }
  }

  // Carrega as listas ao abrir e ao entrar/sair da conta.
  useEffect(() => {
    if (!sessaoPronta) return;
    let ativo = true;
    (async () => {
      // Listas trancadas (há conta disponível, mas ninguém entrou): não lemos
      // nem marcamos como prontas. Deixar "prontas" com a lista vazia faria o
      // efeito de salvar gravar [] por cima do que já existe no aparelho.
      if (contaLigada && !usuario) {
        if (!ativo) return;
        setListas([]);
        setListasProntas(false);
        return;
      }

      if (!usuario) {
        // Supabase não configurado: funciona como sempre foi, só no aparelho.
        const locais = await carregarListasSalvas();
        if (!ativo) return;
        setListas(Array.isArray(locais) ? locais : []);
        setListasProntas(true);
        return;
      }

      // Logado: sincroniza com a nuvem (juntando o local nesta primeira carga).
      await sincronizarComNuvem(usuario.id, true);
      // Carrega as listas colaborativas e processa link de convite pendente.
      await recarregarColaborativas(usuario.id);
      const hash = typeof window !== "undefined" ? window.location.hash : "";
      const m = /#entrar=([A-Za-z0-9]+)/.exec(hash);
      if (m) {
        try {
          await entrarPorCodigo(m[1]);
          await recarregarColaborativas(usuario.id);
        } catch (e) {
          console.error("[Pitaco] convite:", e);
        }
        // Limpa o hash para não re-entrar a cada carga.
        if (typeof window !== "undefined" && window.history) {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      }
    })();
    return () => { ativo = false; };
  }, [sessaoPronta, usuario && usuario.id]);

  // Relê a nuvem sempre que o aparelho volta a ficar ativo (você troca de aba,
  // desbloqueia o celular, volta ao app). Sem reler, cada aparelho ficava preso
  // à cópia que carregou no login e sobrescrevia o outro.
  //
  // Ordem importa: se há uma gravação pendente (ex.: você acabou de apagar uma
  // lista e o envio de 600ms ainda não rodou), ENVIAMOS ela primeiro e só depois
  // relemos. Senão a releitura traria a versão antiga da nuvem de volta e
  // desfaria a exclusão — foi exatamente o "apaguei e voltou" que aconteceu.
  useEffect(() => {
    if (!usuario) return;
    async function aoVoltar() {
      if (document.visibilityState !== "visible") return;
      if (envioPendenteRef.current) {
        try {
          await salvarListasNaNuvem(usuario.id, listasRef.current);
          envioPendenteRef.current = false;
        } catch (e) {
          // Se a gravação pendente falhar, NÃO relemos: reler agora apagaria da
          // tela a mudança que ainda não conseguimos salvar.
          setFalhaNuvem(String(e.message || e));
          return;
        }
      }
      sincronizarComNuvem(usuario.id, false);
      recarregarColaborativas(usuario.id);
    }
    document.addEventListener("visibilitychange", aoVoltar);
    window.addEventListener("focus", aoVoltar);
    return () => {
      document.removeEventListener("visibilitychange", aoVoltar);
      window.removeEventListener("focus", aoVoltar);
    };
  }, [usuario && usuario.id]);

  // Tempo real: ouve cada lista colaborativa. Chega a LINHA inteira, então
  // itens, nome e permissão atualizam juntos. Entrada/saída de membro dispara
  // uma releitura da lista de membros. Reassina só quando o conjunto de listas
  // muda (não a cada filme adicionado).
  useEffect(() => {
    if (!usuario || compartilhadas.length === 0) return;
    const cancelamentos = compartilhadas.map((l) =>
      ouvirCompartilhada(
        l.id,
        (linha) => {
          if (linha === null) {
            // A lista foi apagada pelo dono enquanto eu estava com ela aberta.
            setCompartilhadas((prev) => prev.filter((x) => x.id !== l.id));
            return;
          }
          setCompartilhadas((prev) =>
            prev.map((x) => (x.id === l.id ? { ...x, ...linha } : x))
          );
        },
        () => recarregarMembros(l.id)
      )
    );
    return () => cancelamentos.forEach((c) => c && c());
  }, [usuario && usuario.id, compartilhadas.map((l) => l.id).join(",")]);

  // Rede de segurança do tempo real.
  //
  // Importante: isto roda mesmo quando a pessoa AINDA NÃO TEM nenhuma lista
  // compartilhada. Era exatamente esse o bug de "entrei pelo código e não
  // apareceu nada": quem tinha zero listas não tinha nem tempo real (a
  // assinatura é por lista) nem verificação periódica, então ficava preso até
  // recarregar a página na mão. Agora, quem acabou de ser convidado recebe a
  // lista em poucos segundos sozinho.
  useEffect(() => {
    if (!usuario) return;
    const intervalo = setInterval(() => {
      if (document.visibilityState === "visible") {
        recarregarColaborativas(usuario.id, false);
      }
    }, 4000);
    return () => clearInterval(intervalo);
  }, [usuario && usuario.id]);

  // Salva as mudanças. O aparelho recebe na hora (funciona offline e abre
  // rápido); a nuvem recebe com meio segundo de espera, para não disparar uma
  // gravação a cada clique — mas se a pessoa fechar a aba ou trocar de app
  // antes desse meio segundo passar, o envio agendado nunca chega a rodar, e
  // aquela mudança nunca vai para a nuvem (efeito: "salvei no computador e não
  // apareceu no celular"). Por isso, além do atraso normal, também forçamos o
  // envio imediato assim que a aba fica oculta ou a página é fechada.
  useEffect(() => {
    if (!listasProntas) return;
    salvarListasNoStorage(listas);
    if (!usuario) return;
    // Se estas listas acabaram de ser lidas da nuvem, não reenviamos: salvar
    // agora só devolveria o mesmo conteúdo e poderia atropelar uma gravação do
    // outro aparelho.
    if (vindoDaNuvemRef.current) {
      vindoDaNuvemRef.current = false;
      return;
    }
    envioPendenteRef.current = true;
    const t = setTimeout(() => {
      salvarListasNaNuvem(usuario.id, listas)
        .then(() => setFalhaNuvem(""))
        .catch((e) => {
          // Sem esse aviso, a gravação falha calada e a pessoa só descobre no
          // outro aparelho, quando o filme não está lá.
          setFalhaNuvem(String(e.message || e));
          console.error("[Pitaco] Falha ao salvar na nuvem:", e);
        })
        .finally(() => { envioPendenteRef.current = false; });
    }, 600);
    return () => clearTimeout(t);
  }, [listas, listasProntas, usuario && usuario.id]);

  // Salva as avaliações na nuvem (mesmo padrão das listas: atraso de 600ms para
  // não gravar a cada estrela clicada).
  useEffect(() => {
    if (!usuario) return;
    // Acabou de vir da nuvem: não reenvia.
    if (avaliacoesDaNuvemRef.current) {
      avaliacoesDaNuvemRef.current = false;
      return;
    }
    avaliacoesRef.current = avaliacoes;
    const t = setTimeout(() => {
      salvarAvaliacoesNaNuvem(usuario.id, avaliacoes).catch((e) => {
        console.error("[Pitaco] Falha ao salvar avaliações:", e);
      });
    }, 600);
    return () => clearTimeout(t);
  }, [avaliacoes, usuario && usuario.id]);

  // Rede de segurança: dispara o envio na hora, sem esperar o atraso, quando a
  // aba é minimizada, perde o foco ou está prestes a fechar.
  useEffect(() => {
    function forcarEnvio() {
      if (!envioPendenteRef.current) return;
      const uid = usuarioIdRef.current;
      if (!uid) return;
      salvarListasNaNuvem(uid, listasRef.current).catch(() => {});
      envioPendenteRef.current = false;
    }
    function aoMudarVisibilidade() {
      if (document.visibilityState === "hidden") forcarEnvio();
    }
    document.addEventListener("visibilitychange", aoMudarVisibilidade);
    window.addEventListener("pagehide", forcarEnvio);
    window.addEventListener("beforeunload", forcarEnvio);
    return () => {
      document.removeEventListener("visibilitychange", aoMudarVisibilidade);
      window.removeEventListener("pagehide", forcarEnvio);
      window.removeEventListener("beforeunload", forcarEnvio);
    };
  }, []);

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

  // Menu encolhe ao descer a página e volta ao tamanho normal ao subir.
  // Comparamos com a posição anterior a cada quadro; perto do topo fica sempre
  // normal, e ignoramos micro-movimentos para não ficar piscando.
  useEffect(() => {
    let ultimoY = window.scrollY || 0;
    let raf = 0;
    function aoRolar() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const y = window.scrollY || 0;
        const delta = y - ultimoY;
        if (Math.abs(delta) > 4) {
          if (y < 90) setNavCompacta(false);
          else setNavCompacta(delta > 0);
          ultimoY = y;
        }
      });
    }
    window.addEventListener("scroll", aoRolar, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", aoRolar);
    };
  }, []);

  // Busca por título com um respiro de 350ms depois da digitação, para não
  // disparar uma chamada por tecla.
  useEffect(() => {
    if (!buscaAberta) return;
    const limpo = termoBusca.trim();
    if (limpo.length < 2) {
      setResBusca([]);
      setBuscandoObras(false);
      return;
    }
    setBuscandoObras(true);
    let cancelado = false;
    const t = setTimeout(async () => {
      const achados = await buscarObras(limpo);
      if (cancelado) return;
      setResBusca(achados);
      setBuscandoObras(false);
    }, 350);
    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [termoBusca, buscaAberta]);

  // Esc fecha a busca; ao abrir, o campo já recebe o cursor.
  useEffect(() => {
    if (!buscaAberta) return;
    function aoTeclar(e) {
      if (e.key === "Escape") setBuscaAberta(false);
    }
    window.addEventListener("keydown", aoTeclar);
    const t = setTimeout(() => campoBuscaRef.current && campoBuscaRef.current.focus(), 60);
    return () => {
      window.removeEventListener("keydown", aoTeclar);
      clearTimeout(t);
    };
  }, [buscaAberta]);

  // Quando o Pitaco identifica o frame, rola até o resultado para a pessoa ver
  // que a resposta chegou (senão ela fica parada no formulário).
  useEffect(() => {
    if (!resId || carregandoId) return;
    const t = setTimeout(() => {
      if (resultadoIdRef.current) {
        resultadoIdRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 120);
    return () => clearTimeout(t);
  }, [resId, carregandoId]);

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

  // ------------------------- CONTA -----------------------------
  // As listas são o único recurso que exige conta. Descobrir, identificar e
  // buscar seguem livres para qualquer visitante.
  // Se o Supabase não estiver configurado, nada é bloqueado — senão um deploy
  // sem as variáveis deixaria as listas inacessíveis sem explicação.
  const listasLiberadas = !contaLigada || Boolean(usuario);

  // Chame antes de qualquer ação de lista. Devolve true quando a ação deve
  // PARAR (porque abrimos o convite para criar conta).
  function precisaDeConta(motivo) {
    if (listasLiberadas) return false;
    setMotivoConta(motivo || "Crie uma conta para guardar seus filmes.");
    setModoConta("criar");
    setErroConta("");
    setAvisoConta("");
    setContaAberta(true);
    return true;
  }

  function abrirConta(modo) {
    setModoConta(modo || "entrar");
    setMotivoConta("");
    setErroConta("");
    setAvisoConta("");
    setContaAberta(true);
  }

  async function enviarFormularioConta() {
    const email = emailConta.trim();
    const senha = senhaConta;
    setErroConta("");
    setAvisoConta("");

    if (!email || !senha) {
      setErroConta("Preencha e-mail e senha.");
      return;
    }
    if (!emailValido(email)) {
      const sugestao = sugestaoEmail(email);
      setErroConta(
        sugestao
          ? "Esse e-mail parece ter um erro. Você quis dizer " + sugestao + "?"
          : "Digite um e-mail válido, como voce@email.com."
      );
      return;
    }
    if (modoConta === "criar" && senha.length < 6) {
      setErroConta("A senha precisa ter pelo menos 6 caracteres.");
      return;
    }

    setOcupadoConta(true);
    try {
      if (modoConta === "criar") {
        const { precisaConfirmarEmail } = await criarConta(email, senha);
        if (precisaConfirmarEmail) {
          setAvisoConta(
            "Conta criada! Enviamos um link de confirmação para " +
              email +
              ". Confirme e depois entre por aqui."
          );
          setModoConta("entrar");
        } else {
          setContaAberta(false);
        }
      } else {
        await entrarNaConta(email, senha);
        setContaAberta(false);
      }
      setSenhaConta("");
    } catch (e) {
      setErroConta(String(e.message || e));
    } finally {
      setOcupadoConta(false);
    }
  }

  async function pedirNovaSenha() {
    const email = emailConta.trim();
    setErroConta("");
    setAvisoConta("");
    if (!email) {
      setErroConta("Escreva seu e-mail primeiro para eu enviar o link.");
      return;
    }
    setOcupadoConta(true);
    try {
      await recuperarSenha(email);
      setAvisoConta("Se existir conta com esse e-mail, o link de nova senha chegou nele.");
    } catch (e) {
      setErroConta(String(e.message || e));
    } finally {
      setOcupadoConta(false);
    }
  }

  async function sairELimpar() {
    await sairDaConta();
    setContaAberta(false);
    // As listas continuam no aparelho; a nuvem guarda a versão da conta.
  }

  // ----------------------- NAVEGAÇÃO ---------------------------
  function irPara(id) {    const alvo = document.getElementById("secao-" + id);
    if (alvo) alvo.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const totalSalvos = listas.reduce((soma, l) => soma + l.itens.length, 0);

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

  // Recomenda com base nas SUAS avaliações. Monta o prompt com o que você gostou
  // (4-5 estrelas) e o que não gostou (1-2), para o Gemini calibrar o gosto.
  async function recomendarPeloGosto() {
    if (avaliacoes.length === 0) {
      setErro("Avalie alguns filmes com as estrelas primeiro — aí eu recomendo no seu gosto.");
      return;
    }
    setErro("");
    setErroDetalhe("");
    setCarregando(true);
    setRecs([]);
    setJaSugeridos([]);
    setLinhaAberta(null);

    const amou = avaliacoes.filter((a) => a.nota >= 4).map((a) => a.titulo);
    const gostou = avaliacoes.filter((a) => a.nota === 3).map((a) => a.titulo);
    const naoGostou = avaliacoes.filter((a) => a.nota <= 2).map((a) => a.titulo);

    const linhas = [];
    if (amou.length) linhas.push(`Amou (nota alta): ${amou.join(", ")}.`);
    if (gostou.length) linhas.push(`Achou ok: ${gostou.join(", ")}.`);
    if (naoGostou.length) linhas.push(`Não gostou: ${naoGostou.join(", ")}.`);
    const jaAvaliados = avaliacoes.map((a) => a.titulo).join(", ");

    const prompt = `Você é um curador de cinema e séries para uma pessoa no Brasil.
Use as avaliações dela para entender o gosto e recomendar coisas novas parecidas com o que ela amou e diferentes do que ela não gostou.

${linhas.join("\n")}

NÃO recomende nada que ela já avaliou: ${jaAvaliados}.
Dê exatamente 4 recomendações variadas. Use o título conhecido no Brasil. Seja conciso: "sinopse" e "porque" com no máximo 15 palavras cada. No "porque", conecte com o gosto dela (ex.: "por gostar de X").

Responda SOMENTE com JSON válido, sem markdown, exatamente neste formato:
{"recomendacoes":[{"titulo":"...","ano":2014,"tipo":"filme ou série","generos":["...","..."],"sinopse":"frase curta","porque":"conexão com o gosto"}]}`;

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
      setRecs(novas);
      setJaSugeridos(novas.map((r) => r.titulo));
      setUltimoPedido("");
    } catch (e) {
      console.error(e);
      setErro("Não consegui montar as sugestões agora. Tente de novo em alguns segundos.");
      setErroDetalhe(String(e && e.message ? e.message : e).slice(0, 300));
    } finally {
      setCarregando(false);
    }
  }
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
    setErroIdDetalhe("");
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
      ], true, "identificar", 2000);

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
      setErroIdDetalhe(String(e && e.message ? e.message : e).slice(0, 300));
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
      sinopse: obra.sinopse || "",
      porque: obra.porque || "",
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

  // Nota atual de um filme (0 = não avaliado).
  function notaDe(obra) {
    const c = chaveObra(obra);
    const a = avaliacoes.find((x) => x.chave === c);
    return a ? a.nota : 0;
  }

  // Define a nota de um filme. nota 0 remove a avaliação.
  function avaliar(obra, nota) {
    const c = chaveObra(obra);
    setAvaliacoes((prev) => {
      const semEste = prev.filter((x) => x.chave !== c);
      if (!nota) return semEste;
      return [
        ...semEste,
        {
          chave: c,
          titulo: obra.titulo,
          ano: obra.ano || null,
          tipo: obra.tipo || "",
          nota,
          quando: Date.now(),
        },
      ];
    });
  }

  // ---------------- LISTAS COLABORATIVAS (em tempo real) ----------------
  // Regra de ouro daqui: nunca gravamos a lista inteira por cima. Adicionar e
  // remover passam por funções do banco que mexem em UM item de forma atômica,
  // então dois amigos editando junto não apagam o trabalho um do outro.

  // Apelido curto de quem está usando, para marcar quem adicionou cada título.
  const meuApelido = usuario && usuario.email
    ? String(usuario.email).split("@")[0]
    : "";

  function podeEditar(lista) {
    if (!lista || !usuario) return false;
    return !lista.somente_dono_edita || lista.dono === usuario.id;
  }
  function souDono(lista) {
    return Boolean(lista && usuario && lista.dono === usuario.id);
  }

  // Carrega as listas colaborativas de que sou membro.
  // comMembros=false é usado pela checagem periódica: só as listas, sem uma
  // consulta de membros por lista — mantém a verificação frequente barata.
  async function recarregarColaborativas(uid, comMembros = true) {
    if (!uid) { setCompartilhadas([]); setMembrosPorLista({}); return null; }
    try {
      const cs = await carregarCompartilhadas();

      // null = não deu para confiar na resposta (sessão renovando, token
      // vencido). Mantemos a tela como está e tentamos de novo no próximo ciclo.
      if (cs === null) return null;

      // Diagnóstico: se o servidor confirma a sessão e ainda assim não devolve
      // nenhuma lista que estava na tela, o problema é no banco (a filiação da
      // pessoa nessa lista não está valendo para a leitura). Deixamos o aviso
      // explícito para não voltar a ser um sumiço misterioso.
      if (cs.length === 0 && compartilhadasRef.current.length > 0) {
        console.warn(
          "[Pitaco] O servidor confirmou a sessão mas não devolveu nenhuma lista " +
          "compartilhada, embora houvesse " + compartilhadasRef.current.length +
          " na tela. Isso indica que a filiação no banco não está valendo para a leitura."
        );
      }

      setCompartilhadas((prev) => (mesmasListas(prev, cs) ? prev : cs));
      setErroCompart((e) => (e && e.startsWith("Não consegui carregar") ? "" : e));
      if (comMembros) carregarTodosMembros(cs);
      return cs;
    } catch (e) {
      setErroCompart("Não consegui carregar as listas: " + String(e.message || e));
      console.error("[Pitaco] Falha ao carregar colaborativas:", e);
      return null;
    }
  }

  // Busca os membros de várias listas em paralelo (falha em uma não derruba as
  // outras — o Promise.allSettled garante isso).
  async function carregarTodosMembros(listas) {
    if (!listas || listas.length === 0) return;
    const res = await Promise.allSettled(listas.map((l) => carregarMembros(l.id)));
    const mapa = {};
    listas.forEach((l, i) => {
      if (res[i].status === "fulfilled") mapa[l.id] = res[i].value;
    });
    setMembrosPorLista((prev) => ({ ...prev, ...mapa }));
  }

  async function recarregarMembros(listaId) {
    try {
      const ms = await carregarMembros(listaId);
      setMembrosPorLista((prev) => ({ ...prev, [listaId]: ms }));
    } catch (e) { /* silencioso: a lista em si continua utilizável */ }
  }

  // Cria a lista com nome e permissão escolhidos no modal.
  async function criarColaborativa() {
    if (precisaDeConta("Crie uma conta para ter listas compartilhadas.")) return;
    const nome = nomeCompart.trim();
    if (!nome) {
      setErroCompart("Dê um nome para a lista.");
      return;
    }
    setErroCompart("");
    setOcupadoCompart(true);
    try {
      const nova = await criarListaCompartilhada(usuario.id, nome, {
        somenteDonoEdita: soDonoEdita,
        itens: [],
      });
      setCompartilhadas((prev) => [...prev, nova]);
      recarregarMembros(nova.id);
      setCriarAberto(false);
      setNomeCompart("");
      setSoDonoEdita(false);
      setPainelCompartilhar(nova); // já abre o convite com código e link
    } catch (e) {
      setErroCompart(String(e.message || e));
    } finally {
      setOcupadoCompart(false);
    }
  }

  // Entra numa lista pelo código digitado.
  async function entrarNaColaborativa() {
    if (precisaDeConta("Crie uma conta para entrar numa lista compartilhada.")) return;
    const cod = codigoEntrar.trim();
    if (cod.length < 4) {
      setErroCompart("Digite o código que seu amigo te passou.");
      return;
    }
    setErroCompart("");
    setOcupadoCompart(true);
    try {
      const listaId = await entrarPorCodigo(cod);
      // Às vezes a filiação leva um instante para valer na leitura. Em vez de
      // desistir na primeira tentativa, tentamos algumas vezes com uma pausa
      // curta — para quem entra, a lista simplesmente aparece.
      let entrou = false;
      for (let tentativa = 0; tentativa < 4 && !entrou; tentativa++) {
        if (tentativa > 0) await esperar(500);
        const cs = await recarregarColaborativas(usuario.id);
        entrou = Array.isArray(cs) && cs.some((l) => l.id === listaId);
      }
      if (!entrou) {
        setErroCompart(
          "Você entrou na lista, mas ela demorou a carregar. Ela deve aparecer em instantes."
        );
        return;
      }
      setEntrarAberto(false);
      setCodigoEntrar("");
    } catch (e) {
      setErroCompart(String(e.message || e));
    } finally {
      setOcupadoCompart(false);
    }
  }

  // Adiciona/remove um título numa lista compartilhada. O banco devolve a lista
  // de itens já resolvida, então a tela reflete exatamente o que ficou salvo.
  async function alternarNaColaborativa(lista, obra) {
    if (!podeEditar(lista)) {
      setErroCompart("Nesta lista só quem criou pode adicionar ou remover títulos.");
      return;
    }
    const existente = (lista.itens || []).find((i) => mesmaObra(i, obra));
    setErroCompart("");
    try {
      const itens = existente
        ? await removerItemCompartilhada(lista.id, existente.id)
        : await adicionarItemCompartilhada(lista.id, {
            ...paraItem(obra),
            por: meuApelido,
          });
      setCompartilhadas((prev) =>
        prev.map((l) => (l.id === lista.id ? { ...l, itens } : l))
      );
    } catch (e) {
      setErroCompart(String(e.message || e));
      recarregarColaborativas(usuario && usuario.id);
    }
  }

  async function removerDaColaborativa(lista, itemId) {
    if (!podeEditar(lista)) {
      setErroCompart("Nesta lista só quem criou pode remover títulos.");
      return;
    }
    try {
      const itens = await removerItemCompartilhada(lista.id, itemId);
      setCompartilhadas((prev) =>
        prev.map((l) => (l.id === lista.id ? { ...l, itens } : l))
      );
    } catch (e) {
      setErroCompart(String(e.message || e));
      recarregarColaborativas(usuario && usuario.id);
    }
  }

  // Dono liga/desliga "só eu edito".
  async function alternarPermissao(lista) {
    if (!souDono(lista)) return;
    const novo = !lista.somente_dono_edita;
    setCompartilhadas((prev) =>
      prev.map((l) => (l.id === lista.id ? { ...l, somente_dono_edita: novo } : l))
    );
    try {
      await definirPermissao(lista.id, novo);
    } catch (e) {
      setErroCompart(String(e.message || e));
      recarregarColaborativas(usuario && usuario.id);
    }
  }

  async function confirmarRenomear(lista) {
    const nome = nomeRenomear.trim();
    if (!nome) return;
    setCompartilhadas((prev) =>
      prev.map((l) => (l.id === lista.id ? { ...l, nome } : l))
    );
    setRenomeando(null);
    try {
      await renomearCompartilhada(lista.id, nome);
    } catch (e) {
      setErroCompart(String(e.message || e));
      recarregarColaborativas(usuario && usuario.id);
    }
  }

  async function tirarMembro(lista, userId) {
    try {
      await removerMembro(lista.id, userId);
      recarregarMembros(lista.id);
    } catch (e) {
      setErroCompart(String(e.message || e));
    }
  }

  async function sairOuApagarColaborativa(lista) {
    try {
      if (souDono(lista)) {
        await apagarCompartilhada(lista.id);
      } else {
        await sairDaCompartilhada(lista.id, usuario.id);
      }
      setCompartilhadas((prev) => prev.filter((l) => l.id !== lista.id));
      setPainelCompartilhar(null);
    } catch (e) {
      setErroCompart(String(e.message || e));
    }
  }

  function linkConvite(codigo) {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    return base + "/#entrar=" + codigo;
  }

  async function copiarConvite(lista) {
    const texto = linkConvite(lista.codigo);
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch (e) {
      // sem clipboard: o usuário copia manualmente do campo
    }
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

  function propsSalvar(chaveCard, obra) {
    return {
      obra,
      listas,
      // Só oferecemos as compartilhadas em que esta pessoa pode mesmo editar —
      // mostrar uma lista "só leitura" no menu levaria a um clique que falha.
      compartilhadas: compartilhadas.filter((l) => podeEditar(l)),
      usuarioId: usuario ? usuario.id : null,
      aberto: menuSalvar === chaveCard,
      salvo: obraSalva(obra),
      onAbrir: () => {
        if (precisaDeConta("Crie uma conta para guardar este título numa lista.")) return;
        setMenuSalvar(chaveCard);
        setNomeListaMenu("");
      },
      onFechar: () => { setMenuSalvar(null); setNomeListaMenu(""); },
      onAlternar: (listaId) => alternarNaLista(listaId, obra),
      onAlternarCompart: (lista) => alternarNaColaborativa(lista, obra),
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

      {/* menu flutuante de vidro — marca, busca e atalho para as listas */}
      <nav
        className={"navega vidro" + (navCompacta ? " compacta" : "")}
        aria-label="Navegação"
      >
        <button className="nav-marca" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          pitaco<i aria-hidden="true" />
        </button>
        <div className="nav-acoes">
          <button
            className="nav-botao"
            onClick={() => setBuscaAberta(true)}
            title="Pesquisar um título"
            aria-label="Pesquisar um título"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="M15.4 15.4 20 20" />
            </svg>
          </button>
          {contaLigada && (
            <button
              className={"nav-botao" + (usuario ? " logado" : "")}
              onClick={() => abrirConta("entrar")}
              title={usuario ? "Sua conta (" + usuario.email + ")" : "Entrar na sua conta"}
              aria-label={usuario ? "Sua conta" : "Entrar na sua conta"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle cx="12" cy="8.5" r="3.8" />
                <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
              </svg>
              {sincronizando && <i className="nav-sinc" aria-hidden="true" />}
            </button>
          )}
          <button
            className="nav-botao"
            onClick={() => irPara("listas")}
            title="Minhas listas"
            aria-label={
              "Minhas listas" + (totalSalvos > 0 ? " (" + totalSalvos + " salvos)" : "")
            }
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="4.5" cy="6.5" r="1.4" className="cheio" />
              <circle cx="4.5" cy="12" r="1.4" className="cheio" />
              <circle cx="4.5" cy="17.5" r="1.4" className="cheio" />
              <path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10" />
            </svg>
            {totalSalvos > 0 && <em>{totalSalvos}</em>}
          </button>
        </div>
      </nav>

      {/* painel de busca por título (abre pela lupa do menu) */}
      {buscaAberta && (
        <div
          className="busca-fundo"
          onClick={() => setBuscaAberta(false)}
          role="presentation"
        >
          <div
            className="busca-caixa vidro"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Pesquisar um título"
          >
            <div className="busca-topo">
              <svg className="busca-lupa" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M15.4 15.4 20 20" />
              </svg>
              <input
                ref={campoBuscaRef}
                className="busca-campo"
                type="text"
                value={termoBusca}
                onChange={(e) => setTermoBusca(e.target.value)}
                placeholder="nome do filme ou série…"
                aria-label="Nome do filme ou série"
              />
              <button
                className="busca-fechar"
                onClick={() => setBuscaAberta(false)}
                aria-label="Fechar busca"
              >
                ×
              </button>
            </div>

            <div className="busca-corpo">
              {termoBusca.trim().length < 2 ? (
                <p className="busca-aviso">digite ao menos duas letras para procurar.</p>
              ) : buscandoObras ? (
                <p className="busca-aviso">procurando…</p>
              ) : resBusca.length === 0 ? (
                <p className="busca-aviso">nada encontrado com esse nome.</p>
              ) : (
                <ul className="busca-lista">
                  {resBusca.map((o, i) => (
                    <li className="busca-item" key={o.titulo + i}>
                      <Poster obra={o} url={o.poster} classe="busca-poster" />
                      <div className="busca-info">
                        <p className="busca-titulo">{o.titulo}</p>
                        <p className="busca-meta">
                          {[o.ano, o.tipo].filter(Boolean).join(" · ")}
                        </p>
                        <div className="busca-acoes">
                          <button
                            className="busca-usar"
                            onClick={() => {
                              setBuscaAberta(false);
                              usarTendencia(o);
                            }}
                          >
                            pedir parecidos
                          </button>
                          <BotaoSalvar {...propsSalvar("busca-" + i, o)} variante="inline" />
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* modal de criar lista compartilhada: nome + quem pode editar */}
      {criarAberto && (
        <div className="busca-fundo" onClick={() => setCriarAberto(false)} role="presentation">
          <div
            className="conta-caixa vidro"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Criar lista compartilhada"
          >
            <button
              className="busca-fechar conta-fechar"
              onClick={() => setCriarAberto(false)}
              aria-label="Fechar"
            >
              ×
            </button>
            <p className="conta-etiqueta">nova lista compartilhada</p>

            <label className="conta-campo">
              <span>nome da lista</span>
              <input
                type="text"
                value={nomeCompart}
                onChange={(e) => setNomeCompart(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !ocupadoCompart) criarColaborativa();
                }}
                placeholder="ex.: maratona com a galera"
                maxLength={80}
                autoFocus
              />
            </label>

            <p className="conta-etiqueta" style={{ marginTop: 4 }}>quem pode editar</p>
            <div className="perm-opcoes" role="radiogroup" aria-label="Quem pode editar">
              <button
                role="radio"
                aria-checked={!soDonoEdita}
                className={"perm-opcao" + (!soDonoEdita ? " ativa" : "")}
                onClick={() => setSoDonoEdita(false)}
              >
                <span className="perm-titulo">todos editam</span>
                <span className="perm-desc">qualquer membro adiciona e remove</span>
              </button>
              <button
                role="radio"
                aria-checked={soDonoEdita}
                className={"perm-opcao" + (soDonoEdita ? " ativa" : "")}
                onClick={() => setSoDonoEdita(true)}
              >
                <span className="perm-titulo">só eu edito</span>
                <span className="perm-desc">os convidados só olham a lista</span>
              </button>
            </div>

            {erroCompart && <p className="conta-erro">{erroCompart}</p>}

            <button
              className="conta-botao principal"
              onClick={criarColaborativa}
              disabled={ocupadoCompart}
            >
              {ocupadoCompart ? "criando…" : "criar e convidar"}
            </button>
            <p className="conta-texto" style={{ fontSize: 12 }}>
              Você pode mudar a permissão depois, a qualquer momento.
            </p>
          </div>
        </div>
      )}

      {/* painel da lista compartilhada: código, link, membros e ajustes */}
      {painelCompartilhar && (() => {
        const lista =
          compartilhadas.find((l) => l.id === painelCompartilhar.id) || painelCompartilhar;
        const dono = souDono(lista);
        const membros = membrosPorLista[lista.id] || [];
        return (
        <div className="busca-fundo" onClick={() => setPainelCompartilhar(null)} role="presentation">
          <div
            className="conta-caixa vidro painel-lista"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={"Lista compartilhada " + lista.nome}
          >
            <button
              className="busca-fechar conta-fechar"
              onClick={() => setPainelCompartilhar(null)}
              aria-label="Fechar"
            >
              ×
            </button>

            <p className="conta-etiqueta">lista compartilhada</p>

            {/* Nome — o dono pode renomear ali mesmo */}
            {renomeando === lista.id ? (
              <div className="renomear-linha">
                <input
                  className="renomear-campo"
                  value={nomeRenomear}
                  onChange={(e) => setNomeRenomear(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmarRenomear(lista);
                    if (e.key === "Escape") setRenomeando(null);
                  }}
                  maxLength={80}
                  autoFocus
                />
                <button className="compart-mini" onClick={() => confirmarRenomear(lista)}>
                  salvar
                </button>
              </div>
            ) : (
              <div className="renomear-linha">
                <p className="conta-email">{lista.nome}</p>
                {dono && (
                  <button
                    className="compart-mini"
                    onClick={() => { setRenomeando(lista.id); setNomeRenomear(lista.nome); }}
                  >
                    renomear
                  </button>
                )}
              </div>
            )}

            {/* Convite: código e link */}
            <p className="conta-texto">
              Para convidar, mande o código ou o link. Quem entrar vira membro na hora.
            </p>

            <div className="convite-codigo">
              <span className="convite-codigo-valor">{lista.codigo}</span>
              <button
                className="compart-mini"
                onClick={() => {
                  try { navigator.clipboard.writeText(lista.codigo); } catch (e) {}
                  setCodigoCopiado(true);
                  setTimeout(() => setCodigoCopiado(false), 1800);
                }}
              >
                {codigoCopiado ? "copiado ✓" : "copiar código"}
              </button>
            </div>

            <button
              className="conta-botao principal"
              onClick={() => {
                const link = linkConvite(lista.codigo);
                try { navigator.clipboard.writeText(link); } catch (e) {}
                setLinkCopiado(true);
                setTimeout(() => setLinkCopiado(false), 1800);
              }}
            >
              {linkCopiado ? "link copiado ✓" : "copiar link do convite"}
            </button>

            {/* Membros */}
            <div className="membros-bloco">
              <p className="conta-etiqueta">
                membros {membros.length > 0 && "· " + membros.length}
              </p>
              {membros.length === 0 ? (
                <p className="membros-vazio">carregando…</p>
              ) : (
                <ul className="membros-lista">
                  {membros.map((m) => (
                    <li className="membro-item" key={m.user_id}>
                      <span className="membro-inicial" aria-hidden="true">
                        {(m.apelido || "?").charAt(0).toUpperCase()}
                      </span>
                      <span className="membro-nome">
                        {m.apelido}
                        {usuario && m.user_id === usuario.id && (
                          <em className="membro-voce">você</em>
                        )}
                      </span>
                      {m.e_dono ? (
                        <span className="membro-tag">criou</span>
                      ) : dono ? (
                        <button
                          className="membro-tirar"
                          onClick={() => tirarMembro(lista, m.user_id)}
                          title={"Remover " + m.apelido + " da lista"}
                        >
                          remover
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Permissão — só o dono muda */}
            {dono ? (
              <div className="membros-bloco">
                <p className="conta-etiqueta">quem pode editar</p>
                <div className="perm-opcoes" role="radiogroup" aria-label="Quem pode editar">
                  <button
                    role="radio"
                    aria-checked={!lista.somente_dono_edita}
                    className={"perm-opcao" + (!lista.somente_dono_edita ? " ativa" : "")}
                    onClick={() => { if (lista.somente_dono_edita) alternarPermissao(lista); }}
                  >
                    <span className="perm-titulo">todos editam</span>
                    <span className="perm-desc">qualquer membro adiciona e remove</span>
                  </button>
                  <button
                    role="radio"
                    aria-checked={Boolean(lista.somente_dono_edita)}
                    className={"perm-opcao" + (lista.somente_dono_edita ? " ativa" : "")}
                    onClick={() => { if (!lista.somente_dono_edita) alternarPermissao(lista); }}
                  >
                    <span className="perm-titulo">só eu edito</span>
                    <span className="perm-desc">os convidados só olham</span>
                  </button>
                </div>
              </div>
            ) : (
              <p className="membros-aviso">
                {lista.somente_dono_edita
                  ? "Nesta lista só quem criou pode adicionar ou remover títulos."
                  : "Todos os membros podem adicionar e remover títulos."}
              </p>
            )}

            {erroCompart && <p className="conta-erro">{erroCompart}</p>}

            <button
              className="conta-botao perigo"
              onClick={() => sairOuApagarColaborativa(lista)}
            >
              {dono ? "apagar esta lista" : "sair desta lista"}
            </button>
          </div>
        </div>
        );
      })()}

      {/* modal de entrar numa lista pelo código */}
      {entrarAberto && (
        <div className="busca-fundo" onClick={() => setEntrarAberto(false)} role="presentation">
          <div
            className="conta-caixa vidro"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Entrar por código"
          >
            <button
              className="busca-fechar conta-fechar"
              onClick={() => setEntrarAberto(false)}
              aria-label="Fechar"
            >
              ×
            </button>
            <p className="conta-etiqueta">entrar numa lista</p>
            <p className="conta-texto">Cole o código que seu amigo te passou.</p>

            <label className="conta-campo">
              <span>código</span>
              <input
                type="text"
                value={codigoEntrar}
                onChange={(e) => setCodigoEntrar(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !ocupadoCompart) entrarNaColaborativa();
                }}
                placeholder="ex.: 7F3K92"
                maxLength={8}
                autoFocus
              />
            </label>

            {erroCompart && <p className="conta-erro">{erroCompart}</p>}

            <button
              className="conta-botao principal"
              onClick={entrarNaColaborativa}
              disabled={ocupadoCompart}
            >
              {ocupadoCompart ? "entrando…" : "entrar na lista"}
            </button>
          </div>
        </div>
      )}

      {/* painel da conta: entrar / criar conta, ou ver quem já está dentro.
          Abre sozinho quando alguém tenta usar as listas sem estar logado. */}
      {contaAberta && (
        <div className="busca-fundo" onClick={() => setContaAberta(false)} role="presentation">
          <div
            className="conta-caixa vidro"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Sua conta"
          >
            <button
              className="busca-fechar conta-fechar"
              onClick={() => setContaAberta(false)}
              aria-label="Fechar"
            >
              ×
            </button>

            {usuario ? (
              <>
                <p className="conta-etiqueta">conectado como</p>
                <p className="conta-email">{usuario.email}</p>
                <p className="conta-texto">
                  Suas listas estão salvas na sua conta — é só entrar em outro
                  aparelho para encontrá-las lá.
                </p>
                <button className="conta-botao" onClick={sairELimpar}>
                  sair da conta
                </button>
              </>
            ) : (
              <>
                <div className="conta-abas" role="tablist">
                  <button
                    role="tab"
                    aria-selected={modoConta === "entrar"}
                    className={"conta-aba" + (modoConta === "entrar" ? " ativa" : "")}
                    onClick={() => { setModoConta("entrar"); setErroConta(""); setAvisoConta(""); }}
                  >
                    entrar
                  </button>
                  <button
                    role="tab"
                    aria-selected={modoConta === "criar"}
                    className={"conta-aba" + (modoConta === "criar" ? " ativa" : "")}
                    onClick={() => { setModoConta("criar"); setErroConta(""); setAvisoConta(""); }}
                  >
                    criar conta
                  </button>
                </div>

                {motivoConta ? (
                  <p className="conta-motivo">{motivoConta}</p>
                ) : (
                  <p className="conta-texto">
                    {modoConta === "criar"
                      ? "Crie uma conta para suas listas te acompanharem em qualquer aparelho."
                      : "Entre para reencontrar suas listas salvas."}
                  </p>
                )}

                <label className="conta-campo">
                  <span>e-mail</span>
                  <input
                    type="email"
                    autoComplete="email"
                    value={emailConta}
                    onChange={(e) => setEmailConta(e.target.value)}
                    placeholder="voce@email.com"
                  />
                </label>

                <label className="conta-campo">
                  <span>senha</span>
                  <input
                    type="password"
                    autoComplete={modoConta === "criar" ? "new-password" : "current-password"}
                    value={senhaConta}
                    onChange={(e) => setSenhaConta(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !ocupadoConta) enviarFormularioConta();
                    }}
                    placeholder={modoConta === "criar" ? "pelo menos 6 caracteres" : "sua senha"}
                  />
                </label>

                {erroConta && <p className="conta-erro">{erroConta}</p>}
                {avisoConta && <p className="conta-aviso">{avisoConta}</p>}

                <button
                  className="conta-botao principal"
                  onClick={enviarFormularioConta}
                  disabled={ocupadoConta}
                >
                  {ocupadoConta
                    ? "só um instante…"
                    : modoConta === "criar"
                    ? "criar minha conta"
                    : "entrar"}
                </button>

                {modoConta === "entrar" && (
                  <button className="conta-link" onClick={pedirNovaSenha} disabled={ocupadoConta}>
                    esqueci minha senha
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

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

          {avaliacoes.length > 0 && !carregando && (
            <div className="gosto-faixa" data-revelar>
              <button className="botao-gosto" onClick={recomendarPeloGosto}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.6 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
                </svg>
                recomendar no meu gosto
              </button>
              <span className="gosto-info">
                com base nos seus {avaliacoes.length} filmes avaliados
              </span>
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
                      {linhaAberta === i && (
                      <tr className="linha-detalhe">
                        <td colSpan={5}>
                          <div className="ficha">
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
                                <div className="ficha-acoes">
                                  <BotaoSalvar {...propsSalvar("rec-" + i, r)} />
                                  <Estrelas
                                    nota={notaDe(r)}
                                    liberado={listasLiberadas}
                                    onAvaliar={(n) => avaliar(r, n)}
                                    onPrecisaConta={() =>
                                      precisaDeConta("Crie uma conta para avaliar filmes e receber recomendações no seu gosto.")
                                    }
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                      )}
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
                {erroIdDetalhe && <p className="erro-detalhe">detalhe técnico: {erroIdDetalhe}</p>}
              </div>
            )}
          </div>
        </div>

        {resId && !carregandoId && (
          <div className="molde resultado-area" ref={resultadoIdRef}>
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
              {!listasLiberadas
                ? "Prateleiras do seu jeito — crie uma conta para começar."
                : totalSalvos === 0
                ? "Prateleiras do seu jeito — comece criando uma."
                : "Prateleiras do seu jeito — " + totalSalvos + " títulos guardados."}
            </p>
          </header>

          {falhaNuvem && listasLiberadas && (
            <div className="aviso-nuvem">
              <p className="aviso-nuvem-titulo">
                Suas listas não estão sincronizando entre aparelhos
              </p>
              <p className="aviso-nuvem-texto">
                Elas continuam salvas neste aparelho, mas não estão indo para a
                sua conta. Detalhe técnico: {falhaNuvem}
              </p>
            </div>
          )}

          {!listasLiberadas ? (
            <div className="convite-conta vidro" data-revelar>
              <p className="convite-titulo">Guarde o que você descobriu</p>
              <p className="convite-texto">
                As listas ficam salvas na sua conta, então acompanham você em
                qualquer aparelho. Descobrir e identificar continuam livres, sem
                precisar entrar.
              </p>
              <div className="convite-acoes">
                <button
                  className="botao-cheio"
                  onClick={() => {
                    setMotivoConta("");
                    setModoConta("criar");
                    setErroConta("");
                    setAvisoConta("");
                    setContaAberta(true);
                  }}
                >
                  criar minha conta
                </button>
                <button className="botao-vidro" onClick={() => abrirConta("entrar")}>
                  já tenho conta
                </button>
              </div>
            </div>
          ) : (
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
          )}

          {listasLiberadas && (
            <div className="compart-acoes" data-revelar>
              <button
                className="botao-vidro compart-btn"
                onClick={() => {
                  if (precisaDeConta("Crie uma conta para ter listas compartilhadas.")) return;
                  setErroCompart("");
                  setNomeCompart(nomeNovaLista.trim());
                  setSoDonoEdita(false);
                  setCriarAberto(true);
                }}
                disabled={ocupadoCompart}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="9" cy="8" r="3.2" />
                  <circle cx="17" cy="9.5" r="2.6" />
                  <path d="M3.5 19a5.5 5.5 0 0 1 11 0M14.5 15.5a4.5 4.5 0 0 1 6 3.5" />
                </svg>
                criar lista compartilhada
              </button>
              <button
                className="botao-vidro compart-btn"
                onClick={() => {
                  if (precisaDeConta("Crie uma conta para entrar numa lista compartilhada.")) return;
                  setErroCompart("");
                  setCodigoEntrar("");
                  setEntrarAberto(true);
                }}
              >
                entrar com um código
              </button>
            </div>
          )}

          {erroCompart && !entrarAberto && !painelCompartilhar && (
            <p className="compart-erro" data-revelar>{erroCompart}</p>
          )}

          {compartilhadas.length > 0 && (
            <div className="compart-lista" data-revelar>
              {compartilhadas.map((l) => (
                <article className="compart-card" key={l.id}>
                  <header className="compart-card-topo">
                    <div className="compart-card-info">
                      <span className="compart-tag">
                        compartilhada{souDono(l) ? " · sua" : ""}
                        {l.somente_dono_edita && (
                          <em className="compart-selo">
                            {souDono(l) ? "só você edita" : "só leitura"}
                          </em>
                        )}
                      </span>
                      <h3 className="compart-nome">{l.nome}</h3>
                      {(membrosPorLista[l.id] || []).length > 0 && (
                        <div className="compart-membros">
                          <span className="compart-avatares" aria-hidden="true">
                            {(membrosPorLista[l.id] || []).slice(0, 4).map((m) => (
                              <i key={m.user_id} title={m.apelido}>
                                {(m.apelido || "?").charAt(0).toUpperCase()}
                              </i>
                            ))}
                          </span>
                          <span className="compart-membros-txt">
                            {membrosPorLista[l.id].length}{" "}
                            {membrosPorLista[l.id].length === 1 ? "membro" : "membros"}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="compart-card-botoes">
                      <button
                        className="compart-mini"
                        onClick={() => { setErroCompart(""); setPainelCompartilhar(l); }}
                        title="Convidar, ver membros e ajustes"
                      >
                        gerenciar
                      </button>
                    </div>
                  </header>

                  {(l.itens || []).length === 0 ? (
                    <p className="compart-vazia">
                      {podeEditar(l)
                        ? "lista vazia — salve títulos com o “+ lista” e escolha esta lista."
                        : "lista vazia — quem criou ainda não adicionou títulos."}
                    </p>
                  ) : (
                    <div className="compart-grade">
                      {l.itens.map((item) => (
                        <figure className="caixa mini acesa compart-item" key={item.id}>
                          <Poster obra={item} url={posters[chaveObra(item)]} classe="caixa-img" />
                          <figcaption>
                            <span className="pi-titulo">{item.titulo}</span>
                            <span className="pi-meta">
                              {[item.ano, item.tipo].filter(Boolean).join(" · ")}
                            </span>
                          </figcaption>
                          {podeEditar(l) && (
                            <button
                              className="pi-remover"
                              aria-label={"Remover " + item.titulo}
                              onClick={() => removerDaColaborativa(l, item.id)}
                            >
                              ×
                            </button>
                          )}
                        </figure>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}

          {!listasLiberadas ? null : listas.length === 0 ? (
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
                  <>
                    <div className="prat-grade">
                      {l.itens.map((item, ii) => {
                        const chaveAberta = l.id + ":" + item.id;
                        const estaAberto = itemListaAberto === chaveAberta;
                        return (
                          <figure
                            className={"caixa mini acesa prat-item" + (estaAberto ? " prat-item-ativo" : "")}
                            key={item.id}
                            style={{ animationDelay: (ii % 8) * 0.06 + "s" }}
                            onClick={() =>
                              setItemListaAberto(estaAberto ? null : chaveAberta)
                            }
                            role="button"
                            tabIndex={0}
                            aria-expanded={estaAberto}
                          >
                            <Poster obra={item} url={posters[chaveObra(item)]} classe="caixa-img" />
                            {notaDe(item) > 0 && (
                              <span className="pi-nota" aria-label={"Sua nota: " + notaDe(item) + " de 5"}>
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.6 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
                                </svg>
                                {notaDe(item)}
                              </span>
                            )}
                            <figcaption>
                              <span className="pi-titulo">{item.titulo}</span>
                              <span className="pi-meta">
                                {[item.ano, item.tipo].filter(Boolean).join(" · ")}
                              </span>
                            </figcaption>
                            <button
                              className="pi-remover"
                              aria-label={"Remover " + item.titulo + " da lista"}
                              onClick={(e) => {
                                e.stopPropagation();
                                removerItem(l.id, item.id);
                              }}
                            >
                              ×
                            </button>
                          </figure>
                        );
                      })}
                    </div>

                    {/* Ficha expandida do item clicado — mesma da aba Descobrir */}
                    {l.itens.map((item) => {
                      const chaveAberta = l.id + ":" + item.id;
                      if (itemListaAberto !== chaveAberta) return null;
                      return (
                        <div className="ficha-lista" key={"ficha-" + item.id}>
                          <div className="ficha-grade">
                            <Poster obra={item} url={posters[chaveObra(item)]} classe="ficha-poster" />
                            <div className="ficha-texto">
                              <p className="ficha-meta">
                                {[
                                  item.ano,
                                  (item.tipo || "").toUpperCase(),
                                  (item.generos || []).slice(0, 3).join(" · ").toUpperCase(),
                                ]
                                  .filter(Boolean)
                                  .join("  ·  ")}
                              </p>
                              {item.sinopse && <p className="ficha-sinopse">{item.sinopse}</p>}
                              {item.porque && (
                                <p className="ficha-porque">
                                  <span>por que combina</span> {item.porque}
                                </p>
                              )}
                              {!item.sinopse && !item.porque && (
                                <p className="ficha-sinopse ficha-sem-info">
                                  Sem sinopse guardada para este título.
                                </p>
                              )}
                              <div className="ficha-lista-avaliar">
                                <span className="ficha-lista-avaliar-rotulo">sua nota</span>
                                <Estrelas
                                  nota={notaDe(item)}
                                  liberado={listasLiberadas}
                                  onAvaliar={(n) => avaliar(item, n)}
                                  onPrecisaConta={() =>
                                    precisaDeConta("Crie uma conta para avaliar filmes.")
                                  }
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
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
  transition: padding 0.28s ease, width 0.28s ease;
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
/* Ao rolar para baixo o menu encolhe — fica mais baixo E mais estreito; ao subir,
   volta ao normal. A largura compacta usa porcentagem da tela (e não
   calc(100% - 24px), que no celular travava na largura cheia e não encolhia
   nada). O piso de conteúdo é ~175px, então sobra folga até em telas de 320px. */
.navega.compacta {
  padding: 5px 6px 5px 14px;
  width: min(400px, 78%);
}
.navega.compacta .nav-marca { font-size: 12px; }
.navega.compacta .nav-marca i { width: 6px; height: 6px; }
.navega.compacta .nav-botao { width: 32px; height: 32px; }
.navega.compacta .nav-botao svg { width: 15px; height: 15px; }
.nav-marca, .nav-marca i, .nav-botao, .nav-botao svg {
  transition: font-size 0.28s ease, width 0.28s ease, height 0.28s ease,
              background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}
.nav-acoes { display: inline-flex; align-items: center; gap: 8px; }
/* Botões de ícone do menu (lupa e listas). */
.nav-botao {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 42px; height: 42px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.16);
  border-radius: 999px;
  color: rgba(246,243,236,0.75);
  cursor: pointer;
}
/* Ao passar o mouse, fica claro por dentro e o ícone escurece, mantendo o
   contraste sempre legível. */
.nav-botao:hover {
  background: var(--branco);
  border-color: var(--branco);
  color: var(--preto);
}
.nav-botao svg {
  width: 19px; height: 19px;
  fill: none;
  stroke: currentColor; stroke-width: 1.7; stroke-linecap: round;
}
.nav-botao svg .cheio { fill: currentColor; stroke: none; }
.nav-botao em {
  position: absolute; top: -3px; right: -3px;
  font-style: normal; font-family: 'Space Mono', monospace;
  font-size: 9px; line-height: 1;
  background: var(--vermelho); color: #fff;
  padding: 3px 5px; border-radius: 999px;
  border: 2px solid var(--preto);
}

/* Aviso quando a nuvem falha — precisa ser visível, senão a pessoa acha que a
   sincronização simplesmente não existe. */
.aviso-nuvem {
  max-width: 620px;
  padding: 16px 18px;
  margin-bottom: 18px;
  border-radius: 14px;
  background: rgba(230,57,43,0.14);
  border: 1px solid rgba(230,57,43,0.4);
  border-left: 3px solid var(--vermelho);
}
.aviso-nuvem-titulo {
  margin: 0 0 6px;
  font-weight: 700; font-size: 15px;
  color: #ffd7d2;
}
.aviso-nuvem-texto {
  margin: 0; font-size: 13px; line-height: 1.55;
  color: rgba(255,215,210,0.8);
  word-break: break-word;
}

/* Botão de recomendar pelo gosto (aparece quando há avaliações). */
.gosto-faixa {
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 12px; margin-top: 18px;
}
.botao-gosto {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: 'Space Mono', monospace;
  font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--preto);
  background: var(--luz);
  border: 1px solid var(--luz);
  padding: 11px 18px; border-radius: 999px; cursor: pointer;
  transition: filter 0.18s ease, transform 0.1s ease;
}
.botao-gosto:hover { filter: brightness(1.08); transform: translateY(-1px); }
.botao-gosto svg { width: 16px; height: 16px; fill: var(--preto); }
.gosto-info {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.06em;
  color: rgba(246,243,236,0.5);
}

/* Linha com o botão de salvar e as estrelas lado a lado. */
.ficha-acoes {
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 14px; margin-top: 4px;
}

/* Estrelas de avaliação. */
.estrelas { display: inline-flex; gap: 2px; align-items: center; }
.estrela {
  background: none; border: none; padding: 2px; cursor: pointer;
  line-height: 0;
}
.estrela svg {
  width: 22px; height: 22px;
  fill: none;
  stroke: rgba(246,243,236,0.4); stroke-width: 1.4;
  transition: fill 0.12s ease, stroke 0.12s ease, transform 0.1s ease;
}
.estrela:hover svg { transform: scale(1.15); }
.estrela.cheia svg { fill: var(--luz); stroke: var(--luz); }
/* Sobre fundo claro (papel), as estrelas vazias precisam de traço mais escuro. */
.papel .estrela svg { stroke: rgba(23,20,15,0.35); }
.papel .estrela.cheia svg { fill: #e0a740; stroke: #e0a740; }

/* Mensagem que explica por que a conta está sendo pedida naquele momento. */
.conta-motivo {
  margin: 0; font-size: 14px; line-height: 1.55;
  color: var(--luz);
  background: rgba(240,146,30,0.12);
  border: 1px solid rgba(240,146,30,0.3);
  border-left: 3px solid var(--ambar);
  padding: 12px 14px; border-radius: 12px;
}

/* Convite que ocupa o lugar da criação de listas para quem não entrou. */
.convite-conta {
  padding: 26px 24px;
  border-radius: 18px;
  display: grid; gap: 10px;
  max-width: 560px;
}
.convite-titulo {
  margin: 0; font-family: 'Archivo Black', sans-serif;
  font-size: clamp(20px, 3vw, 26px);
  letter-spacing: -0.01em; color: var(--branco);
}
.convite-texto {
  margin: 0; font-size: 14px; line-height: 1.6;
  color: rgba(246,243,236,0.62);
}
.convite-acoes {
  display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px;
}

/* ==================== LISTAS COMPARTILHADAS ================== */
.compart-acoes {
  display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px;
}
.compart-btn {
  display: inline-flex; align-items: center; gap: 8px;
}
.compart-btn svg {
  width: 17px; height: 17px;
  fill: none; stroke: currentColor; stroke-width: 1.6;
  stroke-linecap: round; stroke-linejoin: round;
}
.compart-erro {
  margin: 12px 0 0; font-size: 13px;
  color: #ffd7d2;
  background: rgba(230,57,43,0.14);
  border: 1px solid rgba(230,57,43,0.4);
  padding: 10px 12px; border-radius: 12px; max-width: 560px;
}
.compart-lista { display: grid; gap: 18px; margin-top: 24px; }
.compart-card {
  padding: 18px 20px; border-radius: 16px;
  background: linear-gradient(150deg, rgba(240,146,30,0.08), rgba(24,19,15,0.4));
  border: 1px solid rgba(240,146,30,0.25);
}
.compart-card-topo {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; margin-bottom: 14px;
}
.compart-tag {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--luz);
}
.compart-nome {
  margin: 4px 0 0; font-family: 'Archivo Black', sans-serif;
  font-size: clamp(20px, 3vw, 28px); color: var(--branco);
}
.compart-card-botoes { display: flex; gap: 8px; flex: none; }
.compart-mini {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(246,243,236,0.8);
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.2);
  padding: 8px 12px; border-radius: 999px; cursor: pointer;
  transition: background 0.18s ease;
}
.compart-mini:hover { background: rgba(255,255,255,0.14); }
.compart-mini.perigo { color: #ffb9b2; border-color: rgba(230,57,43,0.4); }
.compart-mini.perigo:hover { background: rgba(230,57,43,0.18); }
.compart-vazia {
  margin: 0; font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.06em;
  color: rgba(246,243,236,0.45);
}
.compart-grade { display: flex; flex-wrap: wrap; gap: 16px; }
.compart-item { position: relative; width: 110px; }

/* ---- membros, permissão e painel de gerenciar ---- */
.compart-card-info { min-width: 0; }
.compart-selo {
  font-style: normal;
  margin-left: 8px; padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.2);
  color: rgba(246,243,236,0.75);
  font-size: 9px;
}
.compart-membros {
  display: flex; align-items: center; gap: 8px; margin-top: 8px;
}
.compart-avatares { display: inline-flex; }
.compart-avatares i {
  width: 24px; height: 24px; border-radius: 50%;
  display: inline-grid; place-items: center;
  font-style: normal; font-family: 'Space Mono', monospace;
  font-size: 11px; font-weight: 700;
  background: var(--ambar); color: #1a1305;
  border: 2px solid var(--preto);
  margin-left: -7px;
}
.compart-avatares i:first-child { margin-left: 0; }
.compart-membros-txt {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(246,243,236,0.5);
}
.painel-lista { max-height: 100%; overflow-y: auto; }
.renomear-linha {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.renomear-linha .conta-email { flex: 1; min-width: 0; }
.renomear-campo {
  flex: 1; min-width: 140px;
  background: rgba(0,0,0,0.28);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 10px;
  color: var(--branco);
  font-family: 'Archivo', sans-serif; font-size: 16px; font-weight: 700;
  padding: 9px 11px;
}
.membros-bloco {
  border-top: 1px dashed rgba(255,255,255,0.16);
  padding-top: 12px; margin-top: 4px;
  display: grid; gap: 8px;
}
.membros-vazio {
  margin: 0; font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(246,243,236,0.4);
}
.membros-lista { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.membro-item {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 8px; border-radius: 10px;
  background: rgba(255,255,255,0.04);
}
.membro-inicial {
  width: 28px; height: 28px; border-radius: 50%; flex: none;
  display: grid; place-items: center;
  font-family: 'Space Mono', monospace; font-size: 12px; font-weight: 700;
  background: var(--ambar); color: #1a1305;
}
.membro-nome {
  flex: 1; min-width: 0;
  font-size: 14px; color: var(--branco);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.membro-voce {
  font-style: normal; margin-left: 6px;
  font-family: 'Space Mono', monospace; font-size: 9px;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(246,243,236,0.45);
}
.membro-tag {
  font-family: 'Space Mono', monospace; font-size: 9px;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--luz); flex: none;
}
.membro-tirar {
  flex: none; cursor: pointer;
  font-family: 'Space Mono', monospace; font-size: 9px;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(255,185,178,0.9);
  background: none; border: 1px solid rgba(230,57,43,0.35);
  padding: 5px 9px; border-radius: 999px;
}
.membro-tirar:hover { background: rgba(230,57,43,0.18); color: #fff; }
.membros-aviso {
  margin: 0; font-size: 12.5px; line-height: 1.5;
  color: rgba(246,243,236,0.55);
  border-top: 1px dashed rgba(255,255,255,0.16);
  padding-top: 12px;
}
/* Opções de permissão (criar e gerenciar). */
.perm-opcoes { display: grid; gap: 8px; }
.perm-opcao {
  text-align: left; cursor: pointer;
  display: grid; gap: 2px;
  padding: 11px 13px; border-radius: 12px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.14);
  transition: background 0.18s ease, border-color 0.18s ease;
}
.perm-opcao:hover { background: rgba(255,255,255,0.09); }
.perm-opcao.ativa {
  background: rgba(240,146,30,0.14);
  border-color: rgba(240,146,30,0.55);
}
.perm-titulo {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--branco);
}
.perm-opcao.ativa .perm-titulo { color: var(--luz); }
.perm-desc { font-size: 12px; color: rgba(246,243,236,0.55); }
.conta-botao.perigo {
  background: rgba(230,57,43,0.14);
  border-color: rgba(230,57,43,0.4);
  color: #ffb9b2;
}
.conta-botao.perigo:hover { background: rgba(230,57,43,0.24); color: #fff; }

/* Painel de convite: código em destaque. */
.convite-codigo {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin: 4px 0 4px;
  padding: 12px 14px; border-radius: 12px;
  background: rgba(0,0,0,0.3);
  border: 1px dashed rgba(240,146,30,0.5);
}
.convite-codigo-valor {
  font-family: 'Space Mono', monospace;
  font-size: 26px; letter-spacing: 0.2em; font-weight: 700;
  color: var(--luz);
}

/* ======================== CONTA ============================== */
/* Bolinha no ícone quando há alguém logado, e pulso enquanto sincroniza. */
.nav-botao.logado { color: var(--branco); border-color: rgba(255,255,255,0.4); }
.nav-botao.logado:hover { color: var(--preto); }
.nav-sinc {
  position: absolute; bottom: -2px; right: -2px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--ambar);
  border: 2px solid var(--preto);
  animation: pulsoLuz 1.2s ease-in-out infinite;
}
.conta-caixa {
  position: relative;
  width: min(400px, 100%);
  align-self: flex-start;
  padding: 26px 24px 24px;
  border-radius: 20px;
  display: grid; gap: 12px;
  animation: brotarBusca 0.26s cubic-bezier(0.2, 1.1, 0.3, 1) both;
}
.conta-fechar { position: absolute; top: 10px; right: 10px; }
.conta-abas {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px; margin-bottom: 2px;
}
.conta-aba {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
  color: rgba(246,243,236,0.6);
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.14);
  padding: 10px 8px; border-radius: 999px; cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}
.conta-aba.ativa { background: var(--branco); color: var(--preto); border-color: var(--branco); }
.conta-texto {
  margin: 0; font-size: 13px; line-height: 1.55;
  color: rgba(246,243,236,0.65);
}
.conta-etiqueta {
  margin: 0; font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
  color: rgba(246,243,236,0.45);
}
.conta-email { margin: 0; font-weight: 700; font-size: 17px; color: var(--branco); }
.conta-campo { display: grid; gap: 5px; }
.conta-campo span {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(246,243,236,0.5);
}
.conta-campo input {
  background: rgba(0,0,0,0.28);
  border: 1px solid rgba(255,255,255,0.16);
  border-radius: 12px;
  color: var(--branco);
  font-family: 'Archivo', sans-serif; font-size: 15px;
  padding: 11px 13px;
}
.conta-campo input::placeholder { color: rgba(246,243,236,0.32); }
.conta-campo input:focus { outline: 2px solid var(--vermelho); outline-offset: 1px; }
.conta-botao {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--branco);
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.2);
  padding: 13px; border-radius: 999px; cursor: pointer;
  transition: filter 0.18s ease, background 0.18s ease;
}
.conta-botao:hover { background: rgba(255,255,255,0.14); }
.conta-botao.principal {
  background: var(--vermelho); border-color: var(--vermelho);
  margin-top: 4px;
}
.conta-botao.principal:hover { filter: brightness(1.12); }
.conta-botao:disabled { opacity: 0.6; cursor: default; }
.conta-link {
  background: none; border: none; cursor: pointer;
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(246,243,236,0.5);
  padding: 4px; justify-self: center;
}
.conta-link:hover { color: var(--branco); }
.conta-erro, .conta-aviso {
  margin: 0; font-size: 13px; line-height: 1.5;
  padding: 10px 12px; border-radius: 12px;
}
.conta-erro {
  color: #ffd7d2;
  background: rgba(230,57,43,0.16);
  border: 1px solid rgba(230,57,43,0.4);
}
.conta-aviso {
  color: var(--luz);
  background: rgba(240,146,30,0.14);
  border: 1px solid rgba(240,146,30,0.36);
}

/* ===================== BUSCA POR TÍTULO ====================== */
.busca-fundo {
  position: fixed; inset: 0; z-index: 120;
  background: rgba(6,5,4,0.72);
  backdrop-filter: blur(3px);
  display: flex; justify-content: center;
  padding: 84px 16px 24px;
  animation: surgirFundo 0.2s ease both;
}
@keyframes surgirFundo { from { opacity: 0; } to { opacity: 1; } }
.busca-caixa {
  width: min(620px, 100%);
  max-height: 100%;
  display: flex; flex-direction: column;
  border-radius: 20px;
  overflow: hidden;
  animation: brotarBusca 0.26s cubic-bezier(0.2, 1.1, 0.3, 1) both;
}
@keyframes brotarBusca {
  from { opacity: 0; transform: translateY(-10px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}
.busca-topo {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 14px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.12);
}
.busca-lupa {
  width: 18px; height: 18px; flex: none;
  fill: none; stroke: rgba(246,243,236,0.55);
  stroke-width: 1.7; stroke-linecap: round;
}
.busca-campo {
  flex: 1; min-width: 0;
  background: none; border: none;
  color: var(--branco);
  font-family: 'Archivo', sans-serif; font-size: 16px;
  padding: 6px 0;
}
.busca-campo::placeholder { color: rgba(246,243,236,0.4); }
.busca-fechar {
  flex: none;
  width: 30px; height: 30px;
  background: none; border: none; cursor: pointer;
  color: rgba(246,243,236,0.6);
  font-size: 22px; line-height: 1;
  border-radius: 999px;
}
.busca-fechar:hover { color: var(--branco); background: rgba(255,255,255,0.08); }
.busca-corpo { overflow-y: auto; padding: 6px 0 10px; }
.busca-aviso {
  font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(246,243,236,0.45);
  padding: 20px 18px; margin: 0;
}
.busca-lista { list-style: none; margin: 0; padding: 0; }
.busca-item {
  display: grid; grid-template-columns: 56px 1fr;
  gap: 14px; padding: 12px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.busca-item:last-child { border-bottom: none; }
.busca-poster { width: 56px; border-radius: 6px; }
.busca-info { min-width: 0; display: grid; gap: 4px; align-content: start; }
.busca-titulo {
  margin: 0; font-weight: 700; font-size: 16px;
  color: var(--branco);
}
.busca-meta {
  margin: 0; font-family: 'Space Mono', monospace;
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: rgba(246,243,236,0.5);
}
.busca-acoes {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin-top: 6px;
}
.busca-usar {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--branco);
  background: var(--vermelho); border: 1px solid var(--vermelho);
  padding: 7px 12px; border-radius: 999px; cursor: pointer;
  transition: filter 0.18s ease;
}
.busca-usar:hover { filter: brightness(1.12); }
/* Variante em fluxo do menu "salvar em": ocupa a largura do item e empurra o
   conteúdo abaixo, em vez de flutuar — assim a rolagem do painel de busca não
   corta o menu, que era o motivo de ele não caber aqui. */
.salvar-wrap.inline { display: block; width: 100%; }
.salvar-wrap.inline .menu-salvar {
  position: static;
  width: 100%;
  margin-top: 10px;
  box-shadow: none;
  border: 1px solid rgba(255,255,255,0.14);
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
/* A ficha só existe no DOM quando a linha está aberta (ver JSX), então nada de
   max-height/overflow: a altura é a do conteúdo real, sem sobra nem vão fantasma.
   O empilhamento fica NESTA div (e não no <tr>): position:relative em linha de
   tabela tem comportamento indefinido e no Safari do iPhone impedia o recolher,
   criando o espaço em branco entre as sugestões. */
.ficha {
  position: relative; z-index: 60;
  animation: abrirFicha 0.42s cubic-bezier(0.2, 0.9, 0.25, 1) both;
}
@keyframes abrirFicha {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: none; }
}
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
/* scroll-margin-top: ao rolar automaticamente até o resultado, deixa uma folga
   para o menu fixo não cobrir o topo da ficha. */
.resultado-area { padding-top: 64px; scroll-margin-top: 78px; }
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
  border-radius: 16px; z-index: 70;
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
.menu-subtitulo {
  font-family: 'Space Mono', monospace;
  font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--ambar);
  margin: 10px 0 4px; padding-top: 8px;
  border-top: 1px dashed rgba(255,255,255,0.14);
}
.menu-lista.compart .menu-nome { color: var(--luz); }
.menu-lista.compart .menu-check { color: var(--ambar); }
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
.prat-item { position: relative; width: 118px; cursor: pointer; }
.prat-item:hover { filter: brightness(1.12); transform: translateY(-4px); }
/* Miniatura aberta: contorno para indicar que a ficha abaixo é dela. */
.prat-item-ativo { filter: brightness(1.12); }
.prat-item-ativo .caixa-img {
  outline: 2px solid var(--vermelho);
  outline-offset: 2px;
}
/* Painel de ficha do item da lista — mesmo visual da ficha das sugestões, mas
   sobre o fundo escuro da seção Listas. Abre logo abaixo da grade. */
.ficha-lista {
  margin-top: 18px;
  padding: 20px;
  border-radius: 16px;
  background: linear-gradient(150deg, rgba(24,19,15,0.6), rgba(24,19,15,0.35));
  border: 1px solid rgba(255,255,255,0.12);
  animation: brotarMenu 0.3s cubic-bezier(0.2, 1.1, 0.3, 1) both;
}
.ficha-lista .ficha-grade { padding: 0; grid-template-columns: 120px 1fr; }
.ficha-lista .ficha-meta { color: var(--luz); }
.ficha-lista .ficha-sinopse { color: var(--branco); }
.ficha-lista .ficha-porque { color: rgba(246,243,236,0.75); }
/* Bloco de avaliar dentro da ficha do item da lista. */
.ficha-lista-avaliar {
  display: flex; align-items: center; gap: 12px;
  margin-top: 14px; padding-top: 14px;
  border-top: 1px solid rgba(255,255,255,0.1);
}
.ficha-lista-avaliar-rotulo {
  font-family: 'Space Mono', monospace;
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(246,243,236,0.5);
}
/* Selo de nota no canto da miniatura (aparece só quando avaliado). */
.pi-nota {
  position: absolute; top: 6px; left: 6px; z-index: 2;
  display: inline-flex; align-items: center; gap: 3px;
  font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 700;
  color: #1a1305;
  background: var(--luz);
  padding: 3px 7px 3px 5px; border-radius: 999px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4);
}
.pi-nota svg { width: 11px; height: 11px; fill: #1a1305; }
.ficha-sem-info { color: rgba(246,243,236,0.55); font-style: italic; }
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
  margin-top: 28px; padding-top: 26px;
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
  font-size: clamp(72px, 16vw, 220px);
  line-height: 0.78; letter-spacing: -0.03em;
  text-transform: uppercase; text-align: center;
  color: transparent;
  -webkit-text-stroke: 2px rgba(246,243,236,0.2);
  margin: 18px 0 -0.06em;
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
  .nav-botao { width: 38px; height: 38px; }
  .nav-botao svg { width: 17px; height: 17px; }
  .nav-acoes { gap: 6px; }
  .busca-fundo { padding: 72px 10px 16px; }
  .busca-item { grid-template-columns: 48px 1fr; gap: 12px; padding: 11px 13px; }
  .busca-poster { width: 48px; }
  .busca-titulo { font-size: 15px; }
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
  .ficha-grade { grid-template-columns: 92px 1fr; padding: 6px 14px 22px; gap: 14px; }
  .ficha-poster { width: 92px; }
  /* No mobile o menu "salvar em lista" precisa transbordar por cima das próximas
     sugestões, e encostar à esquerda para não vazar pela borda da tela. */
  .ficha { z-index: 200; }
  .menu-salvar {
    right: auto; left: 0;
    width: min(240px, calc(100vw - 40px));
    z-index: 210;
  }
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