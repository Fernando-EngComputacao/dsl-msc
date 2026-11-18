/**
 * Catálogo de complexidade da arquitetura SPC-CML — o que o modal do header mostra.
 *
 * REGRA DESTE ARQUIVO: nenhuma notação sem procedência. Cada item diz como o
 * número foi obtido (`origem`) e, quando não saiu da leitura do nosso código,
 * de onde veio (`fontes`, com URL). Onde a ferramenta não documenta a
 * complexidade, o item diz isso em `origem: 'nao-documentado'` e a `ressalva`
 * explica o que a fonte garante e o que não garante — é melhor registrar a
 * lacuna do que preencher com um O(...) de aparência científica.
 *
 * As ferramentas externas (motor llama.cpp, Neo4j, Lark, Langium/Chevrotain) são
 * caixas-pretas para esta arquitetura: a complexidade delas foi pesquisada na
 * documentação e nos artigos, e as frases citadas estão em `fontes[].nota`.
 *
 * `evidencia` é `arquivo:linha` do nosso código — o teste
 * (web-chat/tests/complexidade.test.ts) confere que o arquivo existe e que a
 * linha existe, para a referência não envelhecer em silêncio.
 */

/** Uma variável das fórmulas. O catálogo inteiro fala nesses símbolos. */
export interface VariavelComplexidade {
    simbolo: string;
    nome: string;
    descricao: string;
    /** Ordem de grandeza nesta instalação, quando é conhecida e fixa. */
    ordem?: string;
}

/** De onde veio a complexidade declarada. */
export type OrigemComplexidade =
    /** Derivada da leitura do nosso próprio código (com `evidencia`). */
    | 'codigo'
    /** Declarada pela documentação oficial da ferramenta. */
    | 'documentacao'
    /** Estabelecida em artigo/literatura. */
    | 'artigo'
    /** A ferramenta não documenta: o que há é indício, e está dito como indício. */
    | 'nao-documentado';

export interface FonteComplexidade {
    titulo: string;
    url?: string;
    /** O que a fonte diz, de preferência citado. */
    nota?: string;
}

export type CamadaComplexidade = 'dsl' | 'grafo' | 'geracao' | 'avaliacao' | 'aplicacao';

export const CAMADAS: Record<CamadaComplexidade, { nome: string; descricao: string }> = {
    dsl: { nome: 'DSL e gramática', descricao: 'Parsers, BNF/GBNF e a poda que produz Ĝ' },
    grafo: { nome: 'Grafo de conhecimento', descricao: 'Recuperação no Neo4j, índice vetorial e foco' },
    geracao: { nome: 'Geração', descricao: 'Decodificação restrita, Planner, PI Agents e ciclo global' },
    avaliacao: { nome: 'Avaliação', descricao: 'Cascata do oráculo, LLM Judge e as métricas do lote' },
    aplicacao: { nome: 'Aplicação', descricao: 'Servidor, chat e as análises da tela' }
};

export interface ItemComplexidade {
    id: string;
    camada: CamadaComplexidade;
    componente: string;
    /** A operação medida — a complexidade é sempre DE ALGO. */
    operacao: string;
    /** Ferramenta de terceiros (caixa-preta para esta arquitetura). */
    caixaPreta: boolean;
    tempo: string;
    espaco?: string;
    /** Símbolos de `VARIAVEIS` usados nas fórmulas acima. */
    variaveis: string[];
    /** Como o número foi obtido — a derivação, em uma ou duas frases. */
    comoObtido: string;
    origem: OrigemComplexidade;
    /** `arquivo:linha` do nosso código, quando a origem é a leitura dele. */
    evidencia?: string;
    /**
     * Trecho exato que deve estar naquela linha. O teste confere o trecho e a
     * distância até a linha declarada — assim a referência não aponta para
     * outro lugar depois de uma edição, em silêncio.
     */
    ancora?: string;
    fontes?: FonteComplexidade[];
    /** O que a fonte NÃO garante, ou o que invalida a leitura ingênua do O(...). */
    ressalva?: string;
}

export const VARIAVEIS: readonly VariavelComplexidade[] = [
    { simbolo: 'c', nome: 'caracteres do plano', descricao: 'Comprimento do artefato em caracteres — a entrada dos parsers.' },
    { simbolo: 't', nome: 'tokens gerados', descricao: 'Tokens que o modelo emitiu para o plano.' },
    { simbolo: 'L', nome: 'tokens do prompt', descricao: 'Prompt Semântico + exemplos + gramática, em tokens.', ordem: 'teto n_ctx = 8192 (SPC_CML_N_CTX)' },
    { simbolo: '|V|', nome: 'vocabulário', descricao: 'Tamanho do vocabulário do modelo — o laço da máscara de logits.', ordem: '~151 000 no Qwen2.5' },
    { simbolo: 'd', nome: 'dimensão do modelo', descricao: 'Largura das representações internas do transformer.' },
    { simbolo: '|G|', nome: 'tamanho da gramática', descricao: 'Regras × símbolos da BNF/GBNF efetiva (Ĝ).' },
    { simbolo: 'R', nome: 'regras recuperadas', descricao: 'Regras do grafo que incidem no cenário e formam a política efetiva.' },
    { simbolo: 'I', nome: 'itens candidatos', descricao: 'Fármacos/produtos/infrações que o índice devolve antes do corte do foco.' },
    { simbolo: 'k', nome: 'top-k vetorial', descricao: 'Vizinhos pedidos ao índice vetorial por consulta.', ordem: 'SPC_CML_FOCO_TOPK_MAX = 10' },
    { simbolo: 'N', nome: 'nós indexados', descricao: 'Nós no índice vetorial do Neo4j.' },
    { simbolo: 'P', nome: 'PIs do plano', descricao: 'Pontos de intervenção da sequência que o Planner validou.' },
    { simbolo: 'A', nome: 'arestas de dependência', descricao: 'Arestas `dependeDe` entre PIs — o DAG que o scheduler percorre.' },
    { simbolo: 'C', nome: 'ciclos globais', descricao: 'Reinícios no Planner após reprovação global.', ordem: 'padrão 2, limitado a [1, 10]' },
    { simbolo: 'Tp', nome: 'tentativas do Planner', descricao: 'Propostas de sequência por ciclo, a primeira inclusa.', ordem: 'padrão 3, limitado a [1, 10]' },
    { simbolo: 'Ti', nome: 'tentativas por PI', descricao: 'Tentativas do PI Agent para cada PI.', ordem: 'padrão 3, limitado a [1, 10]' },
    { simbolo: 'g', nome: 'tentativas do gate', descricao: 'Gerações do mesmo cenário até o critério aprovar.', ordem: 'teto 5 no lote, teto duro 20' },
    { simbolo: 'n', nome: 'cenários do lote', descricao: 'Linhas do .jsonl de entrada.' },
    { simbolo: 'm', nome: 'planos avaliados', descricao: 'Registros do arquivo de resultados (um por plano, por lado).' }
];

export const ITENS: readonly ItemComplexidade[] = [
    // ---------------------------------------------------------------- DSL ---
    {
        id: 'earley',
        camada: 'dsl',
        componente: 'Reconhecedor de Earley sem scanner (nosso)',
        operacao: 'reconhecer um plano e extrair o maior prefixo válido',
        caixaPreta: false,
        tempo: 'O(c³) no pior caso · O(c²) com gramática não ambígua · O(c) em gramáticas LR',
        espaco: 'O(c²)',
        variaveis: ['c', '|G|'],
        comoObtido:
            'São os limites clássicos do algoritmo de Earley, e a implementação é a canônica: um chart com c+1 conjuntos de itens, deduplicados por conjunto de chaves, varrido uma vez por posição do caractere. Opera sobre caracteres (não há lexer), então c é o comprimento do texto, não a contagem de tokens.',
        origem: 'artigo',
        evidencia: 'src/grammar/earley.ts:283',
        ancora: 'private chart(input: string)',
        fontes: [
            {
                titulo: 'Earley parser (Wikipedia)',
                url: 'https://en.wikipedia.org/wiki/Earley_parser',
                nota: '"cubic time and quadratic space for all other context-free grammars"; linear em LR(k) sem recursão à direita.'
            },
            {
                titulo: 'Aycock & Horspool (2002), Practical Earley Parsing',
                nota: 'Correção para regras anuláveis — citada no cabeçalho do nosso módulo e implementada nele.'
            }
        ],
        ressalva:
            'O pior caso cúbico vale para gramáticas ambíguas; as DSLs do projeto são próximas de LR, onde o comportamento observado é linear. Este reconhecedor serve ao caminho sem máscara de logits (provedor de API) e à CLI — em produção, G é conferida pelo motor (ver o item do Lark).'
    },
    {
        id: 'lark-lalr',
        camada: 'dsl',
        componente: 'Lark em modo LALR(1) (motor Python)',
        operacao: 'reparsear o plano gerado — a conferência de sintaxe de /verify',
        caixaPreta: true,
        tempo: 'O(c) — linear no texto',
        espaco: 'O(c) na pilha + O(|G|) nas tabelas',
        variaveis: ['c', '|G|'],
        comoObtido:
            'O parser é construído com parser="lalr": análise shift-reduce com uma tabela pré-compilada, em que cada token é deslocado uma vez. A documentação do Lark dá a notação para os outros algoritmos (earley, CYK) e, para o LALR, afirma eficiência sem notação — o limite linear é a propriedade padrão de LALR(1).',
        origem: 'documentacao',
        evidencia: 'src/python_engine/bnf.py:87',
        ancora: 'parser="lalr"',
        fontes: [
            {
                titulo: 'Lark — Parsers',
                url: 'https://lark-parser.readthedocs.io/en/latest/parsers.html',
                nota: '"It\'s incredibly fast and requires very little memory"; para o earley: "any context-free grammar at O(n^3), and O(n^2) when the grammar is unambiguous".'
            }
        ],
        ressalva: 'A doc oficial não publica a notação para o LALR(1); o O(c) é a propriedade conhecida do algoritmo, não uma citação.'
    },
    {
        id: 'langium',
        camada: 'dsl',
        componente: 'Parser oficial da DSL (Langium sobre Chevrotain)',
        operacao: 'produzir o AST e ligar as referências contra o modelo do especialista',
        caixaPreta: true,
        tempo: 'Linear por decisão em LL(1); o lookahead LL(k) pode custar mais',
        variaveis: ['c'],
        comoObtido:
            'O Langium gera um parser descendente recursivo LL(k) com o Chevrotain. Não há limite publicado pelo Langium; o que existe é a descrição do algoritmo e os números da própria TypeFox sobre o lookahead.',
        origem: 'nao-documentado',
        evidencia: 'src/inference/avaliar-sintaxe.ts:236',
        ancora: 'export function criarAnalisadorDsl',
        fontes: [
            {
                titulo: 'Chevrotain (readme)',
                url: 'https://github.com/Chevrotain/chevrotain',
                nota: 'Toolkit de parsers descendentes recursivos com suporte LL(k), sem fase de geração de código.'
            },
            {
                titulo: 'TypeFox — ALL(*) lookahead no Langium',
                url: 'https://www.typefox.io/blog/allstar-lookahead/',
                nota: 'A memoização do lookahead reduz a complexidade "from O(n4) to O(n)" — é sobre a estratégia de lookahead, não uma garantia geral.'
            }
        ],
        ressalva:
            'Os números de desempenho do Chevrotain são do próprio fornecedor, sem benchmark aberto. Gramática ambígua pode degradar o lookahead.'
    },
    {
        id: 'poda-g-hat',
        camada: 'dsl',
        componente: 'Poda da gramática: G → Ĝ (nosso)',
        operacao: 'especializar a BNF pela política recuperada, antes de gerar',
        caixaPreta: false,
        tempo: 'O(|G| + R)',
        espaco: 'O(|G|)',
        variaveis: ['|G|', 'R'],
        comoObtido:
            'A gramática efetiva é montada varrendo as regras uma vez e filtrando alternativas por conjuntos (vocabulários permitidos, políticas por item), com teste de pertinência O(1) amortizado. Nenhuma etapa reexpande a gramática por item.',
        origem: 'codigo',
        evidencia: 'src/python_engine/main.py:516',
        ancora: 'def _gramatica_efetiva'
    },
    // -------------------------------------------------------------- GRAFO ---
    {
        id: 'indice-vetorial',
        camada: 'grafo',
        componente: 'Índice vetorial do Neo4j (HNSW, sobre Lucene)',
        operacao: 'achar os k nós mais próximos do vetor do pedido',
        caixaPreta: true,
        tempo: 'Escala logarítmica em N, reivindicada empiricamente pelos autores do HNSW',
        espaco: 'O(N·M) — M = conectividade por camada (vector.hnsw.m)',
        variaveis: ['N', 'k'],
        comoObtido:
            'O foco consulta o índice com CALL db.index.vector.queryNodes($indice, $topK, $vetor). A Neo4j não publica complexidade; declara que o índice implementa HNSW (sobre Lucene). O limite, então, é o que o artigo do HNSW reivindica.',
        origem: 'artigo',
        evidencia: 'src/knowledge/foco.ts:183',
        ancora: 'db.index.vector.queryNodes',
        fontes: [
            {
                titulo: 'Malkov & Yashunin (2016/2018), HNSW — arXiv:1603.09320',
                url: 'https://arxiv.org/abs/1603.09320',
                nota: 'Estrutura hierárquica de grafos de proximidade que "allows a logarithmic complexity scaling"; a separação de escalas é o que sustenta o salto.'
            },
            {
                titulo: 'Neo4j — Vector Index and Search',
                url: 'https://neo4j.com/labs/genai-ecosystem/vector-search/',
                nota: 'O índice vetorial do Neo4j implementa HNSW para busca aproximada de vizinhos; a página não dá notação de complexidade.'
            }
        ],
        ressalva:
            'É busca APROXIMADA, e a escala logarítmica é empírica — não há prova de pior caso nas fontes. Recall e custo dependem de ef_construction/m. A alternativa exata (cosseno por força bruta) é O(N·d).'
    },
    {
        id: 'travessia-grafo',
        camada: 'grafo',
        componente: 'Travessia do grafo (Neo4j, adjacência sem índice)',
        operacao: 'expandir um nó para os vizinhos (item ↔ contexto ↔ regra)',
        caixaPreta: true,
        tempo: 'O(1) por salto; expandir um nó custa proporcional ao grau dele',
        variaveis: ['R', 'I'],
        comoObtido:
            'A recuperação é uma sequência de expansões a partir dos nós que o foco selecionou. A Neo4j descreve a travessia como perseguição de ponteiros (index-free adjacency) com custo constante por salto; o custo de expandir um nó inteiro é a soma dos saltos, ou seja, o grau.',
        origem: 'documentacao',
        evidencia: 'src/knowledge/recuperacao-cypher.ts:112',
        ancora: 'export function consultaPara',
        fontes: [
            {
                titulo: 'Neo4j (blog, Jim Webber) — Why graph-native matters',
                url: 'https://neo4j.com/blog/computer-hardware-native-graph-databases/',
                nota: '"a sort of local index, which allows us to cheaply traverse the graph (very cheaply, at cost O(1) per hop)"; travessias implementadas como pointer chasing.'
            },
            {
                titulo: 'Neo4j Community — complexidade de expandir um nó',
                url: 'https://community.neo4j.com/t/what-is-the-time-complexity-of-a-query-that-finds-all-the-children-of-a-node/61520',
                nota: 'Relacionamentos ficam em listas ligadas por tipo: para um nó de grau alto, o Cypher precisa percorrer todos — o O(1) é por salto, não por nó.'
            }
        ],
        ressalva: 'A fonte do O(1) por salto é um blog da própria Neo4j, não o manual. Nó de grau alto (super-nó) domina o custo.'
    },
    {
        id: 'foco',
        camada: 'grafo',
        componente: 'Foco por embedding (nosso)',
        operacao: 'escolher o escopo: quais itens e contextos entram no Prompt Semântico',
        caixaPreta: false,
        tempo: 'O(k log k) por lado, sobre o resultado do índice',
        espaco: 'O(k)',
        variaveis: ['k', 'I'],
        comoObtido:
            'Por lado (itens e contextos) há uma consulta ao índice vetorial pedindo top-k; o que o nosso código faz com a resposta é converter escore em cosseno, ordenar e cortar por margem — ordenação de k elementos. O custo pesado é a consulta (item acima) e o embedding do pedido (item do bge-m3), não esta seleção.',
        origem: 'codigo',
        evidencia: 'src/knowledge/foco.ts:172',
        ancora: 'export function escoreParaCosseno'
    },
    {
        id: 'bge-m3',
        camada: 'grafo',
        componente: 'bge-m3 (embedding, no motor)',
        operacao: 'embutir o pedido para consultar o índice vetorial',
        caixaPreta: true,
        tempo: 'O(L²·d) por chamada (atenção) + O(L·d²) (feed-forward), por camada',
        variaveis: ['L', 'd'],
        comoObtido:
            'É um encoder transformer: a complexidade é a da autoatenção sobre o texto embutido. Uma chamada por pedido (e uma por nó, na sincronização do grafo).',
        origem: 'artigo',
        evidencia: 'src/python_engine/main.py:615',
        ancora: '@app.post("/embed")',
        fontes: [
            {
                titulo: 'Vaswani et al. (2017), Attention Is All You Need — arXiv:1706.03762',
                url: 'https://arxiv.org/abs/1706.03762',
                nota: 'Tabela 1: autoatenção O(n²·d) por camada.'
            }
        ]
    },
    // ------------------------------------------------------------ GERAÇÃO ---
    {
        id: 'inferencia-llm',
        camada: 'geracao',
        componente: 'llama.cpp — inferência do Qwen (motor)',
        operacao: 'uma chamada de geração: processar o prompt e emitir t tokens',
        caixaPreta: true,
        tempo: 'Prompt: O(L²·d + L·d²) · por token gerado, com cache KV: O((L+t)·d + d²)',
        espaco: 'Cache KV O(L·d) por camada',
        variaveis: ['L', 't', 'd'],
        comoObtido:
            'A fase de prompt paga a autoatenção quadrática (Tabela 1 do artigo do transformer); com cache KV, cada token novo atende a L+t chaves já calculadas, então o passo é linear no contexto. O motor guarda contra estouro de contexto antes de decodificar (n_prompt + MAX_TOKENS ≤ n_ctx).',
        origem: 'artigo',
        evidencia: 'src/python_engine/main.py:238',
        ancora: 'n_prompt = len(llm.tokenize',
        fontes: [
            {
                titulo: 'Vaswani et al. (2017) — arXiv:1706.03762',
                url: 'https://arxiv.org/abs/1706.03762',
                nota: 'Tabela 1: autoatenção O(n²·d) por camada.'
            },
            {
                titulo: 'Efficient Uncertainty Estimation for LLM-based Entity Linking — arXiv:2510.01251',
                url: 'https://arxiv.org/pdf/2510.01251',
                nota: 'Tabela de custos: prompt O(L[N²d + Nd²]); geração com cache O(LG[(N+G)d + d²]).'
            }
        ],
        ressalva:
            'A segunda fonte é secundária (um artigo que tabula os custos, não a referência primária do cache KV). O tempo de parede também depende de quantização, GPU/CPU e do lock que serializa as chamadas no motor.'
    },
    {
        id: 'gbnf',
        camada: 'geracao',
        componente: 'llama.cpp — amostragem sob GBNF (decodificação restrita)',
        operacao: 'mascarar os logits pela gramática, a cada token',
        caixaPreta: true,
        tempo: 'Não documentado. Por token, o custo acompanha |V| × pilhas da gramática',
        variaveis: ['|V|', '|G|', 't'],
        comoObtido:
            'A cada passo, os candidatos são confrontados com as pilhas de derivação da gramática. Não há limite publicado: a documentação oficial reconhece "performance gotchas" e aponta padrões patológicos, o que confirma que o custo depende da forma da gramática — e não só do seu tamanho.',
        origem: 'nao-documentado',
        evidencia: 'src/python_engine/main.py:250',
        ancora: 'saida = llm(',
        fontes: [
            {
                titulo: 'llama.cpp — grammars/README.md',
                url: 'https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md',
                nota: '"Grammars currently have performance gotchas (see #4218)"; "the syntax `x? x? x?.... x?` (with N repetitions) may result in extremely slow sampling" — recomenda `x{0,N}`.'
            }
        ],
        ressalva:
            'Nenhuma fonte dá notação nem benchmark para o sampler do llama.cpp. É a maior caixa-preta do caminho crítico: por isso a GBNF do projeto usa tetos explícitos (MAX_ITENS, max_chars) em vez de repetição aberta.'
    },
    {
        id: 'multiagente',
        camada: 'geracao',
        componente: 'Pipeline multiagente (nosso)',
        operacao: 'produzir UM plano: Planner → PIs → composição → validação global',
        caixaPreta: false,
        tempo: 'O(C·(Tp + P·Ti + 1)) chamadas ao motor',
        espaco: 'O(P + A) no estado da execução',
        variaveis: ['C', 'Tp', 'P', 'Ti', 'A'],
        comoObtido:
            'Contagem direta das chamadas do laço: por ciclo global, até Tp propostas do Planner, até Ti tentativas para cada um dos P PIs, e uma validação do plano composto (/verify). Os três orçamentos vêm de variáveis de ambiente, limitados a [1, 10] — então o número de chamadas é limitado, nunca aberto. Com os padrões (C=2, Tp=3, Ti=3): no máximo 2·(3 + 3P + 1) chamadas.',
        origem: 'codigo',
        evidencia: 'src/inference/multiagente.ts:184',
        ancora: 'export function orcamentoDeEnv',
        ressalva:
            'É a contagem de CHAMADAS, não o tempo: cada chamada custa o item da inferência, que depende de L e t. O tempo de parede é dominado por essas chamadas, não pela lógica do laço.'
    },
    {
        id: 'scheduler-pi',
        camada: 'geracao',
        componente: 'Scheduler dos PIs em ondas (nosso)',
        operacao: 'ordenar os PIs em camadas do DAG de dependências',
        caixaPreta: false,
        tempo: 'O(P + A)',
        espaco: 'O(P + A)',
        variaveis: ['P', 'A'],
        comoObtido:
            'As ondas são as camadas do DAG por Kahn: cada PI e cada aresta `dependeDe` são visitados uma vez. Determinístico e sem modelo — o scheduler decide quem pode rodar, não gera nada.',
        origem: 'codigo',
        evidencia: 'src/inference/pi-scheduler.ts:138',
        ancora: 'export function planejarExecucaoPI'
    },
    {
        id: 'gate',
        camada: 'geracao',
        componente: 'Gate da geração (nosso)',
        operacao: 'gerar, avaliar e regerar até o critério aprovar',
        caixaPreta: false,
        tempo: 'O(g) gerações + O(g) avaliações por cenário; no lote, O(n·g)',
        variaveis: ['g', 'n'],
        comoObtido:
            'O laço é explícito: por tentativa, uma geração completa e uma avaliação completa; para no VALID ou no teto. g ≤ maxTentativas (5 no lote, teto duro 20), então o custo é limitado por construção.',
        origem: 'codigo',
        evidencia: 'src/inference/geracao-validada.ts:269',
        ancora: 'export async function gerarComGate',
        ressalva:
            'g é aleatório: depende da amostragem do motor (temperatura 0,3). O esperado só é mensurável a posteriori — é o que a aba "Tempo" mostra em tentativas e gerações descartadas.'
    },
    // ---------------------------------------------------------- AVALIAÇÃO ---
    {
        id: 'avaliar-plano',
        camada: 'avaliacao',
        componente: 'Cascata de avaliação de um plano (nosso)',
        operacao: 'sintaxe → AST → semântica → oráculo, com o juiz em paralelo',
        caixaPreta: false,
        tempo: 'O(c) no parsing + O(P·R) nos validadores + número constante de chamadas ao motor (G, L(Ĝ), juiz e, se UNRESOLVED, diagnóstico)',
        espaco: 'O(c + P + R)',
        variaveis: ['c', 'P', 'R'],
        comoObtido:
            'Leitura do caminho: a sintaxe é um /verify mais um parse; a semântica percorre os PIs do artefato contra as regras recuperadas; oráculo e juiz são iniciados juntos (Promise.allSettled) e cada um faz uma chamada. O número de chamadas ao motor por plano não depende do tamanho do arquivo.',
        origem: 'codigo',
        evidencia: 'src/inference/avaliar-grafo.ts:869',
        ancora: 'export async function avaliarPlano',
        ressalva: 'O tempo de parede é dominado pela chamada do juiz (uma geração), não pelas camadas determinísticas — é o que os tempos por plano mostram.'
    },
    {
        id: 'pareamento',
        camada: 'avaliacao',
        componente: 'Pareamento arquitetura × baseline (nosso)',
        operacao: 'alinhar as linhas dos dois arquivos para a tabela lado a lado',
        caixaPreta: false,
        tempo: 'O(m) esperado',
        espaco: 'O(m)',
        variaveis: ['m'],
        comoObtido:
            'Três níveis de chave (id + assinatura da telemetria → id → enunciado), cada um indexado em Map: uma passada por registro, com busca O(1) amortizada. Nenhuma comparação de todos contra todos.',
        origem: 'codigo',
        evidencia: 'src/inference/avaliar-grafo.ts:1205',
        ancora: 'export function parearRegistros'
    },
    {
        id: 'metricas',
        camada: 'avaliacao',
        componente: 'Agregação das métricas (nosso)',
        operacao: 'contar vereditos, concordâncias, pares e violações',
        caixaPreta: false,
        tempo: 'O(m)',
        espaco: 'O(1) por contador, O(classes) nos pares',
        variaveis: ['m'],
        comoObtido: 'Uma passada pelos planos avaliados, incrementando contadores; os pares oráculo+juiz vão num dicionário de tamanho limitado pelas classes.',
        origem: 'codigo',
        evidencia: 'src/inference/avaliar-grafo.ts:1060',
        ancora: 'export function agregarMetricas'
    },
    // ---------------------------------------------------------- APLICAÇÃO ---
    {
        id: 'estatistica',
        camada: 'aplicacao',
        componente: 'Estatística dos tempos (nosso)',
        operacao: 'média, desvio padrão, IC 95%, mediana e quartis por plano',
        caixaPreta: false,
        tempo: 'O(m log m) — a ordenação para mediana e quartis domina',
        espaco: 'O(m)',
        variaveis: ['m'],
        comoObtido:
            'Média, desvio e correlação são somas em uma passada (O(m)); mediana e quartis exigem a amostra ordenada, e é a ordenação que dá o m log m. O t crítico vem de tabela (O(1)).',
        origem: 'codigo',
        evidencia: 'src/inference/estatistica-tempos.ts:166',
        ancora: 'export function resumirAmostra'
    },
    {
        id: 'jsonl',
        camada: 'aplicacao',
        componente: 'Leitura do JSONL (nosso)',
        operacao: 'ler um arquivo de resultados ou de avaliação',
        caixaPreta: false,
        tempo: 'O(bytes) — uma passada, um JSON.parse por linha',
        espaco: 'O(bytes) — o arquivo inteiro fica em memória',
        variaveis: ['m'],
        comoObtido:
            'O parser quebra por linha e desserializa cada uma; nada é indexado nem relido. O arquivo inteiro vive na memória do navegador, o que é o limite prático para lotes muito grandes.',
        origem: 'codigo',
        evidencia: 'src/inference/avaliacao-jsonl.ts:63',
        ancora: 'export function parseRegistrosAvaliacao'
    }
];

/** O custo composto de ponta a ponta — a soma dos itens no caminho crítico. */
export interface CaminhoComposto {
    id: string;
    titulo: string;
    formula: string;
    explicacao: string;
    itens: string[];
}

export const CAMINHOS: readonly CaminhoComposto[] = [
    {
        id: 'um-plano',
        titulo: 'Gerar um plano (modo multiagente)',
        formula: '1 embedding + O(k) consulta vetorial + O(C·(Tp + P·Ti + 1)) chamadas de geração',
        explicacao:
            'O custo é contado em CHAMADAS ao motor, porque é o que domina o tempo de parede: cada chamada paga a inferência (O(L²·d) no prompt, O((L+t)·d) por token) mais a máscara da gramática a cada token. A recuperação no grafo entra uma vez por cenário.',
        itens: ['bge-m3', 'indice-vetorial', 'travessia-grafo', 'poda-g-hat', 'multiagente', 'inferencia-llm', 'gbnf']
    },
    {
        id: 'um-plano-avaliado',
        titulo: 'Avaliar um plano',
        formula: 'O(c) parsing + O(P·R) semântica + número constante de chamadas ao motor',
        explicacao:
            'A cascata refaz a recuperação do cenário (para julgar contra o mesmo conhecimento da geração) e chama o motor um número fixo de vezes: G, L(Ĝ), juiz e, só em UNRESOLVED, o diagnóstico. O juiz é uma geração — é ele que domina.',
        itens: ['avaliar-plano', 'lark-lalr', 'langium', 'indice-vetorial', 'inferencia-llm']
    },
    {
        id: 'lote',
        titulo: 'Lote de n cenários com o gate ligado',
        formula: 'O(n·g) gerações + O(n·g) avaliações, com g ≤ maxTentativas',
        explicacao:
            'O lote é sequencial (um cenário por vez; o motor serializa as chamadas de qualquer forma). O gate multiplica cada cenário pelas tentativas até aprovar, e o teto garante que o laço termina. Nada aqui é paralelo: a escala é linear em n, com a constante dominada pelo modelo.',
        itens: ['gate', 'multiagente', 'avaliar-plano']
    },
    {
        id: 'analise',
        titulo: 'Abrir a análise de m planos na tela',
        formula: 'O(bytes) leitura + O(m) métricas + O(m log m) estatística',
        explicacao:
            'Tudo acontece no navegador, sem servidor: uma passada pelos registros para as métricas e uma ordenação por amostra para mediana e quartis. É a única parte da arquitetura cujo custo não é dominado por um modelo de linguagem.',
        itens: ['jsonl', 'pareamento', 'metricas', 'estatistica']
    }
];

/** Tamanho do código, medido (não estimado) — a "complexidade" no sentido de volume. */
export interface MedidaDeCodigo {
    camada: string;
    arquivos: number;
    linhas: number;
    nota?: string;
}

/**
 * Contagem feita com `find … -name '*.ts' -o -name '*.py' -o -name '*.vue'` e
 * `wc -l`, excluindo node_modules e __pycache__ (o comando está em `METODO`).
 * São linhas de arquivo, comentários inclusos — este projeto documenta muito
 * dentro do código, e separar comentário de instrução exigiria uma ferramenta
 * que o repositório não tem.
 */
export const CODIGO: readonly MedidaDeCodigo[] = [
    { camada: 'src/knowledge (grafo, contratos, validadores)', arquivos: 21, linhas: 9230 },
    { camada: 'src/inference (geração, avaliação, agentes)', arquivos: 22, linhas: 10773 },
    { camada: 'web-chat/src (chat e telas de avaliação)', arquivos: 44, linhas: 9298 },
    { camada: 'src/python_engine (motor FastAPI)', arquivos: 8, linhas: 2695 },
    { camada: 'src/grammar (BNF, Earley)', arquivos: 6, linhas: 1380 },
    { camada: 'src/database (sincronização Neo4j)', arquivos: 3, linhas: 1384 },
    { camada: 'src/web (servidor HTTP)', arquivos: 1, linhas: 1083 },
    { camada: 'src/cli', arquivos: 7, linhas: 1094 },
    { camada: 'src/language (Langium: gramática da DSL)', arquivos: 3, linhas: 180, nota: 'gera ~13 000 linhas em src/generated, fora da contagem' },
    { camada: 'src/test', arquivos: 36, linhas: 15018, nota: 'testes: 1,3 linha de teste por linha de src/inference' }
];

export interface NotaDeMetodo {
    titulo: string;
    texto: string;
}

export const METODO: readonly NotaDeMetodo[] = [
    {
        titulo: 'O que estas notações dizem',
        texto:
            'Complexidade assintótica é crescimento, não velocidade: diz como o custo reage quando a entrada cresce, não quanto tempo leva. Nesta arquitetura, quase todo o tempo de parede é constante multiplicativa — uma chamada ao modelo de linguagem —, e por isso cada item diz também em que unidade conta (caracteres, tokens, chamadas ao motor).'
    },
    {
        titulo: 'Como cada número foi obtido',
        texto:
            'Três origens, sempre identificadas no item: leitura do nosso código (com arquivo e linha, que o teste confere); documentação oficial da ferramenta (com a frase citada); ou artigo/literatura. Quando a ferramenta não documenta — é o caso do sampler sob GBNF do llama.cpp e do parser do Langium —, o item fica marcado como não documentado e mostra só o indício que existe, com a ressalva.'
    },
    {
        titulo: 'Caixas-pretas',
        texto:
            'llama.cpp (inferência e máscara da gramática), Neo4j (índice vetorial e travessia), Lark e Langium/Chevrotain são de terceiros: a arquitetura depende do comportamento delas e não o controla. Onde a fonte é do próprio fornecedor (blog da Neo4j, benchmarks da TypeFox), isso está dito — não é literatura revisada por pares.'
    },
    {
        titulo: 'Complexidade do código (volume)',
        texto:
            'O tamanho por camada foi medido com: find <camada> -type f \\( -name "*.ts" -o -name "*.py" -o -name "*.vue" \\) ! -path "*/node_modules/*" ! -path "*__pycache__*" | wc -l, e o mesmo find com cat | wc -l para as linhas. Complexidade ciclomática NÃO é medida aqui: o repositório não tem a ferramenta para isso, e estimá-la contando ramos à mão daria um número sem procedência — exatamente o que este catálogo evita.'
    },
    {
        titulo: 'O que não está medido',
        texto:
            'Nenhum número desta tela é resultado de benchmark: são limites analíticos e citações. As medições reais do sistema — tempo por plano, por caractere e por token, com média, desvio padrão e intervalo de confiança — estão na aba "Tempo" da tela de avaliação, calculadas sobre os planos do arquivo.'
    }
];

/** Itens por camada, na ordem de `CAMADAS`. */
export function itensPorCamada(): { camada: CamadaComplexidade; nome: string; descricao: string; itens: ItemComplexidade[] }[] {
    return (Object.keys(CAMADAS) as CamadaComplexidade[]).map(camada => ({
        camada,
        ...CAMADAS[camada],
        itens: ITENS.filter(i => i.camada === camada)
    }));
}

export function itemPorId(id: string): ItemComplexidade | undefined {
    return ITENS.find(i => i.id === id);
}

export function variavelPorSimbolo(simbolo: string): VariavelComplexidade | undefined {
    return VARIAVEIS.find(v => v.simbolo === simbolo);
}

export const ROTULO_ORIGEM: Record<OrigemComplexidade, string> = {
    codigo: 'leitura do código',
    documentacao: 'documentação oficial',
    artigo: 'artigo / literatura',
    'nao-documentado': 'não documentado pela ferramenta'
};
