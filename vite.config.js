import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Em desenvolvimento (npm run dev), o Vite não roda as serverless
    // functions da pasta api/. Este proxy redireciona qualquer chamada a
    // /api para o site publicado na Vercel — assim a IA e os pôsteres
    // funcionam no localhost usando as functions (e as chaves) que já
    // estão no ar. Se o seu domínio mudar, atualize o target abaixo.
    proxy: {
      "/api": {
        target: "https://pitacov1.vercel.app",
        changeOrigin: true,
      },
    },
  },
});