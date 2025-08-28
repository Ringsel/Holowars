
import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5173 },
  define: { 'import.meta.env.VITE_SERVER_URL': JSON.stringify(process.env.VITE_SERVER_URL || 'http://localhost:8787') }
})
