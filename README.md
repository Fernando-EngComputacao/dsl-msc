# Desenvolvimento de DSL com Langium e Integração com Grafos no Neo4j

Este projeto estabelece a configuração de um ambiente de desenvolvimento para criar uma DSL (Domain-Specific Language), integrá-la com bancos de dados orientados a grafos (Neo4j) e preparar a base arquitetural para uso futuro com Modelos de Linguagem (LLMs).

## 🛠️Pré-requisitos

Antes de iniciar, certifique-se de ter os seguintes componentes instalados:
* **Node.js (LTS):** Motor de execução para o ecossistema Langium.
* **VS Code:** Editor de código recomendado.
* **Python 3.10+:** Para integrações futuras de inteligência artificial.
* **Neo4j:** Banco de dados em grafos rodando localmente.

## 📦 1. Configuração e Instalação

Para configurar as dependências do projeto, incluindo o motor do Langium, tipagens do TypeScript e o driver do Neo4j, execute os comandos abaixo na raiz do projeto:

```bash
npm install langium
npm install -D typescript ts-node langium-cli @types/node
npm install vscode-languageclient vscode-languageserver
npm install neo4j-driver
npx tsc --init
```

E para a geração de embeddings locais, instale a biblioteca do motor de vetorização:
```bash
npm install @xenova/transformers
```

## ⚙️ 2. Execução: Langium

Sempre que você alterar a gramática da sua linguagem (`dsl.langium`), será necessário gerar a Árvore de Sintaxe Abstrata (AST) e compilar o TypeScript.

Gere os serviços e faça o build do projeto com:
```bash
npm run langium:generate
npm run build
```

Para testar a saída da sua DSL no terminal executando o arquivo de teste:
```bash
npx tsc && node out/test/test.js
```

## 🧠 3. Execução: TSX (Embeddings Locais)

O projeto utiliza o pacote `tsx` para executar o motor de vetorização em Node.js. Para compilar e rodar a rotina de extração de características e geração dos embeddings locais:
```bash
npx tsx src/embedding.ts
```

## 🗄️ 4. Execução: Neo4j

Para que a integração receba os nós originados da sua AST, o banco de dados precisa estar operante. No terminal do Linux (Ubuntu/WSL), utilize os comandos de serviço:

```bash
# Inicia o serviço do banco de dados
sudo neo4j start

# Verifica o status para confirmar se está rodando
sudo neo4j status

# Para o serviço quando encerrar o desenvolvimento
sudo neo4j stop
```

**Configuração da Conexão:**
Certifique-se de que o seu arquivo `database.ts` esteja apontando para a URI `bolt://localhost:7687`, com o usuário `neo4j` e a senha `senha_super_secreta`.

## 🐙 5. Versionamento e Autenticação (Git/GitHub)

Caso precise configurar a permissão de push no seu ambiente local (WSL) utilizando o seu Personal Access Token (PAT), injete a credencial diretamente na URL do repositório:
```bash
git remote set-url origin [https://SEU_TOKEN_AQUI@github.com/Fernando-EngComputacao/dsl-msc.git](https://SEU_TOKEN_AQUI@github.com/Fernando-EngComputacao/dsl-msc.git)
```

---
*Apostila técnica e material de apoio metodológico desenvolvidos no contexto da pesquisa de Mestrado apresentada ao Programa de Pós-Graduação em Ciência da Computação (PPGCC) do Instituto de Informática da Universidade Federal de Goiás (UFG).*
*Mestrando: Fernando Souza Furtado Carrilho*
*Orientador: Prof. Dr. Fábio Moreira Costa*