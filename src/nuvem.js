// =============================================================================
// nuvem.js — conta do usuário e listas na nuvem (Supabase)
//
// Tudo que fala com o Supabase mora aqui, então o Pitaco.jsx continua cuidando
// só da tela. Se as variáveis de ambiente não estiverem configuradas, este
// módulo desliga sozinho e o app segue funcionando salvando no aparelho, como
// antes — nada quebra por falta de configuração.
// =============================================================================
import { createClient } from "@supabase/supabase-js";

// No Vite, variáveis que começam com VITE_ ficam disponíveis no navegador.
// A chave "anon" é pública de propósito: ela só permite o que as políticas de
// segurança (RLS) do banco autorizam — e lá cada pessoa só alcança a própria
// linha. Quem protege os dados é o banco, não o segredo da chave.
const env = (typeof import.meta !== "undefined" && import.meta.env) || {};

// Aceita a URL do projeto mesmo se vier com barra no fim ou com um caminho
// colado por engano (ex.: ".../rest/v1"). O Supabase recusa a chamada quando
// isso acontece, com a mensagem "Invalid path specified in request URL" — então
// normalizamos aqui para só sobrar "https://SEU-PROJETO.supabase.co".
function limparUrl(bruta) {
  const texto = (bruta || "").trim();
  if (!texto) return "";
  try {
    return new URL(texto).origin;
  } catch (e) {
    return texto.replace(/\/+$/, "");
  }
}

const URL_SUPABASE = limparUrl(env.VITE_SUPABASE_URL);
const CHAVE_SUPABASE = (env.VITE_SUPABASE_ANON_KEY || "").trim();

// Avisa no console se a configuração parecer trocada — poupa tempo de
// adivinhação quando algo não funciona.
if (typeof console !== "undefined") {
  if (URL_SUPABASE && !/^https:\/\/[^/]+\.supabase\.(co|in)$/.test(URL_SUPABASE)) {
    console.warn(
      "[Pitaco] VITE_SUPABASE_URL parece fora do padrão:",
      URL_SUPABASE,
      "— o esperado é algo como https://seu-projeto.supabase.co"
    );
  }
  if (CHAVE_SUPABASE.startsWith("sb_secret_")) {
    console.error(
      "[Pitaco] Você colocou a SECRET KEY no navegador. Troque pela publishable (sb_publishable_...)."
    );
  }
}

export const contaLigada = Boolean(URL_SUPABASE && CHAVE_SUPABASE);

export const supabase = contaLigada
  ? createClient(URL_SUPABASE, CHAVE_SUPABASE, {
      auth: {
        // Mantém a pessoa logada entre visitas e renova o token sozinho.
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;

const TABELA = "listas_usuario";

// ------------------------------- SESSÃO -------------------------------------

// Sessão atual (ou null). Usada uma vez ao abrir o app.
export async function pegarSessao() {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session || null;
  } catch (e) {
    return null;
  }
}

// Avisa sempre que a pessoa entra, sai ou o token é renovado.
// Devolve uma função para cancelar a inscrição.
export function aoMudarSessao(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_evento, sessao) => {
    callback(sessao || null);
  });
  return () => {
    try { data.subscription.unsubscribe(); } catch (e) {}
  };
}

export async function entrar(email, senha) {
  if (!supabase) throw new Error("Conta indisponível: configure o Supabase.");
  const { data, error } = await supabase.auth.signInWithPassword({
    email: (email || "").trim(),
    password: senha || "",
  });
  if (error) throw new Error(traduzErro(error.message));
  return data.session || null;
}

// Cria a conta. Atenção: se a confirmação de e-mail estiver ligada no painel do
// Supabase (padrão), aqui volta sessão nula e a pessoa só entra depois de
// clicar no link que chega por e-mail. Devolvemos essa informação para a tela
// conseguir explicar isso direitinho.
export async function criarConta(email, senha) {
  if (!supabase) throw new Error("Conta indisponível: configure o Supabase.");
  const { data, error } = await supabase.auth.signUp({
    email: (email || "").trim(),
    password: senha || "",
  });
  if (error) throw new Error(traduzErro(error.message));
  return {
    sessao: data.session || null,
    precisaConfirmarEmail: !data.session,
  };
}

export async function sair() {
  if (!supabase) return;
  try { await supabase.auth.signOut(); } catch (e) {}
}

export async function recuperarSenha(email) {
  if (!supabase) throw new Error("Conta indisponível: configure o Supabase.");
  const { error } = await supabase.auth.resetPasswordForEmail((email || "").trim());
  if (error) throw new Error(traduzErro(error.message));
}

// ------------------------------- LISTAS -------------------------------------

// Lê as listas do usuário. Devolve [] se ele ainda não tem linha no banco.
export async function carregarListasDaNuvem(userId) {
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from(TABELA)
    .select("dados")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Não consegui ler suas listas: " + error.message);
  const dados = data && data.dados;
  return Array.isArray(dados) ? dados : [];
}

// Grava as listas do usuário (cria a linha na primeira vez, atualiza depois).
export async function salvarListasNaNuvem(userId, listas) {
  if (!supabase || !userId) return;
  const { error } = await supabase
    .from(TABELA)
    .upsert(
      { user_id: userId, dados: listas || [] },
      { onConflict: "user_id" }
    );
  if (error) throw new Error("Não consegui salvar suas listas: " + error.message);
}

const TABELA_AVALIACOES = "avaliacoes_usuario";

// Lê as avaliações do usuário. Devolve [] se ele ainda não tem linha no banco.
export async function carregarAvaliacoesDaNuvem(userId) {
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from(TABELA_AVALIACOES)
    .select("dados")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Não consegui ler suas avaliações: " + error.message);
  const dados = data && data.dados;
  return Array.isArray(dados) ? dados : [];
}

// Grava as avaliações do usuário (cria a linha na primeira vez, atualiza depois).
export async function salvarAvaliacoesNaNuvem(userId, avaliacoes) {
  if (!supabase || !userId) return;
  const { error } = await supabase
    .from(TABELA_AVALIACOES)
    .upsert(
      { user_id: userId, dados: avaliacoes || [] },
      { onConflict: "user_id" }
    );
  if (error) throw new Error("Não consegui salvar suas avaliações: " + error.message);
}

// ------------------------------- ERROS --------------------------------------

// O Supabase responde em inglês; aqui traduzimos os casos comuns para algo que
// a pessoa entenda. Mensagens desconhecidas passam como vieram.
function traduzErro(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("invalid path specified")) {
    return "A URL do Supabase parece errada. Ela deve ser só https://seu-projeto.supabase.co (sem barra no final e sem caminho depois).";
  }
  if (m.includes("invalid api key") || m.includes("invalid jwt")) {
    return "A chave do Supabase parece errada. Use a publishable (sb_publishable_...).";
  }
  if (m.includes("invalid login credentials")) return "E-mail ou senha incorretos.";
  if (m.includes("email not confirmed")) {
    return "Confirme seu e-mail antes de entrar — o link está na sua caixa de entrada.";
  }
  if (m.includes("user already registered") || m.includes("already been registered")) {
    return "Já existe uma conta com esse e-mail. Tente entrar.";
  }
  if (m.includes("password should be at least")) {
    return "A senha precisa ter pelo menos 6 caracteres.";
  }
  if (m.includes("unable to validate email") || m.includes("invalid format")) {
    return "Esse e-mail não parece válido.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Muitas tentativas seguidas. Espere um minuto e tente de novo.";
  }
  if (m.includes("failed to fetch") || m.includes("network")) {
    return "Sem conexão com o servidor. Verifique sua internet.";
  }
  return msg || "Não deu certo. Tente de novo.";
}