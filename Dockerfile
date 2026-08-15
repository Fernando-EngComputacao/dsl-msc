FROM python:3.10-slim

# Instala dependências do sistema e Node.js
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Instala dependências do Node
COPY package.json package-lock.json ./
# Força a instalação limpa dos pacotes no ambiente Linux
RUN npm install

# 2. PRÉ-INSTALAÇÃO DAS BIBLIOTECAS PESADAS (Torch e Transformers)
# O pin de transformers acompanha o de src/requirements.txt: sem ele esta camada
# trazia a 5.x, incompatível com o outlines 0.0.46 fixado adiante (ver o comentário
# no requirements.txt). Instalar a 5.x aqui e rebaixá-la depois desperdiça a camada.
RUN pip install --no-cache-dir torch "transformers==4.44.2" outlines fastapi uvicorn pydantic

# 3. Copia o restante do requirements.txt
COPY src/requirements.txt ./src/
RUN pip install --no-cache-dir -r src/requirements.txt

# 4. Copia o código do projeto (o .dockerignore vai barrar o node_modules local aqui)
COPY . .

RUN chmod +x src/scripts/deploy.sh

EXPOSE 8000

# Mantém o container rodando "vazio" em segundo plano para uso manual
CMD ["tail", "-f", "/dev/null"]