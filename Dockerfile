FROM node:20-slim

# Migração whatsapp-web.js -> Baileys (27/09/2026): o Baileys se conecta direto ao
# WhatsApp via WebSocket, sem abrir navegador nenhum — não precisamos mais instalar
# Chromium (nem ca-certificates/fonts que eram só pra ele) nessa imagem. Isso sozinho
# já tira ~300MB da imagem e elimina de vez o maior consumidor de RAM/CPU do container,
# essencial numa TV Box Armbian com só 787MB de RAM total. Node 20+ (em vez do 18
# anterior) porque o Baileys exige >=20.0.0 pra rodar de forma confiavel.

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3002

# Remove o entrypoint automático herdado da imagem base do Node: ele estava
# interceptando o "docker run <imagem> <comando>" e engolindo a saída/execução em
# alguns cenários. Rodar o node direto como processo principal é mais simples e
# também lida melhor com sinais de desligamento do container.
ENTRYPOINT []

# HEALTHCHECK (28/09/2026): bate na própria rota de status do bot a cada 30s. Sozinho
# isso só faz o Docker MARCAR o container como "unhealthy" (visível em "docker ps") —
# quem realmente reinicia é o serviço "autoheal" adicionado no docker-compose.yml, que
# fica de olho em containers marcados assim e dá restart neles automaticamente. Usamos
# "node -e" em vez de curl/wget porque essa imagem não tem nenhum dos dois instalado.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/bot/status', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
