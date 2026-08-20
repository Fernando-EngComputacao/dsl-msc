# Imagem com runtime CUDA (nao so o driver) para que o llama-cpp-python compilado
# com suporte a GPU (passo 4) encontre libcudart/libcublas dentro do container.
# 12.3.1 casa com o "CUDA Version" reportado por `nvidia-smi` no host — o mesmo
# runtime usado pela wheel testada nativamente no Windows (ver README, secao 6.5).
FROM nvidia/cuda:12.3.1-runtime-ubuntu22.04

# Ubuntu 22.04 ja traz Python 3.10 como padrao — nao precisa instalar versao a parte.
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    python3 \
    python3-pip \
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
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir torch "transformers==4.44.2" outlines fastapi uvicorn pydantic

# 3. Copia o restante do requirements.txt
COPY src/requirements.txt ./src/
RUN pip install --no-cache-dir -r src/requirements.txt

# 4. A linha "llama-cpp-python" do requirements.txt (passo 3) instalou a wheel
# generica CPU-only. Sobrescreve aqui pela wheel pré-compilada com CUDA — a
# imagem nvidia/cuda (FROM, acima) já tem libcudart/libcublas no sistema, então,
# ao contrário do setup nativo no Windows, não é preciso copiar nenhuma DLL/SO à
# mão: o linker do Linux já encontra tudo. cu122 é o mesmo runtime validado
# nativamente com esta GPU (ver SPC_CML_N_GPU_LAYERS em python_engine/main.py).
RUN pip install --no-cache-dir --force-reinstall --no-deps llama-cpp-python \
    --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu122

# 5. Copia o código do projeto (o .dockerignore vai barrar o node_modules local aqui)
COPY . .

RUN chmod +x src/scripts/deploy.sh

EXPOSE 8000

# Mantém o container rodando "vazio" em segundo plano para uso manual
CMD ["tail", "-f", "/dev/null"]
