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

# Resiliencia do pip. O padrao e 15 s de timeout e 5 tentativas: quando o
# pypi.org responde devagar (ou a rede do build oscila), o resolver desiste de
# UM pacote e o passo inteiro morre com "No matching distribution found", que
# parece pacote inexistente mas e timeout — foi o que derrubou o build em
# `pycountry` (dependencia transitiva do outlines 0.0.46). 120 s e 10 tentativas
# absorvem a oscilacao sem esconder um pacote que de fato nao existe: esse
# continua falhando, so depois de tentar de verdade.
ENV PIP_DEFAULT_TIMEOUT=120 \
    PIP_RETRIES=10

# 1. Instala dependências do Node
COPY package.json package-lock.json ./
# Força a instalação limpa dos pacotes no ambiente Linux
RUN npm install

# 2. PRÉ-INSTALAÇÃO DAS BIBLIOTECAS PESADAS (Torch e Transformers)
# Os pins acompanham os de src/requirements.txt — mudar lá exige mudar aqui.
# Sem o de transformers esta camada trazia a 5.x, incompatível com o outlines
# 0.0.46 (ver o comentário no requirements.txt). Instalar a 5.x aqui e rebaixá-la
# depois desperdiça a camada. Valia o mesmo para o outlines: solto, esta camada
# baixava a versão nova COM as dependências dela, e o passo 3 baixava a 0.0.46
# com as dela (`pycountry`, `pyairports`) — duas resoluções na rede em vez de
# uma, e justo a segunda, fora desta camada em cache, é a que o build repetia a
# cada tentativa.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir torch "transformers==4.44.2" "outlines==0.0.46" fastapi uvicorn pydantic

# 3. Copia o restante do requirements.txt
COPY src/requirements.txt ./src/
RUN pip install --no-cache-dir -r src/requirements.txt

# 4. A linha "llama-cpp-python" do requirements.txt (passo 3) instalou a wheel
# generica CPU-only. Sobrescreve aqui pela wheel pré-compilada com CUDA — a
# imagem nvidia/cuda (FROM, acima) já tem libcudart/libcublas no sistema, então,
# ao contrário do setup nativo no Windows, não é preciso copiar nenhuma DLL/SO à
# mão: o linker do Linux já encontra tudo. cu122 é o mesmo runtime validado
# nativamente com esta GPU (ver SPC_CML_N_GPU_LAYERS em python_engine/main.py).
#
# `--index-url`, NAO `--extra-index-url`: com `--extra-` o pip consulta TAMBEM o
# PyPI e instala a MAIOR versao que achar entre os dois indices — e o PyPI quase
# sempre esta a frente do indice cu122, entao a build voltava sozinha para a
# wheel CPU-only, sem um unico aviso. O sintoma so aparece rodando, como
# lentidao (o motor aceita n_gpu_layers e o ignora): o juiz do lote passa de ~4
# para ~60 s por plano. Aqui so o indice CUDA e consultado, e `--no-deps`
# garante que nenhuma dependencia precise do PyPI nesta linha. Se esta linha
# falhar com "No matching distribution", o indice nao tem wheel para este
# Python/plataforma: fixe a versao (`llama-cpp-python==X.Y.Z`) ou troque o cuXYZ
# — falhar aqui e o comportamento certo, porque a alternativa e uma imagem lenta
# que parece boa.
RUN pip install --no-cache-dir --force-reinstall --no-deps llama-cpp-python \
    --index-url https://abetlen.github.io/llama-cpp-python/whl/cu122

# 4b. A build PARA aqui se o passo 4 trouxe uma wheel sem CUDA. E a diferenca
# entre descobrir agora e descobrir depois de um lote de 400 planos a 60 s cada.
#
# A conferencia e sobre os ARQUIVOS instalados, nao sobre importar o llama_cpp:
# `libcuda.so.1` e do DRIVER, injetado pelo runtime da NVIDIA quando o container
# sobe com `--gpus`. Dentro do build ele nao existe, e o import morre no dlopen
# mesmo com a wheel certa — foi exatamente o que aconteceu na primeira versao
# deste passo. Entao: `find_spec` (que nao executa o modulo) localiza o pacote, e
# um build com CUDA se denuncia pelo backend ggml-cuda ou por um .so ligado ao
# libcuda/libcublas. Quem confere em tempo de execucao e o motor, que publica o
# veredito em /health (`dispositivo_do_motor` em python_engine/main.py).
RUN python3 -c "import importlib.util as u, pathlib, sys; \
raiz = pathlib.Path(u.find_spec('llama_cpp').submodule_search_locations[0]); \
libs = [p for p in raiz.rglob('*.so*') if p.is_file()]; \
cuda = [p.name for p in libs if 'cuda' in p.name.lower() or 'cublas' in p.name.lower()]; \
cuda = cuda or [p.name for p in libs if p.stat().st_size < 200*1024*1024 and (b'libcuda.so.1' in p.read_bytes() or b'libcublas' in p.read_bytes())]; \
versao = next((d.name for d in raiz.parent.glob('llama_cpp_python-*.dist-info')), '?'); \
print('wheel:', versao, '| libs:', sorted(p.name for p in libs), '| CUDA:', cuda or 'NENHUM'); \
sys.exit(0 if cuda else 'wheel do llama-cpp-python SEM CUDA: o passo 4 caiu na wheel CPU-only do PyPI. Fixe a versao que existe no indice cu122 (llama-cpp-python==X.Y.Z) ou troque o cuXYZ — ver o comentario do passo 4.')"

# 5. Copia o código do projeto (o .dockerignore vai barrar o node_modules local aqui)
COPY . .

RUN chmod +x src/scripts/deploy.sh

EXPOSE 8000

# Mantém o container rodando "vazio" em segundo plano para uso manual
CMD ["tail", "-f", "/dev/null"]
