FROM node:18-slim

# Evita baixar o Chromium duas vezes: o pacote "chromium" do Debian abaixo já instala um
# Chromium completo e funcional, então avisamos o Puppeteer (usado por baixo do
# whatsapp-web.js) pra NAO baixar o dele próprio — era esse download duplicado (~300MB)
# que estava estourando o disco e derrubando o build com "ENOSPC: no space left on device".
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Instala só o essencial pro Chromium do sistema rodar. O pacote "chromium" já traz consigo,
# via dependências do apt, as bibliotecas que ele precisa (libnss3, libgbm1, etc.) — não
# precisa listar tudo de novo. Também tiramos as fontes de idiomas que não usamos aqui
# (chinês, tailandês, árabe...) pra economizar espaço.
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3002

CMD ["node", "index.js"]
