// api/recomendar.js
// -----------------------------------------------------------------------------
// Serverless function (Vercel) que repassa os pedidos do Pitaco para a API do
// Google Gemini. A chave GEMINI_API_KEY fica SÓ aqui no servidor, via variável
// de ambiente — nunca vai para o navegador.
//
// IMPORTANTE: o front (Pitaco.jsx) continua falando no MESMO formato de antes
// (estilo Anthropic): { messages: [{ role, content }] }, onde content pode ser
// uma string OU um array de blocos { type: "text" | "image", ... }. Aqui a
// gente TRADUZ esse formato para o formato do Gemini na ida, e TRADUZ a resposta
// do Gemini de volta para o formato { content: [{ type: "text", text }] } na
// volta — assim nada precisa mudar no front.
// -----------------------------------------------------------------------------

// Modelos do Gemini, em ordem de preferência. A function tenta o primeiro; se ele
// falhar por estar indisponível (ex.: no nível gratuito o 3.6 pode não estar
// liberado, ou o modelo pode retornar 404/403), cai automaticamente para o
// próximo. O gemini-2.5-flash é o fallback seguro que funciona no nível gratuito.
const MODELOS = ["gemini-3.6-flash", "gemini-2.5-flash"];

// Converte o array de mensagens estilo Anthropic para o formato "contents" do
// Gemini. O Gemini usa: { role: "user" | "model", parts: [{ text } | { inlineData }] }
function paraContentsGemini(messages) {
  return messages.map((msg) => {
    const role = msg.role === "assistant" ? "model" : "user";
    const conteudo = msg.content;

    // content como string simples → um único part de texto.
    if (typeof conteudo === "string") {
      return { role, parts: [{ text: conteudo }] };
    }

    // content como array de blocos (texto + imagem).
    const parts = (conteudo || []).map((bloco) => {
      if (bloco.type === "text") {
        return { text: bloco.text };
      }
      if (bloco.type === "image") {
        // Formato Anthropic: { type:"image", source:{ type:"base64", media_type, data } }
        const src = bloco.source || {};
        return {
          inlineData: {
            mimeType: src.media_type || "image/jpeg",
            data: src.data,
          },
        };
      }
      // Bloco desconhecido → ignora com um texto vazio seguro.
      return { text: "" };
    });

    return { role, parts };
  });
}

// Extrai o texto da resposta do Gemini e devolve no formato que o front espera:
// { content: [{ type: "text", text }] }
function paraRespostaAnthropic(dadosGemini) {
  const partes =
    dadosGemini?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean) || [];
  const texto = partes.join("\n");
  return { content: [{ type: "text", text: texto }] };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Use POST." } });
  }

  const chave = process.env.GEMINI_API_KEY;
  if (!chave) {
    return res
      .status(500)
      .json({ error: { message: "GEMINI_API_KEY não configurada no servidor." } });
  }

  try {
    // Em algumas configurações o corpo já vem como objeto; em outras, como string.
    const corpo = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const messages = corpo.messages;
    // Quando o front pede json:true, ativamos o modo JSON nativo do Gemini, que
    // força a saída a ser JSON puro (sem markdown, sem asteriscos, sem texto solto).
    const querJson = corpo.json === true;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: "Campo 'messages' ausente ou inválido." } });
    }

    const contents = paraContentsGemini(messages);
    const generationConfig = {
      maxOutputTokens: 1200,
      // Opcional (linha Gemini 3.x): controla o quanto o modelo "pensa" antes
      // de responder. Menos "pensamento" = mais rápido e barato. Descomente e
      // ajuste se quiser: "low" (rápido) | "medium" | "high" (mais elaborado).
      // thinkingConfig: { thinkingLevel: "low" },
    };
    if (querJson) {
      generationConfig.responseMimeType = "application/json";
    }
    const corpoGemini = JSON.stringify({ contents, generationConfig });

    let ultimoErro = { status: 500, message: "Nenhum modelo respondeu." };

    // Tenta cada modelo na ordem de preferência. Se um falhar por indisponibilidade
    // (404 modelo inexistente / 403 sem acesso), tenta o próximo. Outros erros
    // (ex.: 429 cota, 400 requisição) são repassados direto, pois trocar de modelo
    // não resolveria.
    for (const modelo of MODELOS) {
      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        modelo +
        ":generateContent";

      const resposta = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": chave,
        },
        body: corpoGemini,
      });

      const dados = await resposta.json();

      if (resposta.ok && !dados.error) {
        return res.status(200).json(paraRespostaAnthropic(dados));
      }

      const status = resposta.status;
      const msg = dados?.error?.message || `HTTP ${status}`;
      ultimoErro = { status, message: msg };

      // Só faz fallback quando o modelo não está disponível para esta chave.
      const modeloIndisponivel = status === 404 || status === 403;
      if (!modeloIndisponivel) break;
    }

    return res.status(ultimoErro.status).json({ error: { message: ultimoErro.message } });
  } catch (e) {
    return res.status(500).json({ error: { message: "Falha ao falar com o Gemini: " + e.message } });
  }
}