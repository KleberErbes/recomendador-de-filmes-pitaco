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
const URL_SUPABASE = env.VITE_SUPABASE_URL || "";
const CHAVE_SUPABASE = env.VITE_SUPABASE_ANON_KEY || "";

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

// ------------------------------- ERROS --------------------------------------

// O Supabase responde em inglês; aqui traduzimos os casos comuns para algo que
// a pessoa entenda. Mensagens desconhecidas passam como vieram.
function traduzErro(msg) {
  const m = (msg || "").toLowerCase();
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