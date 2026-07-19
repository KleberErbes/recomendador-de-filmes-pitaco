// api/recomendar.js
// -----------------------------------------------------------------------------
// Serverless function (Vercel) que repassa os pedidos do Pitaco para a API da
// Anthropic. A chave ANTHROPIC_API_KEY fica SÓ aqui no servidor, via variável
// de ambiente — nunca vai para o navegador.
//
// O front (Pitaco.jsx → chamarIA) manda { messages: [...] }, onde o conteúdo
// pode ser uma string (texto) OU um array de blocos (texto + imagem, usado na
// identificação por frame). Repassamos o campo messages inteiro.
// -----------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Use POST." } });
  }

  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) {
    return res
      .status(500)
      .json({ error: { message: "ANTHROPIC_API_KEY não configurada no servidor." } });
  }

  try {
    // Em algumas configurações o corpo já vem como objeto; em outras, como string.
    const corpo = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const messages = corpo.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: "Campo 'messages' ausente ou inválido." } });
    }

    const resposta = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": chave,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages,
      }),
    });

    const dados = await resposta.json();
    return res.status(resposta.status).json(dados);
  } catch (e) {
    return res.status(500).json({ error: { message: "Falha ao falar com a Anthropic: " + e.message } });
  }
}
