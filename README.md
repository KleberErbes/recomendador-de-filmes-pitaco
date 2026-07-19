# Pitaco 🎬

Arquivo pessoal de cinema com IA: descubra filmes e séries por descrição,
identifique qualquer frame e monte listas do seu jeito.

Feito com **React + Vite**, com duas serverless functions que escondem as
chaves de API no servidor (Anthropic e TMDB).

---

## Como abrir na sua IDE

1. Abra a pasta `pitaco-app` inteira na sua IDE (VS Code: `File → Open Folder`).
2. O componente principal está em `src/Pitaco.jsx`.
   Não tente "abrir/rodar" só o `.jsx` — ele é parte de um projeto que roda
   com os comandos abaixo.

---

## Como rodar no seu computador

Você precisa do **Node.js 18 ou mais novo** instalado (https://nodejs.org).

Dentro da pasta do projeto, no terminal:

```bash
npm install       # baixa as dependências (só na primeira vez)
npm run dev       # inicia o servidor de desenvolvimento
```

Abra o endereço que aparecer (geralmente http://localhost:5173).

> **Sobre as chaves em ambiente local:** as functions da pasta `api/` só rodam
> automaticamente na Vercel. Para testá-las localmente do mesmo jeito que em
> produção, use `npm i -g vercel` e rode `vercel dev` no lugar de `npm run dev`
> — aí crie um arquivo `.env` (copie de `.env.example`) com as suas chaves.
> Sem isso, o site abre e funciona, mas as sugestões por IA e os pôsteres só
> respondem quando estiver publicado na Vercel com as variáveis configuradas.

---

## Como publicar na internet (Vercel)

1. **Suba para o GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Pitaco"
   git branch -M main
   git remote add origin https://github.com/KleberErbes/pitaco.git
   git push -u origin main
   ```
   (crie o repositório vazio antes no GitHub, sem README).

2. **Importe na Vercel:** entre em https://vercel.com → *Add New → Project* →
   escolha o repositório. Ela reconhece o Vite sozinha.

3. **Configure as chaves** em *Settings → Environment Variables*, adicionando:

   | Nome                | Valor                         |
   |---------------------|-------------------------------|
   | `ANTHROPIC_API_KEY` | sua chave da Anthropic        |
   | `TMDB_API_KEY`      | sua chave v3 do TMDB          |

4. Clique em **Deploy**. Em ~1 minuto sai uma URL pública tipo
   `pitaco.vercel.app`.

> Sempre que você der `git push`, a Vercel republica sozinha.

---

## Estrutura

```
pitaco-app/
├── api/
│   ├── recomendar.js   → proxy da Anthropic (chave no servidor)
│   └── tmdb.js         → proxy do TMDB (chave no servidor)
├── src/
│   ├── Pitaco.jsx      → o app inteiro (componente + estilos)
│   ├── main.jsx        → ponto de entrada do React
│   └── index.css       → reset mínimo
├── index.html
├── package.json
├── vite.config.js
├── .env.example        → modelo das variáveis de ambiente
└── .gitignore
```

---

## Desligar os pôsteres do TMDB

Se não quiser usar o TMDB, abra `src/Pitaco.jsx` e mude no topo:

```js
const TMDB_ATIVO = false;
```

O app continua funcionando — no lugar dos pôsteres aparecem caixas de luz
decorativas numeradas.
# recomendador-de-filmes-pitaco
