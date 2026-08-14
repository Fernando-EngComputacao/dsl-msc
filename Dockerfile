# Usa uma imagem oficial do Python que já inclui ferramentas essenciais
FROM python:3.10-slim

# Instala o Node.js (necessário para rodar o Langium, TypeScript e o Neo4j driver)
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de dependências do Node.js
COPY package.json package-lock.json ./

# Instala as dependências Node
RUN npm install

# Copia o restante do código do projeto para dentro do container
COPY . .

# Instala as dependências do Python a partir do requirements.txt na pasta src
RUN pip install --no-cache-dir -r src/requirements.txt

# Garante permissão de execução para o script de deploy
RUN chmod +x scripts/deploy.sh

# Expõe a porta da API Python (FastAPI)
EXPOSE 8000

# Comando padrão ao subir o container: Executa o deploy completo
CMD ["./scripts/deploy.sh"]