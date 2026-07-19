// api/tmdb.js
// -----------------------------------------------------------------------------
// Serverless function (Vercel) que repassa buscas para o TMDB. A chave
// TMDB_API_KEY fica SÓ aqui no servidor, via variável de ambiente.
//
// O front chama, por exemplo:
//   /api/tmdb?rota=search/multi&language=pt-BR&query=matrix
//   /api/tmdb?rota=trending/all/week&language=pt-BR
//
// Só liberamos rotas conhecidas (lista branca) por segurança, e cacheamos a
// resposta na borda por algumas horas para economizar chamadas.
// -----------------------------------------------------------------------------

const ROTAS_PERMITIDAS = new Set(["search/multi", "trending/all/week"]);

export default async function handler(req, res) {
  const chave = process.env.TMDB_API_KEY;
  if (!chave) {
    return res.status(500).json({ error: "TMDB_API_KEY não configurada no servidor." });
  }

  const { rota, ...resto } = req.query;
  if (!rota || !ROTAS_PERMITIDAS.has(rota)) {
    return res.status(400).json({ error: "Rota não permitida." });
  }

  // Remonta os parâmetros extras (query, language, include_adult…) e injeta a chave.
  const params = new URLSearchParams();
  params.set("api_key", chave);
  for (const [k, v] of Object.entries(resto)) {
    if (v != null) params.set(k, Array.isArray(v) ? v[0] : v);
  }

  try {
    const url = "https://api.themoviedb.org/3/" + rota + "?" + params.toString();
    const resposta = await fetch(url);
    const dados = await resposta.json();

    // Cache na CDN da Vercel: 6h, revalidando em segundo plano por 1 dia.
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    return res.status(resposta.status).json(dados);
  } catch (e) {
    return res.status(500).json({ error: "Falha ao falar com o TMDB: " + e.message });
  }
}
