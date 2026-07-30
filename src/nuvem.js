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

// Confere o código de 6 dígitos que chegou por e-mail ao criar a conta.
// Dando certo, a pessoa já entra (o Supabase devolve a sessão).
export async function verificarCodigo(email, codigo) {
  if (!supabase) throw new Error("Conta indisponível: configure o Supabase.");
  const limpo = (codigo || "").replace(/\D/g, "");
  if (limpo.length < 6) throw new Error("O código tem 6 números.");

  const { data, error } = await supabase.auth.verifyOtp({
    email: (email || "").trim(),
    token: limpo,
    type: "signup",
  });
  if (error) throw new Error(traduzErro(error.message));
  return data.session || null;
}

// Reenvia o código de confirmação para o mesmo e-mail.
export async function reenviarCodigo(email) {
  if (!supabase) throw new Error("Conta indisponível: configure o Supabase.");
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: (email || "").trim(),
  });
  if (error) throw new Error(traduzErro(error.message));
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

// ---------------------- LISTAS COMPARTILHADAS -------------------------------

// Gera um código curto e legível para convite (sem caracteres ambíguos como
// 0/O, 1/I). 6 caracteres dão ~1 bilhão de combinações — colisão é improvável,
// mas mesmo assim tentamos de novo se o banco recusar por duplicidade.
function gerarCodigo() {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) {
    c += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  }
  return c;
}

// Cria uma lista compartilhada e já entra o dono como membro. Devolve a lista.
// Cria uma lista compartilhada e já entra o dono como membro.
// opcoes: { somenteDonoEdita: boolean, itens: [] }
export async function criarListaCompartilhada(userId, nome, opcoes) {
  if (!supabase || !userId) throw new Error("Conta indisponível.");
  const op = opcoes || {};
  const limpo = (nome || "").trim().slice(0, 80);
  if (!limpo) throw new Error("Dê um nome para a lista.");

  // Caminho rápido: uma única chamada que cria a lista, entra o dono como
  // membro e devolve a linha pronta — tudo na mesma transação.
  const { data, error } = await supabase.rpc("criar_lista_compartilhada", {
    p_nome: limpo,
    p_somente_dono_edita: Boolean(op.somenteDonoEdita),
    p_itens: Array.isArray(op.itens) ? op.itens : [],
  });

  if (!error && data) {
    // O Supabase devolve objeto ou array de um item, dependendo da versão.
    return Array.isArray(data) ? data[0] : data;
  }

  // Se a função ainda não existe no banco (SQL v3 não rodado), cai no caminho
  // antigo em vez de simplesmente falhar.
  const semFuncao =
    error &&
    (error.code === "PGRST202" ||
      /could not find the function|does not exist/i.test(error.message || ""));
  if (!semFuncao) {
    throw new Error("Não consegui criar a lista: " + (error?.message || "erro desconhecido"));
  }
  return await criarListaModoAntigo(userId, limpo, op);
}

// Caminho antigo (três etapas). Fica como reserva para quem ainda não rodou o
// SQL v3 — assim o app não quebra durante a atualização.
async function criarListaModoAntigo(userId, nome, op) {
  let ultimaFalha = null;
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const codigo = gerarCodigo();
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "l-" + Date.now() + "-" + Math.random().toString(16).slice(2);

    const novaLista = {
      id,
      nome,
      codigo,
      dono: userId,
      itens: Array.isArray(op.itens) ? op.itens : [],
      somente_dono_edita: Boolean(op.somenteDonoEdita),
    };

    const { error } = await supabase.from("listas_compartilhadas").insert(novaLista);
    if (error) {
      if (error.code === "23505") { ultimaFalha = error; continue; }
      throw new Error("Não consegui criar a lista: " + error.message);
    }

    const { error: erroMembro } = await supabase
      .from("membros_lista")
      .insert({ lista_id: id, user_id: userId });
    if (erroMembro && !String(erroMembro.message || "").includes("duplicate")) {
      throw new Error("Lista criada, mas não consegui te adicionar: " + erroMembro.message);
    }
    return novaLista;
  }
  throw new Error("Não consegui gerar um código único: " + (ultimaFalha?.message || ""));
}

// Entra numa lista pelo código. A função do banco valida o código e insere a
// filiação — inclusive quando a pessoa ainda não pode ler a lista.
export async function entrarPorCodigo(codigo) {
  if (!supabase) throw new Error("Conta indisponível.");
  const limpo = (codigo || "").trim().toUpperCase();
  if (limpo.length < 4) throw new Error("Código muito curto.");
  const { data, error } = await supabase.rpc("entrar_por_codigo", { p_codigo: limpo });
  if (error) {
    const m = (error.message || "").toLowerCase();
    if (m.includes("não encontrado") || m.includes("nao encontrado")) {
      throw new Error("Código não encontrado. Confira as letras e tente de novo.");
    }
    if (m.includes("logado")) throw new Error("Entre na sua conta antes de usar o código.");
    throw new Error(error.message);
  }
  return data; // id da lista
}

// Todas as listas compartilhadas de que sou membro (a política de leitura já
// filtra: só volta o que é meu).
//
// Devolve:
//   • um array  → resultado confiável (pode estar vazio de verdade)
//   • null      → NÃO deu para confiar (sessão indisponível/expirada). Quem
//                 chamou deve manter o que já está na tela.
//
// Por que essa distinção existe: se o token estiver expirado ou renovando, o
// banco não reconhece o usuário e a consulta volta VAZIA sem erro nenhum. Sem
// separar "vazio de verdade" de "não consegui saber", o app apagava as listas
// da tela achando que a pessoa não tinha nenhuma.
export async function carregarCompartilhadas() {
  if (!supabase) return [];

  // 1) Garante um token válido antes de perguntar. getSession() renova sozinho
  //    quando está perto de expirar.
  const { data: s } = await supabase.auth.getSession();
  const sessao = s && s.session;
  if (!sessao) return null;

  // 2) Se o token já venceu, força a renovação antes de consultar.
  const agora = Math.floor(Date.now() / 1000);
  if (sessao.expires_at && sessao.expires_at <= agora + 5) {
    const { data: nova, error: erroRenova } = await supabase.auth.refreshSession();
    if (erroRenova || !nova || !nova.session) return null;
  }

  // 3) Busca pela função do banco, que confere a filiação por dentro. É o
  //    caminho confiável: não depende da política de leitura da tabela, que
  //    estava deixando as listas sumirem ao recarregar a página.
  const { data, error } = await supabase.rpc("minhas_listas_compartilhadas");

  if (!error) {
    const listas = data || [];
    if (listas.length === 0) {
      // Confirma que a sessão vale mesmo antes de afirmar "não tem listas".
      try {
        const { data: u, error: erroUser } = await supabase.auth.getUser();
        if (erroUser || !u || !u.user) return null;
      } catch (e) {
        return null;
      }
    }
    return listas;
  }

  // 4) Reserva: se a função ainda não existe no banco (SQL v4 não rodado),
  //    tenta o caminho antigo para o app não ficar sem listas.
  const semFuncao =
    error.code === "PGRST202" ||
    /could not find the function|does not exist/i.test(error.message || "");
  if (!semFuncao) {
    throw new Error("Não consegui carregar as listas compartilhadas: " + error.message);
  }

  const { data: dados2, error: erro2 } = await supabase
    .from("listas_compartilhadas")
    .select("*")
    .order("criado_em", { ascending: true });
  if (erro2) throw new Error("Não consegui carregar as listas compartilhadas: " + erro2.message);

  const listas2 = dados2 || [];
  if (listas2.length === 0) {
    try {
      const { data: u, error: erroUser } = await supabase.auth.getUser();
      if (erroUser || !u || !u.user) return null;
    } catch (e) {
      return null;
    }
  }
  return listas2;
}

// Quem participa de uma lista. Devolve [{ user_id, apelido, entrou_em, e_dono }].
export async function carregarMembros(listaId) {
  if (!supabase || !listaId) return [];
  const { data, error } = await supabase.rpc("membros_da_lista", { p_lista: listaId });
  if (error) throw new Error("Não consegui ver os membros: " + error.message);
  return data || [];
}

// Adiciona UM item. O banco resolve tudo numa operação só, então dois amigos
// adicionando ao mesmo tempo não se sobrescrevem. Devolve a lista de itens
// já atualizada.
export async function adicionarItemCompartilhada(listaId, item) {
  if (!supabase || !listaId) throw new Error("Lista indisponível.");
  const { data, error } = await supabase.rpc("item_add", {
    p_lista: listaId,
    p_item: item,
  });
  if (error) throw new Error(traduzErro(error.message));
  return Array.isArray(data) ? data : [];
}

// Remove UM item pelo id, também de forma atômica.
export async function removerItemCompartilhada(listaId, itemId) {
  if (!supabase || !listaId) throw new Error("Lista indisponível.");
  const { data, error } = await supabase.rpc("item_remove", {
    p_lista: listaId,
    p_item_id: String(itemId),
  });
  if (error) throw new Error(traduzErro(error.message));
  return Array.isArray(data) ? data : [];
}

// Liga/desliga "só o dono edita".
export async function definirPermissao(listaId, somenteDonoEdita) {
  if (!supabase || !listaId) return;
  const { error } = await supabase
    .from("listas_compartilhadas")
    .update({ somente_dono_edita: Boolean(somenteDonoEdita) })
    .eq("id", listaId);
  if (error) throw new Error("Não consegui mudar a permissão: " + error.message);
}

// Renomeia a lista.
export async function renomearCompartilhada(listaId, nome) {
  if (!supabase || !listaId) return;
  const limpo = (nome || "").trim().slice(0, 80);
  if (!limpo) throw new Error("O nome não pode ficar vazio.");
  const { error } = await supabase
    .from("listas_compartilhadas")
    .update({ nome: limpo })
    .eq("id", listaId);
  if (error) throw new Error("Não consegui renomear: " + error.message);
}

// O dono remove alguém da lista.
export async function removerMembro(listaId, userId) {
  if (!supabase || !listaId || !userId) return;
  const { error } = await supabase.rpc("remover_membro", {
    p_lista: listaId,
    p_user: userId,
  });
  if (error) throw new Error(error.message);
}

// Sair de uma lista (apaga a própria filiação).
export async function sairDaCompartilhada(listaId, userId) {
  if (!supabase || !listaId || !userId) return;
  const { error } = await supabase
    .from("membros_lista")
    .delete()
    .eq("lista_id", listaId)
    .eq("user_id", userId);
  if (error) throw new Error("Não consegui sair da lista: " + error.message);
}

// Apagar a lista inteira (só o dono, por política do banco).
export async function apagarCompartilhada(listaId) {
  if (!supabase || !listaId) return;
  const { error } = await supabase.from("listas_compartilhadas").delete().eq("id", listaId);
  if (error) throw new Error("Não consegui apagar a lista: " + error.message);
}

// Escuta uma lista ao vivo: mudanças nos itens/nome/permissão e entrada ou
// saída de membros. Devolve uma função para cancelar a assinatura.
export function ouvirCompartilhada(listaId, aoMudarLista, aoMudarMembros) {
  if (!supabase || !listaId) return () => {};
  const canal = supabase
    .channel("lista-" + listaId)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "listas_compartilhadas",
        filter: "id=eq." + listaId,
      },
      (payload) => {
        if (payload.eventType === "DELETE") {
          aoMudarLista && aoMudarLista(null);
          return;
        }
        if (payload.new) aoMudarLista && aoMudarLista(payload.new);
      }
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "membros_lista",
        filter: "lista_id=eq." + listaId,
      },
      () => { aoMudarMembros && aoMudarMembros(); }
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(canal); } catch (e) {}
  };
}

// ------------------------------- ERROS --------------------------------------

// O Supabase responde em inglês; aqui traduzimos os casos comuns para algo que
// a pessoa entenda. Mensagens desconhecidas passam como vieram.
function traduzErro(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("token has expired") || m.includes("otp_expired")) {
    return "Esse código expirou. Peça um novo abaixo.";
  }
  if (m.includes("token not found") || (m.includes("invalid") && m.includes("token")) ||
      (m.includes("invalid") && m.includes("otp"))) {
    return "Código incorreto. Confira os números e tente de novo.";
  }
  if (m.includes("permissão para editar") || m.includes("permissao para editar")) {
    return "Nesta lista só quem criou pode adicionar ou remover títulos.";
  }
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