/**
 * O que cada UNIDADE das duas tabelas de tempo por plano significa, de onde o
 * número vem e um exemplo numérico fechado.
 *
 * Mora aqui, e não no componente, pelo mesmo motivo que `complexidade.ts` não
 * mora no `ComplexidadeModal`: o texto é conteúdo verificável, não marcação.
 * `web-chat/tests/tempos-plano.test.ts` cobra que toda linha das tabelas tem
 * detalhe e que todo detalhe corresponde a uma linha — assim a explicação não
 * descola da tabela quando uma unidade for acrescentada ou renomeada.
 *
 * Os exemplos são ilustrativos e internamente consistentes (as contas fecham
 * com os números dados), não medições de um lote real.
 */

/** As unidades da tabela "Tempo de geração por tamanho". */
export type IdDetalheTamanho = 'input-chars' | 'input-tokens' | 'pedido-chars' | 'plano-chars' | 'plano-tokens';

/** As amostras da tabela "Tempo por plano (geração + validação)". */
export type IdDetalhePlano =
    | 'gate-total'
    | 'geracao'
    | 'validacao-gate'
    | 'descartadas'
    | 'cenario'
    | 'avaliacao-tela';

export type IdDetalheTempo = IdDetalheTamanho | IdDetalhePlano;

export interface ExemploDetalhe {
    /** O que se observou — uma linha por medida. */
    dados: { rotulo: string; valor: string }[];
    /** A conta, passo a passo, com os números acima. */
    conta: string[];
    /** O que o resultado quer dizer. */
    leitura: string;
}

export interface DetalheTempo {
    id: IdDetalheTempo;
    secao: 'tamanho' | 'plano';
    /** Igual ao rótulo da linha na tabela. */
    rotulo: string;
    /** Uma frase: o que a unidade é. */
    oQueE: string;
    /** O campo do arquivo e quem o escreve — a procedência do número. */
    origem: { campo: string; texto: string };
    /** O que as colunas da tabela mostram desta unidade. */
    comoSeUsa: string;
    exemplo: ExemploDetalhe;
    /** O que NÃO concluir a partir dela. */
    cuidado: string;
    /** Em que caso a linha aparece vazia ("—"). */
    quandoVazio: string;
}

const COLUNAS_TAMANHO =
    'A tabela traz, nesta unidade: n (planos em que tempo e tamanho existem), o tamanho médio, a taxa agregada (Σtempo ÷ Σtamanho), a taxa por plano (média das razões de cada plano, ± desvio padrão), r (correlação de Pearson entre tamanho e tempo) e r² (fração da variação do tempo que o tamanho explica).';

const COLUNAS_PLANO =
    'A linha traz n, média, dp (desvio padrão amostral, divisor n−1), IC 95% da média (t de Student), mediana, Q1–Q3, mín–máx e CV (dp ÷ média).';

export const DETALHES_TEMPO: Record<IdDetalheTempo, DetalheTempo> = {
    // -------------------------------------------------- Tempo por tamanho
    'input-chars': {
        id: 'input-chars',
        secao: 'tamanho',
        rotulo: 'Caracteres do input (Prompt Semântico)',
        oQueE:
            'O tamanho, em caracteres, do texto que entra na geração: o Prompt Semântico — o contexto recuperado do Grafo de Conhecimento (itens em foco, restrições ativas, decisões admissíveis) mais o pedido do usuário.',
        origem: {
            campo: 'geracao.charsPrompt',
            texto:
                'Gravado pelo servidor no momento da geração. Num JSONL importado sem o campo, é medido do próprio `promptSemantico` do registro — nunca estimado.'
        },
        comoSeUsa: COLUNAS_TAMANHO,
        exemplo: {
            dados: [
                { rotulo: 'plano 1', valor: '4.000 caracteres · 8.000 ms' },
                { rotulo: 'plano 2', valor: '6.000 caracteres · 11.000 ms' },
                { rotulo: 'plano 3', valor: '10.000 caracteres · 21.000 ms' }
            ],
            conta: [
                'tamanho médio = (4.000 + 6.000 + 10.000) ÷ 3 = 6.667 car',
                'taxa agregada = (8.000 + 11.000 + 21.000) ms ÷ (4.000 + 6.000 + 10.000) car = 40.000 ÷ 20.000 = 2,00 ms/car',
                'taxa por plano = média(2,00 ; 1,83 ; 2,10) = 1,98 ms/car',
                'r ≈ 0,999 → r² ≈ 0,998'
            ],
            leitura:
                'Custa cerca de 2 ms por caractere de Prompt Semântico, e nesta amostra o tamanho do input explica quase toda a variação do tempo. Com n = 3 isso é frágil: r oscila muito com poucos pontos, e é por isso que o n fica ao lado.'
        },
        cuidado:
            'Não é o prompt completo que o motor recebe: os exemplos few-shot e a gramática BNF não são gravados. A taxa por caractere aqui é, portanto, maior do que a do prompt real — ela compara lotes entre si, não mede o custo absoluto do modelo.',
        quandoVazio:
            'Arquivo anterior à medição, ou avaliação cujo registro não traz o bloco `geracao`.'
    },
    'input-tokens': {
        id: 'input-tokens',
        secao: 'tamanho',
        rotulo: 'Tokens do input (Prompt Semântico)',
        oQueE:
            'O mesmo texto da linha anterior, contado em tokens pelo tokenizador do modelo que gerou os planos — a unidade em que o motor realmente cobra o prefill.',
        origem: {
            campo: 'geracao.tokensPrompt',
            texto:
                'Preenchido na avaliação, chamando `/tokenizar` no motor do domínio (disponível só com `SPC_CML_BACKEND=llamacpp`). Nada é derivado da contagem de caracteres.'
        },
        comoSeUsa: COLUNAS_TAMANHO,
        exemplo: {
            dados: [
                { rotulo: 'mesmo plano 2 do exemplo acima', valor: '6.000 caracteres · 1.620 tokens · 11.000 ms' }
            ],
            conta: [
                'taxa por token = 11.000 ms ÷ 1.620 tok = 6,79 ms/tok',
                'taxa por caractere = 11.000 ms ÷ 6.000 car = 1,83 ms/car',
                'densidade = 6.000 car ÷ 1.620 tok ≈ 3,7 car/tok'
            ],
            leitura:
                'As duas taxas descrevem o mesmo plano em unidades diferentes. A de token é a comparável entre modelos e hardwares; a de caractere muda com o idioma e com a verbosidade do contexto recuperado.'
        },
        cuidado:
            'Tokenizadores diferentes dão contagens diferentes para o mesmo texto: só compare taxas por token entre lotes gerados pelo MESMO modelo.',
        quandoVazio:
            'Motor sem `/tokenizar` (qualquer backend que não seja llamacpp) ou arquivo anterior à contagem. A linha fica vazia em vez de receber um valor estimado.'
    },
    'pedido-chars': {
        id: 'pedido-chars',
        secao: 'tamanho',
        rotulo: 'Caracteres do pedido',
        oQueE:
            'Só a fala do usuário (o campo `intencao` do cenário), sem o contexto recuperado do grafo. É a parte do input que quem usa o sistema escreve.',
        origem: {
            campo: 'geracao.charsPedido',
            texto: 'Gravado na geração; na importação, medido do campo `intencao` do registro quando não veio pronto.'
        },
        comoSeUsa: COLUNAS_TAMANHO,
        exemplo: {
            dados: [
                { rotulo: 'pedido', valor: '90 caracteres ("Vento de 14 km/h no talhão de soja: mando o glifosato assim mesmo?")' },
                { rotulo: 'Prompt Semântico do mesmo plano', valor: '6.000 caracteres' },
                { rotulo: 'tempo de geração', valor: '11.000 ms' }
            ],
            conta: [
                'taxa por caractere de pedido = 11.000 ms ÷ 90 car = 122 ms/car',
                'participação do pedido no input = 90 ÷ 6.000 = 1,5%'
            ],
            leitura:
                'A taxa é altíssima e instável porque o pedido é ~1,5% do que entra na geração. Quem manda no tempo é o contexto recuperado, não o tamanho da frase do usuário.'
        },
        cuidado:
            'r baixo nesta linha NÃO significa que o pedido é irrelevante: um pedido curto pode acionar mais restrições no grafo e inflar o Prompt Semântico. O efeito do pedido é indireto, e esta linha não o mede.',
        quandoVazio: 'Praticamente nunca — todo cenário tem pedido. Vazia significa registro sem `intencao`.'
    },
    'plano-chars': {
        id: 'plano-chars',
        secao: 'tamanho',
        rotulo: 'Caracteres do plano',
        oQueE:
            'O tamanho do artefato gerado — o plano, a missão ou a arbitragem escrita na DSL. É SAÍDA, não entrada: por isso a linha vem marcada como "saída".',
        origem: {
            campo: 'geracao.charsPlano',
            texto:
                'Gravado na geração. Quando o campo não veio, a própria tela mede `plano.length` do texto do artefato — é a única medida que sobrevive em arquivo antigo.'
        },
        comoSeUsa: COLUNAS_TAMANHO,
        exemplo: {
            dados: [
                { rotulo: 'plano gerado', valor: '1.200 caracteres' },
                { rotulo: 'tempo de geração', valor: '11.000 ms' }
            ],
            conta: ['taxa = 11.000 ms ÷ 1.200 car = 9,17 ms/car de saída'],
            leitura:
                'Na decodificação restrita o motor paga por posição GERADA, então esta é a taxa mais próxima do custo marginal de produzir artefato. Note que é ~5× a taxa por caractere de input: ler o prompt é barato, escrever sob gramática é caro.'
        },
        cuidado:
            'Não é "velocidade de geração" pura: o mesmo tempo inclui o prefill do prompt, a recuperação no grafo e a rede. Para velocidade de decodificação, use a linha em tokens.',
        quandoVazio: 'Só se o registro não trouxer nem o campo nem o texto do plano.'
    },
    'plano-tokens': {
        id: 'plano-tokens',
        secao: 'tamanho',
        rotulo: 'Tokens do plano',
        oQueE:
            'O artefato gerado, contado em tokens pelo tokenizador do motor. É a unidade em que a decodificação restrita avança: um passo de decodificação, um token.',
        origem: {
            campo: 'geracao.tokensPlano',
            texto: 'Preenchido na avaliação via `/tokenizar` no motor do domínio, como a linha de tokens do input.'
        },
        comoSeUsa: COLUNAS_TAMANHO,
        exemplo: {
            dados: [
                { rotulo: 'plano gerado', valor: '1.200 caracteres · 380 tokens' },
                { rotulo: 'tempo de geração', valor: '11.000 ms' }
            ],
            conta: [
                'taxa = 11.000 ms ÷ 380 tok = 28,9 ms/tok',
                'equivalente = 1.000 ÷ 28,9 ≈ 34,6 tok/s'
            ],
            leitura:
                'É a única linha que se converte direto em tokens por segundo — a medida com que se comparam motores, quantizações e hardware.'
        },
        cuidado:
            'Os tokens/s daqui incluem o prefill do prompt, então ficam ABAIXO da taxa de decodificação pura do motor. Além disso a BNF restringe o vocabulário em cada posição, o que pode mudar a taxa em relação à geração livre.',
        quandoVazio: 'Mesmo caso dos tokens do input: motor sem `/tokenizar`.'
    },

    // ---------------------------------------------- Tempo por plano
    'gate-total': {
        id: 'gate-total',
        secao: 'plano',
        rotulo: 'Geração + validação no gate',
        oQueE:
            'O custo de produzir UM plano: a geração que ficou mais a validação que rodou durante ela, no gate do lote. É a linha principal da seção — a resposta a "quanto custa um plano".',
        origem: {
            campo: 'geracao.tempoTotalMs + geracao.tempoValidacaoMs',
            texto:
                'Somados por plano, antes de qualquer estatística. Parcela ausente não vira zero: se nenhuma das duas existe, o plano não entra na amostra.'
        },
        comoSeUsa: COLUNAS_PLANO,
        exemplo: {
            dados: [
                { rotulo: 'geração do plano que ficou', valor: '11.000 ms' },
                { rotulo: 'validação no gate', valor: '2.400 ms' },
                { rotulo: 'lote', valor: '20 planos' }
            ],
            conta: [
                'este plano = 11.000 + 2.400 = 13.400 ms',
                'sobre os 20 planos: média 12.800 ms, dp 3.100 ms',
                'IC 95% da média = 12.800 ± 2,093 × 3.100 ÷ √20 = 12.800 ± 1.451 → [11.349 ; 14.251] ms',
                'mediana 12.100 ms · CV = 3.100 ÷ 12.800 = 24%'
            ],
            leitura:
                'Um plano custa ~12,8 s em média, e a média do lote está entre 11,3 s e 14,3 s com 95% de confiança. A mediana abaixo da média (12,1 < 12,8) indica cauda à direita: alguns planos bem mais caros puxam a média.'
        },
        cuidado:
            'Não inclui as gerações que o gate descartou (linha própria) nem a avaliação desta tela. O IC é da MÉDIA, não do próximo plano: para "onde cai o próximo", leia mediana, Q1–Q3 e mín–máx.',
        quandoVazio: 'Arquivo sem `tempoTotalMs` por plano — só com o total agregado do lote, ou nem isso.'
    },
    geracao: {
        id: 'geracao',
        secao: 'plano',
        rotulo: 'Geração (parcela)',
        oQueE:
            'Só o pipeline de geração do plano que FICOU: recuperação no grafo, montagem do Prompt Semântico, decodificação restrita e as retentativas internas do planner.',
        origem: {
            campo: 'geracao.tempoTotalMs',
            texto: 'Medido pelo motor e gravado por plano. É a mesma medida que alimenta a seção "Tempo de geração por tamanho".'
        },
        comoSeUsa: COLUNAS_PLANO,
        exemplo: {
            dados: [
                { rotulo: 'média desta parcela', valor: '11.000 ms' },
                { rotulo: 'média da linha principal', valor: '12.800 ms' }
            ],
            conta: ['participação = 11.000 ÷ 12.800 = 86% do custo de um plano'],
            leitura:
                'A geração responde por ~86% do custo; a validação no gate pelos outros ~14%. É a decomposição que diz onde vale otimizar.'
        },
        cuidado:
            'É o plano que ficou. O que o gate reprovou e jogou fora está em "Gerações descartadas" — somar as duas dá o custo bruto de geração do cenário, não o deste plano.',
        quandoVazio: 'Mesmo caso da linha principal.'
    },
    'validacao-gate': {
        id: 'validacao-gate',
        secao: 'plano',
        rotulo: 'Validação no gate (parcela)',
        oQueE:
            'A validação feita DURANTE a geração, no lote: o oráculo e/ou o LLM Judge, uma vez por tentativa. É o gate que decide se o plano passa ou se o motor gera de novo.',
        origem: {
            campo: 'geracao.tempoValidacaoMs',
            texto: 'Somando as tentativas do cenário — com 3 tentativas, são 3 passagens de validação dentro deste número.'
        },
        comoSeUsa: COLUNAS_PLANO,
        exemplo: {
            dados: [
                { rotulo: 'validação no gate', valor: '2.400 ms' },
                { rotulo: 'tentativas de geração', valor: '2' }
            ],
            conta: [
                'por tentativa ≈ 2.400 ÷ 2 = 1.200 ms',
                'participação no plano = 2.400 ÷ 13.400 = 18% deste plano'
            ],
            leitura:
                'Validar custa ~1,2 s por tentativa. Como o gate roda a cada tentativa, esta parcela cresce com o número de repetições, não com o tamanho do plano.'
        },
        cuidado:
            'Não é a avaliação desta tela (que tem linha própria) e não aparece na seção "tempo de geração" nem na de "tempo da avaliação": ela é de outra etapa, e é por isso que esta seção existe. Lote rodado sem gate deixa esta linha vazia, e aí a linha principal fica igual à da geração.',
        quandoVazio: 'Lote gerado sem gate de validação.'
    },
    descartadas: {
        id: 'descartadas',
        secao: 'plano',
        rotulo: 'Gerações descartadas',
        oQueE:
            'O tempo jogado fora em tentativas que o gate reprovou. É o preço do reparo por reamostragem: o plano que ficou é o único entregue, mas não o único pago.',
        origem: {
            campo: 'geracao.tempoGeracaoDescartadaMs',
            texto: 'Zero nos cenários aprovados de primeira — zero medido, não ausência de medida.'
        },
        comoSeUsa: COLUNAS_PLANO,
        exemplo: {
            dados: [
                { rotulo: 'cenário A (aprovado de primeira)', valor: '0 ms descartados' },
                { rotulo: 'cenário B (3 tentativas: 9.000 e 10.000 reprovadas)', valor: '19.000 ms descartados' },
                { rotulo: 'plano que ficou no cenário B', valor: '11.000 ms' }
            ],
            conta: [
                'no cenário B, descartado ÷ aproveitado = 19.000 ÷ 11.000 = 1,7×',
                'num lote de 20 com 3 cenários assim: média ≈ 2.850 ms, mediana 0 ms'
            ],
            leitura:
                'Média alta com mediana zero é a assinatura deste custo: ele não está espalhado, está concentrado em poucos cenários difíceis. O CV muito acima de 100% confirma.'
        },
        cuidado:
            'Fica FORA do total "geração + validação" de propósito: somar tudo num número só esconderia justamente o custo do reparo, que é o que se quer medir. Para o custo bruto do cenário, use "Cenário inteiro".',
        quandoVazio: 'Arquivo que não grava a parcela descartada (anterior à medição).'
    },
    cenario: {
        id: 'cenario',
        secao: 'plano',
        rotulo: 'Cenário inteiro (relógio do lote)',
        oQueE:
            'O relógio de parede de cada cenário no lote: todas as gerações (inclusive as descartadas), todas as validações, a rede e as esperas. É o tempo que o operador vê passar.',
        origem: {
            campo: 'geracao.tempoCenarioMs',
            texto: 'Cronometrado pelo lote de ponta a ponta no cenário, não somado a partir das parcelas.'
        },
        comoSeUsa: COLUNAS_PLANO,
        exemplo: {
            dados: [
                { rotulo: 'plano que ficou + validação', valor: '13.400 ms' },
                { rotulo: 'gerações descartadas', valor: '19.000 ms' },
                { rotulo: 'relógio do cenário', valor: '35.800 ms' }
            ],
            conta: [
                'soma das parcelas = 13.400 + 19.000 = 32.400 ms',
                'overhead = 35.800 − 32.400 = 3.400 ms (9,5% do cenário)'
            ],
            leitura:
                'Os 3,4 s de diferença são rede, serialização e espera que nenhuma etapa reivindica. Comparar esta linha com a soma das parcelas é a forma de ver quanto do relógio não é trabalho medido.'
        },
        cuidado:
            'Não é a soma das parcelas e não deve ser comparada com a linha principal como se fosse o custo de um plano: um cenário pode ter produzido vários planos descartados.',
        quandoVazio: 'Avaliação ao vivo sem o cronômetro do lote, ou arquivo anterior à medição.'
    },
    'avaliacao-tela': {
        id: 'avaliacao-tela',
        secao: 'plano',
        rotulo: 'Avaliação nesta tela',
        oQueE:
            'O custo de JULGAR um plano já gerado: a checagem de sintaxe (Earley sobre a BNF), a de semântica (ancoragem no grafo) e o LLM Judge desta avaliação.',
        origem: {
            campo: 'tempos.totalMs',
            texto: 'Escrito por esta avaliação, por plano e por lado (arquitetura e baseline).'
        },
        comoSeUsa: COLUNAS_PLANO,
        exemplo: {
            dados: [
                { rotulo: 'por plano', valor: '1.900 ms (sintaxe 40 ms · semântica 60 ms · juiz 1.800 ms)' },
                { rotulo: 'lote', valor: '20 planos' }
            ],
            conta: [
                'total da avaliação ≈ 20 × 1.900 = 38.000 ms',
                'com o juiz desligado ≈ 20 × 100 = 2.000 ms'
            ],
            leitura:
                'Quase todo o custo é o LLM Judge; sintaxe e semântica são desprezíveis porque são determinísticas e locais. Desligar o juiz derruba a avaliação em ~19×.'
        },
        cuidado:
            'É posterior à geração e NÃO entra no custo de produzir o plano. Também não é a validação do gate: aquela decidiu se o plano seria aceito; esta só mede o que já foi entregue.',
        quandoVazio: 'Lado sem bloco de tempos da avaliação.'
    }
};

export function detalheTempo(id: IdDetalheTempo): DetalheTempo {
    return DETALHES_TEMPO[id];
}

/** Rótulo humano da seção, para o subtítulo do modal. */
export const ROTULO_SECAO: Record<DetalheTempo['secao'], string> = {
    tamanho: 'Tempo de geração por tamanho',
    plano: 'Tempo por plano (geração + validação)'
};
