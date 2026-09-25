/**
 * RAG — recuperacao de CANDIDATOS no Grafo de Conhecimento.
 *
 * Fecha o ramo esquerdo do Contexto de Recuperacao (ver `recuperacao.ts`):
 *
 *     consultaSemantica -> embedding -> indice vetorial do Neo4j -> CandidatoRegra[]
 *
 * O QUE ESTE MODULO NAO FAZ, e por que isso importa mais do que o que ele faz:
 *
 *   - nao decide. A saida e uma lista de candidatos, nao de regras validas.
 *   - nao autoriza. Nenhum candidato daqui libera decisao alguma.
 *   - nao bloqueia. Nenhum candidato ausente daqui proibe coisa nenhuma.
 *   - nao determina validade. Quem determina e a comparacao deterministica
 *     (`retrieve*Constraints`), que le numero e limiar — nunca cosseno.
 *
 * A arquitetura ja sustentava essa separacao ("o embedding nunca decide o que e
 * permitido, so o que e mostrado", ver o cabecalho de `foco.ts`); aqui ela vira
 * um tipo. Um `CandidatoRegra` e uma PERGUNTA a fazer ao grafo, nao uma resposta
 * dele.
 *
 * O QUE O INDICE DEVOLVE, no schema real deste projeto: nos de ENTIDADE
 * (Farmaco/Protocolo, Produto/Cultura, Infracao/Lance), nao nos de regra. As
 * regras — RegraSeguranca, Gatilho, Escalonamento, VETA, PROIBE — pendem desses
 * nos por arestas. Por isso o candidato carrega a chave com que todo Cypher do
 * projeto ancora (`MATCH (f:Farmaco { nome: $nome })`): e a partir dele que a
 * etapa seguinte alcanca as regras de fato.
 */

import { type Session } from 'neo4j-driver';

import { embedTexto } from './embeddings.js';
import { numeroDeEnv, topKPorVetor, type ItemPontuado } from './foco.js';
import type { ContextoRecuperacao, Dominio } from './recuperacao.js';

// =============================================================================
// Configuracao
// =============================================================================

/**
 * Quantos vizinhos pedir a CADA indice.
 *
 * Segue a convencao de `foco.ts` (SPC_CML_FOCO_*): variavel de ambiente com
 * padrao no codigo, lida por `numeroDeEnv`. O padrao 10 e o mesmo teto que
 * `SPC_CML_FOCO_TOPK_MAX` ja usava — nao ha por que este modulo enxergar menos
 * grafo que o foco.
 */
const TOP_K_PADRAO = numeroDeEnv(process.env.SPC_CML_RAG_TOP_K, 10);

// =============================================================================
// Schema: o que cada dominio indexa
// =============================================================================

/**
 * Os dois papeis que todo dominio deste projeto tem: os ITENS, que o artefato
 * cita (o que se prescreve, se aplica, se marca), e os CONTEXTOS, que os agrupam
 * e restringem. Cada papel tem o seu indice — e e por isso que `ladoMaisDecidido`
 * existe em `foco.ts`.
 */
export type PapelCandidato = 'item' | 'contexto';

export interface IndiceDominio {
    /** Nome do indice vetorial, como `database/neo4j*.ts` o cria. */
    indice: string;
    /** Label do no indexado, como o Cypher da etapa seguinte vai casar. */
    rotulo: string;
}

/**
 * Adaptador por dominio: a UNICA coisa que muda entre med, agro e fut.
 *
 * A maquinaria (embutir, consultar, montar candidato, preservar escore) e a
 * mesma nos tres — repeti-la tres vezes seria recriar o problema que a
 * arquitetura ja resolveu em `politica.ts` com papeis em vez de nomes. O que e
 * genuinamente diferente — o nome do indice e o label do no — vive aqui, e so
 * aqui. Um quarto dominio entra acrescentando uma linha.
 */
export const INDICES_POR_DOMINIO: Record<Dominio, Record<PapelCandidato, IndiceDominio>> = {
    med: {
        item: { indice: 'farmaco_embedding', rotulo: 'Farmaco' },
        contexto: { indice: 'protocolo_embedding', rotulo: 'Protocolo' }
    },
    agro: {
        item: { indice: 'produto_embedding', rotulo: 'Produto' },
        contexto: { indice: 'cultura_embedding', rotulo: 'Cultura' }
    },
    fut: {
        item: { indice: 'infracao_embedding', rotulo: 'Infracao' },
        contexto: { indice: 'lance_embedding', rotulo: 'Lance' }
    }
};

// =============================================================================
// Candidato
// =============================================================================

/**
 * Um no que a recuperacao semantica trouxe. NAO e uma regra validada.
 *
 * SIGNIFICADO DO `escore` — e a parte deste arquivo que nao pode ser esquecida:
 *
 *     escore = RELEVANCIA SEMANTICA da recuperacao.
 *
 *     escore NAO e validade.
 *     escore NAO e autorizacao.
 *     escore mais alto NAO e "a regra escolhida".
 *
 * Um Propofol em primeiro lugar por cosseno continua bloqueado se a PAM estiver
 * abaixo do limiar, e um Propofol em ultimo lugar continua liberado se ela nao
 * estiver. A ordem aqui diz de que o usuario provavelmente estava FALANDO; quem
 * diz o que ele PODE fazer e a comparacao numerica, noutra camada. Trocar um
 * pelo outro e exatamente a falha que a arquitetura inteira existe para impedir.
 */
export interface CandidatoRegra {
    /**
     * Chave estavel do candidato no dominio: `<rotulo>:<nome>`, por exemplo
     * `Farmaco:Noradrenalina`. E a forma que todo Cypher do projeto usa para
     * ancorar (`MATCH (f:Farmaco { nome: $nome })`), entao a etapa seguinte
     * consegue partir daqui sem consultar mais nada. Reprodutivel: nao depende
     * de id interno do banco nem da ordem de sincronizacao.
     */
    regraId: string;
    /** `elementId(node)` — a identidade do no NO BANCO, preservada como veio. */
    nodeId?: string;
    /** Escore do indice, em [0, 1], exatamente como o Neo4j o devolveu. */
    escore: number;
    /** O mesmo escore em cosseno bruto [-1, 1] — ver `escoreParaCosseno`. */
    cosseno: number;
    dominio: Dominio;
    /** `node.nome`: o nome do no, que e a chave de negocio em todo o projeto. */
    item: string;
    metadados: {
        rotulo: string;
        indice: string;
        papel: PapelCandidato;
        /**
         * Posicao no ranking DO PROPRIO INDICE (0 = primeiro colocado).
         * Deliberadamente nao e a posicao na lista final: comparar cosseno entre
         * dois indices e comparar populacoes diferentes, e a posicao dentro de
         * casa e a unica que o indice de fato afirmou.
         */
        posicao: number;
    };
}

// =============================================================================
// Portas injetaveis (para teste sem Neo4j e sem GPU)
// =============================================================================

/** Converte texto em vetor. Padrao: `embedTexto` (POST /embed do motor Python). */
export type Embutidor = (texto: string) => Promise<number[]>;

/** Consulta um indice vetorial. Padrao: `buscaPorSessao`. */
export type BuscaVetorial = (
    indice: string,
    vetor: number[],
    topK: number
) => Promise<ItemPontuado[]>;

/**
 * Busca real, sobre uma `Session` do driver. Mesma funcao que `retrieverFoco*`
 * ja usa (`topKPorVetor`) — este modulo nao abre conexao, nao cria indice e nao
 * fala Cypher por conta propria.
 */
export function buscaPorSessao(session: Session): BuscaVetorial {
    return (indice, vetor, topK) => topKPorVetor(session, indice, vetor, topK);
}

export interface OpcoesRag {
    /**
     * Candidatos por INDICE (nao no total). O total pode chegar a 2x este valor,
     * porque cada dominio tem dois indices.
     *
     * Nao ha corte global de proposito: com um teto sobre a lista inteira, uma
     * familia de nos com cosseno sistematicamente mais alto silenciaria a outra —
     * e decidir que o usuario nao falava de contexto algum seria o RAG decidindo.
     * Aqui ele so recupera; quem corta, corta depois e com criterio proprio.
     */
    topK?: number;
    embutir?: Embutidor;
    /** Papeis a consultar. Padrao: os dois. */
    papeis?: PapelCandidato[];
}

// =============================================================================
// Recuperacao
// =============================================================================

/**
 * `consultaSemantica` -> embedding -> indice vetorial -> candidatos.
 *
 * Nenhum candidato e descartado aqui: nem por piso de cosseno, nem por margem
 * relativa, nem por telemetria. Os cortes que `foco.ts` aplica
 * (`selecionarPorSimilaridade`) sao decisoes de FOCO e continuam onde estao —
 * trazer qualquer um deles para ca transformaria recuperacao em julgamento.
 *
 * A lista sai ordenada por escore decrescente, por conveniencia de quem lista.
 * A ordem e apresentacao, nao veredito: ver a nota sobre `escore` em
 * `CandidatoRegra`.
 */
export async function recuperarCandidatos(
    contexto: ContextoRecuperacao,
    busca: BuscaVetorial,
    opcoes: OpcoesRag = {}
): Promise<CandidatoRegra[]> {
    const consulta = contexto.consultaSemantica.trim();
    if (consulta.length === 0) return [];

    const topK = Math.max(1, Math.trunc(opcoes.topK ?? TOP_K_PADRAO));
    const embutir = opcoes.embutir ?? embedTexto;
    const papeis = opcoes.papeis ?? (['item', 'contexto'] as PapelCandidato[]);
    const indices = INDICES_POR_DOMINIO[contexto.dominio];

    const vetor = await embutir(consulta);

    const candidatos: CandidatoRegra[] = [];
    for (const papel of papeis) {
        const { indice, rotulo } = indices[papel];

        // Sequencial, nao Promise.all: uma Session do driver nao roda duas
        // queries concorrentes — mesma restricao que `retrieverFoco*` documenta.
        let encontrados: ItemPontuado[];
        try {
            encontrados = await busca(indice, vetor, topK);
        } catch (error) {
            throw new Error(
                `busca vetorial falhou no indice ${indice}: ${(error as Error).message}`
            );
        }

        encontrados.slice(0, topK).forEach((achado, posicao) => {
            candidatos.push({
                regraId: `${rotulo}:${achado.nome}`,
                nodeId: achado.nodeId,
                // `escore` so vem ausente de uma busca antiga que nao o preenchia;
                // nesse caso ele e reconstruido do cosseno, sem perda.
                escore: achado.escore ?? (achado.cosseno + 1) / 2,
                cosseno: achado.cosseno,
                dominio: contexto.dominio,
                item: achado.nome,
                metadados: { rotulo, indice, papel, posicao }
            });
        });
    }

    return candidatos.sort((a, b) => b.escore - a.escore);
}
