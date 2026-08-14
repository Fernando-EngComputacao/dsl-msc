FROM python:3.10-slim

# Instala dependências do sistema e Node.js
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Copia e instala dependências do Node primeiro
COPY package.json package-lock.json ./
RUN npm install

# 2. Copia APENAS o requirements.txt e instala as dependências Python
# Isso garante que o pip install só rode de novo se o requirements.txt mudar
COPY src/requirements.txt ./src/
RUN pip install --no-cache-dir -r src/requirements.txt

# 3. Copia o restante do código do projeto por último
COPY . .

# Garante permissão de execução para o script
RUN chmod +x scripts/deploy.sh

EXPOSE 8000

CMD ["./scripts/deploy.sh"]