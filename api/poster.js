// api/poster.js
// -----------------------------------------------------------------------------
// Serverless function (Vercel) que faz proxy dos pôsteres do TMDB pela NOSSA
// origem. Motivo: para exportar um canvas que contém imagens (o PNG de
// compartilhar listas), o navegador exige que as imagens venham da mesma origem
// OU com CORS impecável. Imagens carregadas antes sem crossOrigin "contaminam"
// o canvas e o toBlob falha — foi por isso que só aparecia a inicial no PNG.
//
// Servindo o pôster por aqui (/api/poster?path=/xxxx.jpg), ele passa a ser
// "mesma origem" e o canvas exporta sem erro.
//
// Segurança: só aceitamos caminhos de imagem do próprio TMDB (começam com "/" e
// terminam em .jpg/.png), e um tamanho da lista branca. Nada de URL arbitrária.
// -----------------------------------------------------------------------------

const TAMANHOS_PERMITIDOS = new Set(["w342", "w500", "w780", "original"]);

export default async function handler(req, res) {
  const { path, size } = req.query;
  const tamanho = TAMANHOS_PERMITIDOS.has(size) ? size : "w500";

  // Valida o caminho: precisa ser um path de imagem do TMDB, nada além disso.
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    !/^\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(path)
  ) {
    return res.status(400).json({ error: "Caminho de pôster inválido." });
  }

  try {
    const url = "https://image.tmdb.org/t/p/" + tamanho + path;
    const upstream = await fetch(url);

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Pôster não encontrado." });
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    // Cache forte na borda da Vercel: pôsteres não mudam.
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, s-maxage=604800, stale-while-revalidate=86400");
    // Mesma origem, mas deixamos o CORS explícito por garantia.
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(500).json({ error: "Falha ao buscar o pôster: " + e.message });
  }
}