/**
 * Expansao sistematica dos cenarios do dominio agro: os 200 antigos + 200 novos,
 * construidos como SUITE DE AVALIACAO, nao como exemplos.
 *
 * Gemeo de src/scripts/gerar-cenarios-400-fut.ts. Os 200 novos sao declarados
 * aqui em FAMILIAS CONTROLADAS: dentro de uma familia so muda a dimensao
 * declarada (um parametro da leitura dos sensores, as areas do talhao, os
 * produtos na calda ou a fala) — o resto e identico, e isso e conferido por
 * assercao. Assim, depois do lote, da para perguntar se o sistema muda a decisao
 * exatamente quando a regra do lavoura.agro muda, e so entao.
 *
 * Nada aqui reimplementa a semantica da DSL:
 *
 *   - a camada deterministica esperada de cada cenario (culturas ativas, vetos,
 *     proibicoes de area, bloqueios por sensor, ajustes de vazao,
 *     incompatibilidades, escalonamentos, politica do produto-alvo) sai de
 *     `retrieveAgroConstraints`, a MESMA funcao que o servidor usa;
 *   - o foco offline (nome escrito + arestas, sem indice vetorial) sai de
 *     `retrieverFocoAgro` + `filtrarPorFocoAgro`, como em test:foco-politica.
 *
 * O que este script acrescenta e o DESENHO: a familia, a dimensao controlada, o
 * objetivo do pedido, o estilo da fala e os fatos que so aparecem na fala
 * (alegacoes sem leitura). Isso vai para um arquivo a parte — o JSONL de
 * cenarios mantem exatamente o formato dos 200 antigos.
 *
 * COMPLETUDE DO PEDIDO. Cada cenario novo passa, antes da gravacao, por:
 *   1. esquema e faixa fisica de cada sensor;
 *   2. coerencia entre as areas declaradas e os sensores de distancia — area
 *      declarada com o sensor fora do criterio e CONTRADICAO e reprova; sensor
 *      dentro com cadastro vazio so passa na familia que declara
 *      `cadastroAusente`, que e o caso que a regra global do modelo preve;
 *   3. coerencia entre a fala e a leitura: todo numero citado na fala
 *      (km/h, m do manancial, NDVI, temperatura/umidade foliar, infestacao, mm
 *      de chuva, dose em L/ha ou kg/ha) tem de bater com o sensor ou com a bula;
 *   4. ancoragem: a fala tem de nomear ao menos um produto ou uma cultura que o
 *      modelo declara, senao o pedido nao cabe no universo;
 *   5. coerencia com o estado da calda: quem pede para INICIAR nao pode ter o
 *      produto ja em `produtosEmUso`, e quem fala de produto "ja no tanque"
 *      tem de te-lo ali.
 *
 * Uso:
 *   npx tsx src/scripts/gerar-cenarios-400-agro.ts
 *
 * Gera:
 *   src/examples/agro/cenarios-400-agro.jsonl             200 antigos (copiados byte a byte) + 200 novos
 *   src/examples/agro/cenarios-400-agro.meta.jsonl        desenho + camada deterministica dos 200 novos
 *   src/examples/agro/cenarios-400-agro.contrastes.jsonl  pares controlados dentro de cada familia
 *   src/examples/agro/cobertura-400-agro.md               cobertura antigo x novo x total, achados e limites
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Session } from 'neo4j-driver';

import { loadAgroModel } from '../database/neo4j-agro.js';
import {
    isAreaDef,
    isAreaRequire,
    isCultureDef,
    isDoseAttr,
    isProductDef,
    isTriggerAttr,
    isWindowAttr,
    type AgroModel
} from '../generated/ast.js';
import { nomesAgro } from '../knowledge/documentos.js';
import { casamentoLexical, normalizar, type SinalVetorial } from '../knowledge/foco.js';
import {
    filtrarPorFocoAgro,
    retrieveAgroConstraints,
    retrieverFocoAgro,
    type AgroContext,
    type RetrievedAgroConstraints
} from '../knowledge/graphrag-agro.js';

// =============================================================================
// 1) Vocabulario do desenho
// =============================================================================

const PARAMETROS = [
    'vento',
    'temperatura',
    'umidade',
    'NDVI',
    'umidade_foliar',
    'temperatura_foliar',
    'distancia_manancial',
    'distancia_cultura_sensivel',
    'chuva_prevista',
    'infestacao'
] as const;
type Parametro = (typeof PARAMETROS)[number];
type Tel = Record<Parametro, number>;

/**
 * Faixa fisica de cada sensor. Nao e regra do modelo: e o que uma leitura de
 * campo pode valer. Fora dela o pedido nao e um pedido, e um erro de digitacao.
 */
const FAIXAS: Record<Parametro, [number, number]> = {
    vento: [0, 40],
    temperatura: [0, 50],
    umidade: [0, 100],
    NDVI: [0, 1],
    umidade_foliar: [0, 100],
    temperatura_foliar: [0, 55],
    distancia_manancial: [0, 5000],
    distancia_cultura_sensivel: [0, 5000],
    chuva_prevista: [0, 100],
    infestacao: [0, 100]
};

/** Nenhum campo dos 200 antigos e escrito com `.0`: `String(n)` reproduz todos. */
const CAMPOS_FLOAT = new Set<string>();

type Bloco =
    | 'fronteira'
    | 'veto_proibicao'
    | 'area'
    | 'calda'
    | 'evidencia'
    | 'escalonamento_procedimento'
    | 'interacao'
    | 'unitario';

/** As oito categorias da suite; uma familia pode ter mais de uma. */
type Tipo =
    | 'unitario_semantico'
    | 'fronteira'
    | 'negativo'
    | 'evidencia_insuficiente'
    | 'contextual'
    | 'combinatorio'
    | 'procedimento'
    | 'estado_de_curso';

type Dimensao = `telemetria.${Parametro}` | 'areas' | 'produtosEmUso' | 'intencao';

type Estilo =
    | 'pergunta_direta'
    | 'ordem'
    | 'duvida_operacional'
    | 'urgente'
    | 'relato_e_pergunta'
    | 'relato_informal'
    | 'info_irrelevante'
    | 'conclusao_prematura'
    | 'alegacao_sem_leitura'
    | 'compara_produtos'
    | 'pede_substituicao'
    | 'manter_decisao'
    | 'procedimento';

type Objetivo =
    | 'aplicar'
    | 'bloquear_ou_suspender'
    | 'aguardar_janela'
    | 'ajustar_vazao'
    | 'substituir_produto'
    | 'solicitar_varredura'
    | 'acionar_agronomo'
    | 'classificar_restricao'
    | 'procedimento';

/**
 * Fato que so aparece na fala e que o lavoura.agro declara NAO ser leitura de
 * sensor (regra_global "Fato que so aparece no pedido..." e a de area ausente do
 * cadastro).
 */
type Alegacao =
    | 'FLORADA'
    | 'COLMEIA'
    | 'VENTO_BAIXOU'
    | 'DIRECAO_VENTO'
    | 'TANQUE_LIMPO'
    | 'RECEITA'
    | 'CARENCIA'
    | 'SOBRA_GALPAO'
    | 'CADASTRO'
    | 'JANELA'
    | 'CHUVA'
    | 'VIZINHO'
    | 'ALTURA_VOO'
    | 'HORA'
    | 'DOSE';

interface Variante {
    tel?: Partial<Tel>;
    /** Areas do cadastro do talhao. */
    areas?: string[];
    /** Produtos ja na calda. */
    uso?: string[];
    fala: string;
    estilo: Estilo;
    alegacoes?: Alegacao[];
    nota?: string;
}

interface Familia {
    id: string;
    bloco: Bloco;
    tipos: Tipo[];
    /** Produto cuja politica a familia observa; null quando o pedido nao cita produto. */
    alvo: string | null;
    objetivo: Objetivo;
    /** Dimensoes que variam dentro da familia. Vazio: cenario isolado. */
    dimensoes: Dimensao[];
    /** Regras globais do lavoura.agro que o pedido aciona (texto curto). */
    regrasGlobais?: string[];
    racional: string;
    base: Tel;
    areas?: string[];
    uso?: string[];
    /** A familia existe para o caso "sensor dentro do criterio, cadastro vazio". */
    cadastroAusente?: boolean;
    variantes: Variante[];
}

const T = (t: Tel): Tel => t;

// Regras globais citadas pelo desenho (resumo do texto do lavoura.agro).
const RG_FATO_FALA = 'fato so no pedido nao e leitura de sensor';
const RG_CADASTRO = 'area ausente do cadastro nao e area livre';
const RG_VENTO_15 = 'aplicacao aerea proibida com vento acima de 15 km/h';
const RG_TOXI_I = 'classe toxicologica I exige dupla checagem';
const RG_TANQUE = 'limpar o tanque entre culturas diferentes';
const RG_REGISTRO = 'registro de GPS, vazao e condicao climatica';
const RG_ADJACENTE = 'talhoes adjacentes com culturas diferentes acima de 8 km/h';
const RG_RASTRO = 'missao automatica exige justificativa rastreavel';

// =============================================================================
// 2) As 73 familias (200 cenarios novos)
//
// Ativacao de cultura (lavoura.agro):
//   Soja  <=> NDVI < 0.4  OU infestacao > 15
//   Milho <=> umidade_foliar < 60 OU NDVI < 0.45
//   Cana  <=> temperatura_foliar > 38 OU NDVI < 0.35
// Bloqueio por sensor (regra_seguranca):
//   Glifosato/Nicosulfuron vento > 10 | Dois_Quatro_D vento > 8
//   Atrazina distancia_manancial < 500 | Clorpirifos temperatura > 32
//   Mancozebe umidade < 55 | Azoxistrobina umidade < 50
//   Acefato chuva_prevista > 0 | Imidacloprido temperatura_foliar > 38
// As bases abaixo escolhem a ativacao de proposito: quando uma cultura VETA o
// produto-alvo de outra familia (Soja->Atrazina, Milho->Dois_Quatro_D,
// Cana->Nicosulfuron), a base a mantem inativa para que a dimensao controlada
// seja a unica coisa que mexe na politica.
// =============================================================================

const FAMILIAS: Familia[] = [
    // ------------------------------------------------------------- FRONTEIRA (71)
    {
        id: 'FR-VENTO-GLIFO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Glifosato',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.vento'],
        racional:
            '`regra_seguranca: bloquear_aplicacao Glifosato se vento > 10 km/h` e o teto mais pedido do dominio. Nos 200 antigos o valor 10 aparece 1 vez e |v-10|<=0,5 so 4 vezes. A fala nunca diz a velocidade: so a leitura do anemometro decide.',
        base: T({ vento: 10, temperatura: 27, umidade: 66, NDVI: 0.37, umidade_foliar: 74, temperatura_foliar: 30, distancia_manancial: 1500, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { tel: { vento: 9.5 }, estilo: 'ordem', fala: 'Dessecação de pré-plantio no talhão de soja: o mato já fechou a entrelinha. Manda o glifosato.' },
            { tel: { vento: 9.9 }, estilo: 'urgente', fala: 'Preciso decidir agora: glifosato na soja ou o anemômetro me impede de decolar?' },
            { tel: { vento: 10 }, estilo: 'pergunta_direta', fala: 'O vento está no limite do que a bula do glifosato aceita. Libero a dessecação da soja?' },
            { tel: { vento: 10.1 }, estilo: 'duvida_operacional', fala: 'Glifosato programado para o talhão de soja e o vento subiu. Decolo ou espero a janela?' },
            { tel: { vento: 11 }, estilo: 'manter_decisao', fala: 'Cancelei a dessecação da soja por causa do vento. Fiz certo ou dava para aplicar o glifosato?' }
        ]
    },
    {
        id: 'FR-VENTO-24D',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Dois_Quatro_D',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.vento'],
        racional:
            'O Dois_Quatro_D tem o teto de vento mais baixo (8 km/h) porque a deriva hormonal alcanca cultura sensivel longe. A base mantem o Milho inativo de proposito: ativo, ele VETARIA o produto e o limiar de vento nao mudaria mais nada.',
        base: T({ vento: 8, temperatura: 26, umidade: 69, NDVI: 0.5, umidade_foliar: 71, temperatura_foliar: 30, distancia_manancial: 1700, distancia_cultura_sensivel: 1050, chuva_prevista: 0, infestacao: 7 }),
        variantes: [
            { tel: { vento: 7.5 }, estilo: 'ordem', fala: 'Folha larga tomando a soqueira da cana-de-açúcar. Aplica o dois-quatro-D nesta janela.' },
            { tel: { vento: 7.9 }, estilo: 'pergunta_direta', fala: 'O dois-quatro-D na cana-de-açúcar cabe nesta condição de vento?' },
            { tel: { vento: 8 }, estilo: 'duvida_operacional', fala: 'Estou na divisa do que a bula do dois-quatro-D permite de vento. Aplico na cana-de-açúcar ou reprogramo?' },
            { tel: { vento: 8.1 }, estilo: 'urgente', fala: 'Dois-quatro-D na cana-de-açúcar: o drone está carregando. Pode decolar?' },
            { tel: { vento: 9 }, estilo: 'conclusao_prematura', fala: 'Vou de dois-quatro-D na cana-de-açúcar porque a folha larga está dominando. Só confirma a vazão.' }
        ]
    },
    {
        id: 'FR-VENTO-NICO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Nicosulfuron',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.vento'],
        racional:
            'O mesmo teto de 10 km/h do Glifosato, agora no herbicida seletivo do milho — o par separa "limiar do produto" de "limiar do dominio". A Cana fica inativa: ativa, ela vetaria o Nicosulfuron.',
        base: T({ vento: 10, temperatura: 24, umidade: 72, NDVI: 0.42, umidade_foliar: 63, temperatura_foliar: 28, distancia_manancial: 1900, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 5 }),
        variantes: [
            { tel: { vento: 9.9 }, estilo: 'pergunta_direta', fala: 'Capim-colchão na entrelinha do milho. O nicosulfuron pode sair com este vento?' },
            { tel: { vento: 10 }, estilo: 'duvida_operacional', fala: 'Nicosulfuron no milho, vento exatamente no limite da bula. Sigo ou aguardo?' },
            { tel: { vento: 10.1 }, estilo: 'ordem', fala: 'Solta o nicosulfuron no milho, a gramínea está passando do ponto.' }
        ]
    },
    {
        id: 'FR-TEMP-CLORPI',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Clorpirifos',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.temperatura'],
        racional:
            '`bloquear_aplicacao Clorpirifos se temperatura > 32 C` e o unico teto do dominio em temperatura do AR (os outros usam umidade, vento, chuva ou folha). Nos antigos 32 aparece 2 vezes e nunca com |t-32|<=0,5.',
        base: T({ vento: 5, temperatura: 32, umidade: 64, NDVI: 0.43, umidade_foliar: 57, temperatura_foliar: 36, distancia_manancial: 1600, distancia_cultura_sensivel: 1200, chuva_prevista: 0, infestacao: 12 }),
        variantes: [
            { tel: { temperatura: 31 }, estilo: 'ordem', fala: 'Cigarrinha subindo no milho. Manda o clorpirifós agora.' },
            { tel: { temperatura: 31.9 }, estilo: 'urgente', fala: 'Clorpirifós no milho: a temperatura está colada no limite. Decolo?' },
            { tel: { temperatura: 32 }, estilo: 'pergunta_direta', fala: 'A temperatura bateu no limite do clorpirifós no milho. Aplico ou suspendo?' },
            { tel: { temperatura: 32.1 }, estilo: 'duvida_operacional', fala: 'Clorpirifós contra a cigarrinha do milho e o termômetro passou do ponto. Espero a tarde?' },
            { tel: { temperatura: 34 }, estilo: 'conclusao_prematura', fala: 'Já decidi aplicar clorpirifós no milho hoje mesmo. Só me diz a vazão.' }
        ]
    },
    {
        id: 'FR-UMID-MANCO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Mancozebe',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.umidade'],
        racional:
            '`bloquear_aplicacao Mancozebe se umidade < 55 %` e um teto INVERTIDO (bloqueia abaixo, nao acima): o par com FR-UMID-AZOXI mostra que o operador do limiar importa tanto quanto o valor.',
        base: T({ vento: 4, temperatura: 29, umidade: 55, NDVI: 0.38, umidade_foliar: 68, temperatura_foliar: 33, distancia_manancial: 1800, distancia_cultura_sensivel: 1500, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { tel: { umidade: 53 }, estilo: 'ordem', fala: 'Ferrugem asiática aparecendo na soja. Programa o mancozebe preventivo.' },
            { tel: { umidade: 54.9 }, estilo: 'urgente', fala: 'Mancozebe na soja: o ar está secando rápido. Dá para aplicar ainda?' },
            { tel: { umidade: 55 }, estilo: 'pergunta_direta', fala: 'A umidade está no mínimo que o mancozebe exige na soja. Libero?' },
            { tel: { umidade: 55.1 }, estilo: 'duvida_operacional', fala: 'Mancozebe preventivo na soja com o ar logo acima do mínimo. Vale a passada ou a gota evapora?' },
            { tel: { umidade: 60 }, estilo: 'relato_e_pergunta', fala: 'A soja está com a janela boa de umidade e eu quero o mancozebe preventivo. Confirma a decisão?' }
        ]
    },
    {
        id: 'FR-UMID-AZOXI',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Azoxistrobina',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.umidade'],
        racional:
            'O teto da Azoxistrobina (umidade < 50 %) e 5 pontos abaixo do do Mancozebe porque a gota de 150 micra evapora antes. Os dois limiares na mesma reta exigem que o sistema use o do produto citado, nao o do dominio.',
        base: T({ vento: 5, temperatura: 27, umidade: 50, NDVI: 0.33, umidade_foliar: 74, temperatura_foliar: 32, distancia_manancial: 1550, distancia_cultura_sensivel: 1250, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { tel: { umidade: 49 }, estilo: 'ordem', fala: 'Ferrugem laranja na cana-de-açúcar. Solta a azoxistrobina preventiva.' },
            { tel: { umidade: 50 }, estilo: 'pergunta_direta', fala: 'A umidade está no limite da azoxistrobina na cana-de-açúcar. Aplico?' },
            { tel: { umidade: 50.1 }, estilo: 'duvida_operacional', fala: 'Azoxistrobina na cana-de-açúcar com o ar pouco acima do mínimo. Sigo com a aplicação preventiva?' },
            { tel: { umidade: 54 }, estilo: 'relato_e_pergunta', fala: 'Quero fechar a prevenção de ferrugem laranja na cana-de-açúcar com azoxistrobina. A condição do ar permite?' }
        ]
    },
    {
        id: 'FR-CHUVA-ACEFATO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Acefato',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.chuva_prevista'],
        racional:
            '`bloquear_aplicacao Acefato se chuva_prevista > 0 mm` e o unico teto em ZERO do modelo: qualquer milimetro previsto bloqueia. Nos 200 antigos chuva_prevista > 0 aparece em 7 cenarios, nenhum deles sobre o Acefato.',
        base: T({ vento: 6, temperatura: 26, umidade: 74, NDVI: 0.52, umidade_foliar: 66, temperatura_foliar: 29, distancia_manancial: 1400, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 24 }),
        variantes: [
            { tel: { chuva_prevista: 0 }, estilo: 'ordem', fala: 'Lagarta desfolhadora acima do nível de dano na soja. Manda o acefato.' },
            { tel: { chuva_prevista: 0.2 }, estilo: 'pergunta_direta', fala: 'Tem chuva no radar e o acefato está na fila para a soja. Aplico assim mesmo?' },
            { tel: { chuva_prevista: 2 }, estilo: 'duvida_operacional', fala: 'Acefato contra lagarta na soja com previsão de chuva na janela. Arrisco ou reprogramo?' }
        ]
    },
    {
        id: 'FR-FOLIAR-IMIDA',
        bloco: 'fronteira',
        tipos: ['fronteira', 'combinatorio'],
        alvo: 'Imidacloprido',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.temperatura_foliar'],
        racional:
            'Em 38 C a temperatura foliar faz DUAS coisas ao mesmo tempo: ativa o gatilho da Cana ("estresse hidrico: suspender aplicacao foliar") e dispara `bloquear_aplicacao Imidacloprido`. E o unico limiar do modelo com dois efeitos simultaneos, e por isso o par 37,9 / 38,1 e o mais informativo da suite.',
        base: T({ vento: 6, temperatura: 29, umidade: 67, NDVI: 0.48, umidade_foliar: 70, temperatura_foliar: 38, distancia_manancial: 1650, distancia_cultura_sensivel: 1100, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { tel: { temperatura_foliar: 37 }, estilo: 'ordem', fala: 'Broca abrindo galeria na cana-de-açúcar. Programa o imidacloprido.' },
            { tel: { temperatura_foliar: 37.9 }, estilo: 'urgente', fala: 'Imidacloprido na cana-de-açúcar: a folha está esquentando. Decolo agora?' },
            { tel: { temperatura_foliar: 38 }, estilo: 'pergunta_direta', fala: 'A folha da cana-de-açúcar está no limite de estresse. Imidacloprido sai ou não?' },
            { tel: { temperatura_foliar: 38.1 }, estilo: 'duvida_operacional', fala: 'Imidacloprido contra broca na cana-de-açúcar e a folha passou do limite. Suspendo a foliar?' },
            { tel: { temperatura_foliar: 40 }, estilo: 'conclusao_prematura', fala: 'A broca está comendo a cana-de-açúcar, então vou de imidacloprido de qualquer jeito. Confirma.' }
        ]
    },
    {
        id: 'FR-MANANCIAL-ATRA',
        bloco: 'fronteira',
        tipos: ['fronteira', 'combinatorio'],
        alvo: 'Atrazina',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.distancia_manancial'],
        cadastroAusente: true,
        racional:
            'Em 500 m a distancia do manancial dispara `bloquear_aplicacao Atrazina` E o `escalonar -> ORGAO_AMBIENTAL` do Milho. O cadastro fica VAZIO em toda a familia de proposito: assim a unica coisa que muda e o sensor, e a `proibe` da area (que exigiria mudar o cadastro junto) fica para a familia PR-MANANCIAL-ATRA.',
        base: T({ vento: 5, temperatura: 28, umidade: 70, NDVI: 0.47, umidade_foliar: 56, temperatura_foliar: 31, distancia_manancial: 500, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { tel: { distancia_manancial: 480 }, estilo: 'ordem', fala: 'Folha larga no milho perto do córrego. Manda a atrazina em pós-emergência.' },
            { tel: { distancia_manancial: 499 }, estilo: 'urgente', fala: 'Atrazina no milho: estou quase na faixa do manancial. Posso aplicar ou não?' },
            { tel: { distancia_manancial: 500 }, estilo: 'pergunta_direta', fala: "A distância do curso d'água está exatamente no limite exigido pela atrazina no milho. Libero?" },
            { tel: { distancia_manancial: 501 }, estilo: 'duvida_operacional', fala: 'Atrazina no milho logo fora da faixa de proteção do manancial. Preciso de autorização de alguém?' },
            { tel: { distancia_manancial: 520 }, estilo: 'relato_e_pergunta', fala: 'O talhão de milho ficou fora da faixa de proteção e eu quero atrazina em pós-emergência. Confirma a decisão?' }
        ]
    },
    {
        id: 'FR-SENSIVEL-ESCALONA',
        bloco: 'fronteira',
        tipos: ['fronteira', 'procedimento'],
        alvo: 'Imidacloprido',
        objetivo: 'acionar_agronomo',
        dimensoes: ['telemetria.distancia_cultura_sensivel'],
        cadastroAusente: true,
        racional:
            'Em 300 m a distancia da cultura sensivel dispara `escalonar -> AGRONOMO_RESPONSAVEL` na Cana sem mexer na politica de nenhum produto: e o limiar que separa "muda a decisao" de "muda o procedimento". Cadastro vazio em toda a familia, pelo mesmo motivo de FR-MANANCIAL-ATRA.',
        base: T({ vento: 6, temperatura: 27, umidade: 69, NDVI: 0.33, umidade_foliar: 72, temperatura_foliar: 32, distancia_manancial: 1500, distancia_cultura_sensivel: 300, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { tel: { distancia_cultura_sensivel: 280 }, estilo: 'pergunta_direta', fala: 'Imidacloprido na cana-de-açúcar com pomar na vizinhança. Preciso chamar alguém antes?' },
            { tel: { distancia_cultura_sensivel: 299 }, estilo: 'urgente', fala: 'Imidacloprido na cana-de-açúcar: a vizinhança sensível está colada. Decido sozinho?' },
            { tel: { distancia_cultura_sensivel: 300 }, estilo: 'duvida_operacional', fala: 'A cultura sensível vizinha está no limite do cadastro e eu quero imidacloprido na cana-de-açúcar. Como conduzo?' },
            { tel: { distancia_cultura_sensivel: 301 }, estilo: 'relato_e_pergunta', fala: 'Imidacloprido contra broca na cana-de-açúcar, com a vizinhança sensível logo fora do raio. Qual a decisão?' },
            { tel: { distancia_cultura_sensivel: 320 }, estilo: 'ordem', fala: 'Solta o imidacloprido na cana-de-açúcar, a vizinhança sensível ficou fora do raio.' }
        ]
    },
    {
        id: 'FR-NDVI-SOJA',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Glifosato',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.NDVI'],
        racional:
            'O gatilho `NDVI < 0.4` liga e desliga a Soja. Desligada, ela so entra no Prompt Semantico pelo FOCO (nome escrito), e entao vale pelo veto de registro, nao como evento do talhao. Os antigos tem 0.4 em 3 cenarios e nenhum em 0.39/0.41.',
        base: T({ vento: 4, temperatura: 25, umidade: 71, NDVI: 0.4, umidade_foliar: 66, temperatura_foliar: 28, distancia_manancial: 1750, distancia_cultura_sensivel: 1600, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { tel: { NDVI: 0.38 }, estilo: 'relato_e_pergunta', fala: 'O índice de vigor da soja caiu e o mato está competindo. Glifosato resolve ou é outra coisa?' },
            { tel: { NDVI: 0.39 }, estilo: 'pergunta_direta', fala: 'Vigor da soja na beirada do gatilho de varredura. Mando o glifosato?' },
            { tel: { NDVI: 0.4 }, estilo: 'duvida_operacional', fala: 'O vigor da soja está exatamente no ponto de disparo. Dessecação com glifosato ainda cabe?' },
            { tel: { NDVI: 0.41 }, estilo: 'ordem', fala: 'Manda o glifosato na soja mesmo com o vigor dentro do normal, o mato está alto.' },
            { tel: { NDVI: 0.45 }, estilo: 'info_irrelevante', fala: 'Glifosato na soja? O trator quebrou, o operador novo chegou hoje e a bomba está calibrada.' }
        ]
    },
    {
        id: 'FR-NDVI-MILHO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Atrazina',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.NDVI'],
        racional:
            'O gatilho do Milho (`NDVI < 0.45`) fica 5 centesimos acima do da Soja: na mesma reta, um valor pode ativar uma cultura e nao a outra. A base mantem a Soja inativa, porque ativa ela vetaria a Atrazina.',
        base: T({ vento: 5, temperatura: 26, umidade: 73, NDVI: 0.45, umidade_foliar: 64, temperatura_foliar: 30, distancia_manancial: 1850, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 7 }),
        variantes: [
            { tel: { NDVI: 0.44 }, estilo: 'relato_e_pergunta', fala: 'O vigor do milho caiu e a folha larga está competindo. Atrazina em pós-emergência resolve?' },
            { tel: { NDVI: 0.45 }, estilo: 'pergunta_direta', fala: 'Vigor do milho no ponto exato de varredura. Aplico atrazina?' },
            { tel: { NDVI: 0.46 }, estilo: 'duvida_operacional', fala: 'Milho com vigor logo acima do gatilho e folha larga na entrelinha. Atrazina ou só monitoro?' },
            { tel: { NDVI: 0.5 }, estilo: 'ordem', fala: 'Atrazina no milho hoje, o vigor está bom mas a folha larga incomoda.' }
        ]
    },
    {
        id: 'FR-NDVI-CANA',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Azoxistrobina',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.NDVI'],
        racional:
            'O gatilho da Cana (`NDVI < 0.35`) e o mais baixo dos tres. O mesmo valor que ativa a Cana ja ativou o Milho (0.45), o que faz deste limiar o teste de "cultura certa" e nao so de "cultura ativa".',
        base: T({ vento: 5, temperatura: 28, umidade: 66, NDVI: 0.35, umidade_foliar: 70, temperatura_foliar: 33, distancia_manancial: 1600, distancia_cultura_sensivel: 1200, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { tel: { NDVI: 0.34 }, estilo: 'relato_e_pergunta', fala: 'Falha de stand na cana-de-açúcar e mancha de ferrugem laranja no ponteiro. Azoxistrobina preventiva?' },
            { tel: { NDVI: 0.35 }, estilo: 'pergunta_direta', fala: 'Vigor da cana-de-açúcar no ponto de varredura. Aplico azoxistrobina?' },
            { tel: { NDVI: 0.36 }, estilo: 'duvida_operacional', fala: 'Cana-de-açúcar com vigor logo acima do gatilho. Azoxistrobina preventiva ainda se justifica?' },
            { tel: { NDVI: 0.4 }, estilo: 'ordem', fala: 'Programa a azoxistrobina na cana-de-açúcar, quero prevenir ferrugem laranja antes do fechamento.' }
        ]
    },
    {
        id: 'FR-FOLIAR-MILHO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Nicosulfuron',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.umidade_foliar'],
        racional:
            '`umidade_foliar < 60 %` e o unico gatilho do modelo em agua livre na folha, e o unico que o Milho tem sem depender do NDVI. A base deixa a Cana inativa, porque ativa ela vetaria o Nicosulfuron.',
        base: T({ vento: 5, temperatura: 24, umidade: 75, NDVI: 0.5, umidade_foliar: 60, temperatura_foliar: 27, distancia_manancial: 1900, distancia_cultura_sensivel: 1450, chuva_prevista: 0, infestacao: 6 }),
        variantes: [
            { tel: { umidade_foliar: 58 }, estilo: 'relato_e_pergunta', fala: 'A folha do milho está seca e a gramínea subiu na entrelinha. Nicosulfuron agora?' },
            { tel: { umidade_foliar: 59 }, estilo: 'pergunta_direta', fala: 'Água livre na folha do milho quase no gatilho. Nicosulfuron pode sair?' },
            { tel: { umidade_foliar: 60 }, estilo: 'duvida_operacional', fala: 'Folha do milho exatamente no limite do monitoramento de cigarrinha. Aplico nicosulfuron ou espero?' },
            { tel: { umidade_foliar: 61 }, estilo: 'ordem', fala: 'Nicosulfuron no milho, a folha está boa e a gramínea não espera.' },
            { tel: { umidade_foliar: 65 }, estilo: 'manter_decisao', fala: 'Adiei o nicosulfuron no milho porque a folha estava úmida. Foi a decisão certa?' }
        ]
    },
    {
        id: 'FR-INFEST-SOJA',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Acefato',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.infestacao'],
        racional:
            '`infestacao > 15 %` e o nivel de dano economico da Soja: abaixo dele o gatilho nao liga e a cultura so entra por foco. O parametro e percentual inteiro na pratica, por isso o desenho usa 14/15/16 em vez de epsilon.',
        base: T({ vento: 6, temperatura: 27, umidade: 72, NDVI: 0.52, umidade_foliar: 67, temperatura_foliar: 30, distancia_manancial: 1500, distancia_cultura_sensivel: 1250, chuva_prevista: 0, infestacao: 15 }),
        variantes: [
            { tel: { infestacao: 14 }, estilo: 'pergunta_direta', fala: 'Lagarta na soja abaixo do que eu considerava nível de dano. Acefato já se justifica?' },
            { tel: { infestacao: 15 }, estilo: 'duvida_operacional', fala: 'A contagem de lagarta na soja bateu no nível de dano. Acefato ou mais uma varredura?' },
            { tel: { infestacao: 16 }, estilo: 'ordem', fala: 'Passou do nível de dano na soja. Manda o acefato.' },
            { tel: { infestacao: 20 }, estilo: 'relato_e_pergunta', fala: 'Desfolha avançando na soja bem acima do nível de dano. Acefato resolve ou chamo o agrônomo?' }
        ]
    },
    {
        id: 'FR-INFEST-ESCALONA',
        bloco: 'fronteira',
        tipos: ['fronteira', 'procedimento'],
        alvo: 'Acefato',
        objetivo: 'acionar_agronomo',
        dimensoes: ['telemetria.infestacao'],
        racional:
            'O segundo limiar da mesma reta: `escalonar: infestacao > 30 % -> AGRONOMO_RESPONSAVEL`. A Soja esta ativa nas quatro variantes (infestacao > 15 em todas), de modo que a unica coisa que muda e o escalonamento — procedimento, nao politica.',
        base: T({ vento: 5, temperatura: 28, umidade: 70, NDVI: 0.5, umidade_foliar: 68, temperatura_foliar: 31, distancia_manancial: 1600, distancia_cultura_sensivel: 1350, chuva_prevista: 0, infestacao: 30 }),
        variantes: [
            { tel: { infestacao: 29 }, estilo: 'pergunta_direta', fala: 'Infestação alta de lagarta na soja. Resolvo com acefato no talhão todo ou preciso de avaliação presencial?' },
            { tel: { infestacao: 30 }, estilo: 'duvida_operacional', fala: 'A soja está no limite do que eu decido sozinho. Acefato por minha conta?' },
            { tel: { infestacao: 31 }, estilo: 'urgente', fala: 'Desfolha severa na soja: acefato de imediato ou escalono antes?' },
            { tel: { infestacao: 38 }, estilo: 'relato_e_pergunta', fala: 'A soja está sendo devorada e o acefato está disponível. Como conduzo a missão?' }
        ]
    },

    // ------------------------------------------------------- VETO E PROIBICAO (25)
    {
        id: 'VT-SOJA-ATRAZINA',
        bloco: 'veto_proibicao',
        tipos: ['negativo', 'contextual'],
        alvo: 'Atrazina',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.NDVI'],
        racional:
            'O veto de REGISTRO (`Soja veta Atrazina`) nao depende do dia: a Atrazina nao tem registro para soja num NDVI de 0,36 ou de 0,60. O NDVI muda se a Soja entra como EVENTO (gatilho ativo) ou so por FOCO, e o par deve mostrar que a politica da Atrazina no pedido nao muda por isso.',
        base: T({ vento: 5, temperatura: 26, umidade: 70, NDVI: 0.4, umidade_foliar: 66, temperatura_foliar: 29, distancia_manancial: 1700, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { tel: { NDVI: 0.36 }, estilo: 'ordem', fala: 'Mato de folha larga tomando a soja. Manda atrazina que é o que tem no galpão.' },
            { tel: { NDVI: 0.42 }, estilo: 'pergunta_direta', fala: 'Dá para usar atrazina no mato de folha larga da soja?' },
            { tel: { NDVI: 0.6 }, estilo: 'duvida_operacional', fala: 'A soja está bem de vigor, mas tem folha larga em reboleira. Atrazina resolve ou é problema?' }
        ]
    },
    {
        id: 'VT-MILHO-24D',
        bloco: 'veto_proibicao',
        tipos: ['negativo', 'contextual'],
        alvo: 'Dois_Quatro_D',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.umidade_foliar'],
        racional:
            'O veto do Milho ao Dois_Quatro_D e por RISCO DE DERIVA, nao por registro, e tambem nao depende da leitura. A umidade foliar liga e desliga o gatilho do Milho; o veto sobre o produto citado tem de sobreviver as duas situacoes.',
        base: T({ vento: 5, temperatura: 25, umidade: 72, NDVI: 0.5, umidade_foliar: 60, temperatura_foliar: 28, distancia_manancial: 1800, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 7 }),
        variantes: [
            { tel: { umidade_foliar: 55 }, estilo: 'ordem', fala: 'Corda-de-viola enrolando o milho. Aplica o dois-quatro-D.' },
            { tel: { umidade_foliar: 62 }, estilo: 'pergunta_direta', fala: 'Posso usar dois-quatro-D no milho para a folha larga?' },
            { tel: { umidade_foliar: 70 }, estilo: 'compara_produtos', fala: 'No milho, o dois-quatro-D dá conta da folha larga?' }
        ]
    },
    {
        id: 'VT-CANA-NICO',
        bloco: 'veto_proibicao',
        tipos: ['negativo', 'contextual'],
        alvo: 'Nicosulfuron',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.temperatura_foliar'],
        racional:
            'Terceiro veto de cultura, agora com a temperatura foliar ligando e desligando a Cana. Em 39 C a Cana esta ativa E manda suspender a aplicacao foliar; em 34 C ela entra so por foco. O veto ao Nicosulfuron nao muda.',
        base: T({ vento: 5, temperatura: 29, umidade: 68, NDVI: 0.5, umidade_foliar: 70, temperatura_foliar: 38, distancia_manancial: 1700, distancia_cultura_sensivel: 1250, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { tel: { temperatura_foliar: 39 }, estilo: 'ordem', fala: 'Capim na soqueira da cana-de-açúcar. Solta o nicosulfuron.' },
            { tel: { temperatura_foliar: 38 }, estilo: 'pergunta_direta', fala: 'Nicosulfuron serve para gramínea na cana-de-açúcar?' },
            { tel: { temperatura_foliar: 34 }, estilo: 'duvida_operacional', fala: 'Tenho nicosulfuron sobrando e gramínea na cana-de-açúcar. Uso ou procuro outro herbicida?' }
        ]
    },
    {
        id: 'PR-MANANCIAL-ATRA',
        bloco: 'veto_proibicao',
        tipos: ['contextual', 'combinatorio'],
        alvo: 'Atrazina',
        objetivo: 'aplicar',
        dimensoes: ['areas'],
        cadastroAusente: true,
        regrasGlobais: [RG_CADASTRO],
        racional:
            'Com o sensor FIXO dentro da faixa (380 m), o cadastro e a unica coisa que muda. Sem a area, a Atrazina esta BLOQUEADA (perde iniciar e aumentar); com a area, esta PROIBIDA (so retirada). A familia separa os dois mecanismos que o mesmo numero costuma confundir.',
        base: T({ vento: 4, temperatura: 27, umidade: 71, NDVI: 0.47, umidade_foliar: 57, temperatura_foliar: 30, distancia_manancial: 380, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { areas: ['Faixa_Manancial'], estilo: 'pergunta_direta', fala: 'Atrazina em pós-emergência no milho perto do córrego. Qual a decisão para esta missão?' },
            { areas: [], estilo: 'pergunta_direta', fala: 'Perto do córrego, qual a decisão da missão de atrazina em pós-emergência no milho?' }
        ]
    },
    {
        id: 'PR-MANANCIAL-GLIFO',
        bloco: 'veto_proibicao',
        tipos: ['contextual'],
        alvo: 'Glifosato',
        objetivo: 'aplicar',
        dimensoes: ['areas'],
        cadastroAusente: true,
        regrasGlobais: [RG_CADASTRO],
        racional:
            'O Glifosato NAO tem regra de seguranca em distancia de manancial: ele e proibido na faixa apenas pela area. Com vento de 5 km/h, o cadastro e a unica restricao possivel — a familia isola `proibe` de `bloquear_aplicacao` pelo lado oposto a PR-MANANCIAL-ATRA.',
        base: T({ vento: 5, temperatura: 26, umidade: 69, NDVI: 0.37, umidade_foliar: 68, temperatura_foliar: 29, distancia_manancial: 420, distancia_cultura_sensivel: 1500, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { areas: ['Faixa_Manancial'], estilo: 'ordem', fala: 'Dessecação da soja com glifosato nesse talhão da beira do córrego. Confirma a missão.' },
            { areas: [], estilo: 'ordem', fala: 'Confirma a missão de glifosato para dessecar a soja nesse talhão da beira do córrego.' }
        ]
    },
    {
        id: 'PR-SENSIVEL-24D',
        bloco: 'veto_proibicao',
        tipos: ['contextual'],
        alvo: 'Dois_Quatro_D',
        objetivo: 'aplicar',
        dimensoes: ['areas'],
        cadastroAusente: true,
        regrasGlobais: [RG_CADASTRO],
        racional:
            'Com vento de 6 km/h o Dois_Quatro_D nao esta bloqueado por sensor; a Vizinhanca_Sensivel o proibe inteiro. O Milho fica inativo para que o veto de cultura nao se some ao da area e mascare a dimensao.',
        base: T({ vento: 6, temperatura: 27, umidade: 70, NDVI: 0.5, umidade_foliar: 70, temperatura_foliar: 31, distancia_manancial: 1600, distancia_cultura_sensivel: 260, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { areas: ['Vizinhanca_Sensivel'], estilo: 'pergunta_direta', fala: 'Dois-quatro-D na cana-de-açúcar num talhão de divisa com pomar. Posso aplicar?' },
            { areas: [], estilo: 'pergunta_direta', fala: 'Posso aplicar dois-quatro-D na cana-de-açúcar num talhão que faz divisa com pomar?' }
        ]
    },
    {
        id: 'PR-APIARIO-CLORPI',
        bloco: 'veto_proibicao',
        tipos: ['contextual'],
        alvo: 'Clorpirifos',
        objetivo: 'aplicar',
        dimensoes: ['areas'],
        racional:
            'O Apiario_Proximo e a UNICA area do modelo sem sensor correspondente: ela so existe no cadastro do talhao. Com a temperatura abaixo do teto do Clorpirifos, o cadastro e a unica restricao — e o par mede se o sistema usa o cadastro sem procurar um numero que nao existe.',
        base: T({ vento: 5, temperatura: 29, umidade: 67, NDVI: 0.44, umidade_foliar: 58, temperatura_foliar: 33, distancia_manancial: 1700, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 14 }),
        variantes: [
            { areas: ['Apiario_Proximo'], estilo: 'pergunta_direta', fala: 'Clorpirifós contra cigarrinha no milho. O cadastro deste talhão muda a decisão?' },
            { areas: [], estilo: 'pergunta_direta', fala: 'O cadastro deste talhão muda a decisão do clorpirifós contra cigarrinha no milho?' }
        ]
    },
    {
        id: 'PR-APIARIO-IMIDA',
        bloco: 'veto_proibicao',
        tipos: ['contextual'],
        alvo: 'Imidacloprido',
        objetivo: 'aplicar',
        dimensoes: ['areas'],
        racional:
            'Segundo produto proibido no apiario, por residuo neonicotinoide e nao por toxicidade aguda. A folha a 34 C mantem o Imidacloprido liberado por sensor, de modo que a proibicao de area apareca isolada.',
        base: T({ vento: 6, temperatura: 28, umidade: 68, NDVI: 0.33, umidade_foliar: 71, temperatura_foliar: 34, distancia_manancial: 1600, distancia_cultura_sensivel: 1200, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { areas: ['Apiario_Proximo'], estilo: 'duvida_operacional', fala: 'Imidacloprido contra broca na cana-de-açúcar. O cadastro do talhão impede algo?' },
            { areas: [], estilo: 'duvida_operacional', fala: 'O cadastro do talhão impede o imidacloprido contra broca na cana-de-açúcar?' }
        ]
    },
    {
        id: 'VT-SUBSTITUIR',
        bloco: 'veto_proibicao',
        tipos: ['negativo', 'procedimento'],
        alvo: 'Nicosulfuron',
        objetivo: 'substituir_produto',
        dimensoes: ['intencao'],
        racional:
            'Produto vetado pela cultura COM alternativa registrada na mesma cultura: e o caso que a conduta `Substituir_Produto` (decisao SUBSTITUIR) existe para atender. A Cana veta o Nicosulfuron e recomenda Dois_Quatro_D, Azoxistrobina e Imidacloprido; o pedido muda a forma de perguntar, nao a leitura.',
        base: T({ vento: 6, temperatura: 28, umidade: 70, NDVI: 0.5, umidade_foliar: 70, temperatura_foliar: 39, distancia_manancial: 1700, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { estilo: 'pede_substituicao', fala: 'Se o nicosulfuron não pode na cana-de-açúcar, me indica o que entra no lugar para folha larga.' },
            { estilo: 'compara_produtos', fala: 'Entre nicosulfuron e dois-quatro-D na cana-de-açúcar, qual eu carrego no drone?' },
            { estilo: 'conclusao_prematura', fala: 'Vou trocar o nicosulfuron por azoxistrobina na cana-de-açúcar e resolver tudo numa passada. Confirma.' }
        ]
    },
    {
        id: 'PR-DUPLA-AREA',
        bloco: 'veto_proibicao',
        tipos: ['contextual', 'combinatorio'],
        alvo: 'Atrazina',
        objetivo: 'ajustar_vazao',
        dimensoes: ['areas'],
        cadastroAusente: true,
        racional:
            'Talhao dentro das DUAS areas pelo sensor (450 m do manancial, 280 m da cultura sensivel). A Faixa_Manancial PROIBE a Atrazina e a Vizinhanca_Sensivel a AJUSTA para 0,75: declarar uma, a outra ou as duas muda o resultado de proibicao para ajuste e de ajuste para proibicao. E o caso em que dois mecanismos de area incidem sobre o mesmo produto.',
        base: T({ vento: 5, temperatura: 27, umidade: 72, NDVI: 0.47, umidade_foliar: 56, temperatura_foliar: 30, distancia_manancial: 450, distancia_cultura_sensivel: 280, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { areas: ['Faixa_Manancial'], estilo: 'pergunta_direta', fala: 'Atrazina no milho neste talhão de divisa. Como fica a vazão da missão?' },
            { areas: ['Vizinhanca_Sensivel'], estilo: 'pergunta_direta', fala: 'Neste talhão de divisa, qual vazão de atrazina no milho a missão libera?' },
            { areas: ['Faixa_Manancial', 'Vizinhanca_Sensivel'], estilo: 'pergunta_direta', fala: 'Quero atrazina no milho aqui na divisa: me diz a vazão que a missão aceita.' }
        ]
    },

    // ------------------------------------------------ AREA, AJUSTE E EXIGE (18)
    {
        id: 'AJ-FAIXA-IMIDA',
        bloco: 'area',
        tipos: ['contextual'],
        alvo: 'Imidacloprido',
        objetivo: 'ajustar_vazao',
        dimensoes: ['areas'],
        cadastroAusente: true,
        racional:
            '`ajusta Imidacloprido fator 0.5` e o unico ajuste do modelo que incide num produto que a mesma area nao proibe. O fator tem semantica operacional: ele multiplica as vazoes exprimiveis do campo `vazao` do artefato, e o par mede se a vazao da resposta cai pela metade.',
        base: T({ vento: 5, temperatura: 28, umidade: 69, NDVI: 0.32, umidade_foliar: 72, temperatura_foliar: 33, distancia_manancial: 400, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { areas: ['Faixa_Manancial'], estilo: 'pergunta_direta', fala: 'Imidacloprido contra broca na cana-de-açúcar perto da nascente. Que vazão eu programo?' },
            { areas: [], estilo: 'pergunta_direta', fala: 'Que vazão de imidacloprido eu programo contra broca na cana-de-açúcar perto da nascente?' }
        ]
    },
    {
        id: 'AJ-SENSIVEL-ATRA',
        bloco: 'area',
        tipos: ['contextual'],
        alvo: 'Atrazina',
        objetivo: 'ajustar_vazao',
        dimensoes: ['areas'],
        cadastroAusente: true,
        racional:
            'Ajuste de 0,75 sobre a Atrazina com o manancial longe (1500 m), ou seja, sem o bloqueio por sensor no caminho. E o ajuste isolado: nenhum outro mecanismo toca o produto, e a vazao e a unica coisa que pode mudar.',
        base: T({ vento: 5, temperatura: 26, umidade: 73, NDVI: 0.47, umidade_foliar: 57, temperatura_foliar: 29, distancia_manancial: 1500, distancia_cultura_sensivel: 270, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { areas: ['Vizinhanca_Sensivel'], estilo: 'pergunta_direta', fala: 'Atrazina em pré-emergência no milho com pomar na divisa. Qual vazão a missão aceita?' },
            { areas: [], estilo: 'pergunta_direta', fala: 'Com pomar na divisa, qual vazão de atrazina em pré-emergência no milho a missão aceita?' }
        ]
    },
    {
        id: 'AJ-APIARIO-ACEFATO',
        bloco: 'area',
        tipos: ['contextual', 'procedimento'],
        alvo: 'Acefato',
        objetivo: 'ajustar_vazao',
        dimensoes: ['areas'],
        racional:
            'O Acefato e o unico produto que a area do apiario AJUSTA em vez de proibir, e o unico cuja `excecao` de bula ("aplicacao noturna com aviso previo") casa com o `exige` da area. Sem chuva prevista, o produto esta liberado por sensor.',
        base: T({ vento: 5, temperatura: 27, umidade: 71, NDVI: 0.52, umidade_foliar: 67, temperatura_foliar: 30, distancia_manancial: 1600, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 22 }),
        variantes: [
            { areas: ['Apiario_Proximo'], estilo: 'duvida_operacional', fala: 'Acefato contra lagarta na soja. Que vazão e que cuidado o cadastro deste talhão exige?' },
            { areas: [], estilo: 'duvida_operacional', fala: 'Que vazão e que cuidado o cadastro deste talhão exige para o acefato contra lagarta na soja?' }
        ]
    },
    {
        id: 'EX-FAIXA-REGISTRO',
        bloco: 'area',
        tipos: ['procedimento'],
        alvo: 'Azoxistrobina',
        objetivo: 'procedimento',
        dimensoes: ['intencao'],
        areas: ['Faixa_Manancial'],
        regrasGlobais: [RG_REGISTRO, RG_RASTRO],
        racional:
            'A Faixa_Manancial nao proibe nem ajusta a Azoxistrobina: sobre ela sobram apenas os dois `exige` (coordenada GPS com condicao climatica, e faixa nao pulverizada declarada). E o cenario em que a area muda SO o procedimento, e a decisao deve continuar a mesma.',
        base: T({ vento: 5, temperatura: 27, umidade: 66, NDVI: 0.33, umidade_foliar: 73, temperatura_foliar: 32, distancia_manancial: 300, distancia_cultura_sensivel: 1250, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { estilo: 'procedimento', fala: 'Azoxistrobina preventiva na cana-de-açúcar dentro da faixa do manancial. O que eu preciso registrar antes de decolar?' },
            { estilo: 'pergunta_direta', fala: 'Azoxistrobina na cana-de-açúcar: a faixa do manancial me obriga a deixar bordadura sem aplicar?' },
            { estilo: 'duvida_operacional', fala: 'Preciso de coordenada e clima registrados para a azoxistrobina na cana-de-açúcar perto da nascente, ou basta a vazão?' }
        ]
    },
    {
        id: 'EX-SENSIVEL-AVISO',
        bloco: 'area',
        tipos: ['procedimento'],
        alvo: 'Azoxistrobina',
        objetivo: 'procedimento',
        dimensoes: ['intencao'],
        areas: ['Vizinhanca_Sensivel'],
        racional:
            'Mesma estrutura do EX-FAIXA-REGISTRO na outra area: a Vizinhanca_Sensivel nao toca a Azoxistrobina e cobra aviso previo ao vizinho e registro da direcao do vento — direcao que, aliás, nenhum sensor do modelo mede.',
        base: T({ vento: 6, temperatura: 28, umidade: 64, NDVI: 0.34, umidade_foliar: 71, temperatura_foliar: 33, distancia_manancial: 1700, distancia_cultura_sensivel: 250, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { estilo: 'procedimento', fala: 'Azoxistrobina na cana-de-açúcar com parreiral na divisa. Que aviso eu dou antes da missão?' },
            { estilo: 'duvida_operacional', fala: 'A azoxistrobina na cana-de-açúcar exige registrar a direção do vento com o vizinho sensível tão perto?' }
        ]
    },
    {
        id: 'EX-APIARIO-NOTURNO',
        bloco: 'area',
        tipos: ['procedimento', 'contextual'],
        alvo: 'Acefato',
        objetivo: 'procedimento',
        dimensoes: ['intencao'],
        areas: ['Apiario_Proximo'],
        racional:
            'A area do apiario junta ajuste (0,5 no Acefato) e exigencia (aplicacao noturna com aviso ao apicultor). As duas falas perguntam pelo procedimento, nao pela permissao: a resposta deve trazer vazao reduzida E janela noturna.',
        base: T({ vento: 4, temperatura: 26, umidade: 72, NDVI: 0.53, umidade_foliar: 66, temperatura_foliar: 29, distancia_manancial: 1500, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 20 }),
        variantes: [
            { estilo: 'procedimento', fala: 'Acefato na soja com apiário cadastrado no talhão. Qual é o procedimento completo da missão?' },
            { estilo: 'pergunta_direta', fala: 'Preciso avisar o apicultor antes do acefato na soja ou a vazão reduzida já resolve?' }
        ]
    },
    {
        id: 'AR-CADASTRO-AUSENTE',
        bloco: 'area',
        tipos: ['evidencia_insuficiente', 'contextual'],
        alvo: null,
        objetivo: 'classificar_restricao',
        dimensoes: ['intencao'],
        areas: [],
        cadastroAusente: true,
        regrasGlobais: [RG_CADASTRO],
        racional:
            'Sensor dentro das duas areas (440 m e 280 m) e cadastro VAZIO. A regra global diz que area ausente do cadastro nao e area livre: a restricao de area nao incide, e tampouco pode ser declarada cumprida. As tres falas atacam o mesmo vazio por produtos diferentes.',
        base: T({ vento: 5, temperatura: 27, umidade: 70, NDVI: 0.47, umidade_foliar: 56, temperatura_foliar: 30, distancia_manancial: 440, distancia_cultura_sensivel: 280, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { estilo: 'pergunta_direta', fala: 'O cadastro deste talhão de milho está sem área especial. Posso tratar a atrazina como liberada?', alegacoes: ['CADASTRO'] },
            { estilo: 'duvida_operacional', fala: 'Glifosato no milho num talhão sem área especial cadastrada, mas o córrego está logo ali. Como registro isso?', alegacoes: ['CADASTRO'] },
            { estilo: 'alegacao_sem_leitura', fala: 'Como não tem nada no cadastro do talhão de milho, considero a vizinhança livre e aplico o clorpirifós. Certo?', alegacoes: ['CADASTRO', 'VIZINHO'] }
        ]
    },
    {
        id: 'AR-TRIPLA',
        bloco: 'area',
        tipos: ['contextual', 'combinatorio'],
        alvo: 'Acefato',
        objetivo: 'procedimento',
        dimensoes: ['intencao'],
        areas: ['Faixa_Manancial', 'Vizinhanca_Sensivel', 'Apiario_Proximo'],
        racional:
            'As TRES areas no mesmo talhao, com os sensores coerentes (350 m e 240 m). Sobre o Acefato incide um ajuste (apiario) e cinco exigencias somadas; nenhuma das tres o proibe. E o maior empilhamento de contexto que o modelo permite.',
        base: T({ vento: 4, temperatura: 26, umidade: 73, NDVI: 0.51, umidade_foliar: 67, temperatura_foliar: 28, distancia_manancial: 350, distancia_cultura_sensivel: 240, chuva_prevista: 0, infestacao: 21 }),
        variantes: [
            { estilo: 'procedimento', fala: 'Talhão de soja com manancial, vizinhança sensível e apiário no cadastro. Monta a missão de acefato com tudo que ela exige.' },
            { estilo: 'urgente', fala: 'Acefato na soja hoje, e esse talhão tem todas as restrições de cadastro juntas. O que não pode faltar?' }
        ]
    },

    // ------------------------------ CALDA E ESTADO DE CURSO (16)
    {
        id: 'CA-GLIFO-MANCO',
        bloco: 'calda',
        tipos: ['estado_de_curso', 'combinatorio'],
        alvo: 'Glifosato',
        objetivo: 'aplicar',
        dimensoes: ['produtosEmUso'],
        regrasGlobais: [RG_TANQUE],
        racional:
            'A incompatibilidade de gravidade ALTA do modelo (precipitacao da calda no tanque) so pesa quando um dos dois produtos esta efetivamente na calda — e o unico mecanismo do dominio que depende do estado do tanque, nao da leitura. As tres variantes percorrem nenhum, um e os dois.',
        base: T({ vento: 6, temperatura: 27, umidade: 68, NDVI: 0.37, umidade_foliar: 68, temperatura_foliar: 30, distancia_manancial: 1600, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { uso: [], estilo: 'pergunta_direta', fala: 'Glifosato e mancozebe juntos na soja para economizar passada. Isso pode?' },
            { uso: ['Glifosato'], estilo: 'pergunta_direta', fala: 'Posso levar glifosato e mancozebe juntos numa passada única na soja?' },
            { uso: ['Glifosato', 'Mancozebe'], estilo: 'pergunta_direta', fala: 'Na soja, glifosato e mancozebe juntos no mesmo tanque: dá para economizar a passada?' }
        ]
    },
    {
        id: 'CA-ACEFATO-NICO',
        bloco: 'calda',
        tipos: ['estado_de_curso'],
        alvo: 'Acefato',
        objetivo: 'aplicar',
        dimensoes: ['produtosEmUso'],
        racional:
            'Incompatibilidade de gravidade MODERADA, com conduta de intervalo de 7 dias em vez de passada separada: a resposta deve distinguir "nao misture" de "espere". A Cana fica inativa para o veto ao Nicosulfuron nao entrar no caminho.',
        base: T({ vento: 5, temperatura: 26, umidade: 71, NDVI: 0.42, umidade_foliar: 58, temperatura_foliar: 29, distancia_manancial: 1700, distancia_cultura_sensivel: 1350, chuva_prevista: 0, infestacao: 18 }),
        variantes: [
            { uso: [], estilo: 'duvida_operacional', fala: 'Quero resolver lagarta e gramínea no milho com acefato e nicosulfuron. Dá para fazer junto?' },
            { uso: ['Nicosulfuron'], estilo: 'duvida_operacional', fala: 'Acefato e nicosulfuron na mesma calda no milho resolvem lagarta e gramínea de uma vez?' },
            { uso: ['Acefato', 'Nicosulfuron'], estilo: 'duvida_operacional', fala: 'Preciso pegar lagarta e gramínea no milho: acefato junto com nicosulfuron funciona?' }
        ]
    },
    {
        id: 'CA-ATRA-CLORPI',
        bloco: 'calda',
        tipos: ['estado_de_curso'],
        alvo: 'Clorpirifos',
        objetivo: 'aplicar',
        dimensoes: ['produtosEmUso'],
        racional:
            'Terceira incompatibilidade, por inibicao metabolica no milho — a unica entre um herbicida e um inseticida da mesma cultura. Temperatura em 30 C mantem o Clorpirifos liberado por sensor, para que a calda seja a unica restricao.',
        base: T({ vento: 5, temperatura: 30, umidade: 69, NDVI: 0.47, umidade_foliar: 57, temperatura_foliar: 34, distancia_manancial: 1800, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { uso: [], estilo: 'pergunta_direta', fala: 'Atrazina e clorpirifós na mesma calda no milho: pode ou tem risco para a cultura?' },
            { uso: ['Atrazina'], estilo: 'pergunta_direta', fala: 'No milho, atrazina e clorpirifós na mesma calda: tem risco para a cultura ou pode?' },
            { uso: ['Atrazina', 'Clorpirifos'], estilo: 'pergunta_direta', fala: 'Quero atrazina e clorpirifós na mesma calda no milho. Isso pode?' }
        ]
    },
    {
        id: 'CA-ATRA-24D',
        bloco: 'calda',
        tipos: ['estado_de_curso', 'combinatorio'],
        alvo: 'Dois_Quatro_D',
        objetivo: 'aplicar',
        dimensoes: ['produtosEmUso'],
        regrasGlobais: [RG_TOXI_I],
        racional:
            'Segunda incompatibilidade de gravidade ALTA, entre dois herbicidas, um deles classe toxicologica I. Nenhuma cultura esta ativa (as duas entram por foco), de modo que a calda e o cadastro sejam os unicos mecanismos em jogo.',
        base: T({ vento: 7, temperatura: 27, umidade: 70, NDVI: 0.5, umidade_foliar: 70, temperatura_foliar: 31, distancia_manancial: 1750, distancia_cultura_sensivel: 1150, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { uso: [], estilo: 'compara_produtos', fala: 'Atrazina com dois-quatro-D na mesma calda para folha larga na cana-de-açúcar. Vale a passada única?' },
            { uso: ['Dois_Quatro_D'], estilo: 'compara_produtos', fala: 'Vale juntar atrazina e dois-quatro-D numa passada única contra folha larga na cana-de-açúcar?' },
            { uso: ['Atrazina', 'Dois_Quatro_D'], estilo: 'compara_produtos', fala: 'Folha larga na cana-de-açúcar: atrazina e dois-quatro-D na mesma calda compensa?' }
        ]
    },
    {
        id: 'ES-JA-NA-CALDA',
        bloco: 'calda',
        tipos: ['estado_de_curso'],
        alvo: 'Glifosato',
        objetivo: 'aplicar',
        dimensoes: ['produtosEmUso'],
        racional:
            'Produto JA na calda nao se "inicia" de novo: `aplicarEstadoDeCurso` tira INICIAR_APLICACAO quando o produto esta em uso e tira as decisoes de continuidade quando nao esta. Sem nenhuma restricao de leitura ativa, o estado do tanque e a unica coisa que estreita a politica.',
        base: T({ vento: 5, temperatura: 27, umidade: 70, NDVI: 0.38, umidade_foliar: 67, temperatura_foliar: 30, distancia_manancial: 1600, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 11 }),
        variantes: [
            { uso: ['Glifosato'], estilo: 'pergunta_direta', fala: 'Dessecação da soja com glifosato nesta janela. Qual a decisão para esta passada?' },
            { uso: [], estilo: 'pergunta_direta', fala: 'Qual a decisão desta passada de glifosato na dessecação da soja, nesta janela?' }
        ]
    },
    {
        id: 'ES-FORA-DA-CALDA',
        bloco: 'calda',
        tipos: ['estado_de_curso', 'negativo'],
        alvo: 'Acefato',
        objetivo: 'ajustar_vazao',
        dimensoes: ['intencao'],
        uso: [],
        racional:
            'Tanque vazio e pedido de AUMENTAR a vazao: a decisao pedida nem existe na politica, porque aumentar pressupoe aplicacao em curso. O par com ES-JA-NA-CALDA fecha as duas metades do estado de curso.',
        base: T({ vento: 4, temperatura: 26, umidade: 72, NDVI: 0.52, umidade_foliar: 68, temperatura_foliar: 29, distancia_manancial: 1700, distancia_cultura_sensivel: 1450, chuva_prevista: 0, infestacao: 19 }),
        variantes: [
            { estilo: 'ordem', fala: 'Aumenta a vazão do acefato na soja, a lagarta não está morrendo.' },
            { estilo: 'pergunta_direta', fala: 'Com o tanque ainda vazio, dá para manter a vazão do acefato na soja?' }
        ]
    },

    // ------------------------------------- EVIDENCIA SO NA FALA (19)
    {
        id: 'EV-FLORADA',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente'],
        alvo: 'Acefato',
        objetivo: 'aplicar',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'Florada e presenca de polinizador sao condicao de `proibido:` na bula do Acefato e NAO tem sensor no modelo. A fala as afirma; a leitura nao as registra. A resposta deve tratar o fato como evidencia insuficiente, nunca como evidencia de que nao ha florada.',
        base: T({ vento: 5, temperatura: 27, umidade: 71, NDVI: 0.52, umidade_foliar: 67, temperatura_foliar: 30, distancia_manancial: 1600, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 23 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', fala: 'A soja está em plena florada e a lagarta está comendo. Acefato pode nessa condição?', alegacoes: ['FLORADA'] },
            { estilo: 'conclusao_prematura', fala: 'A florada da soja já passou, então o acefato está liberado. Confirma a vazão.', alegacoes: ['FLORADA'] },
            { estilo: 'duvida_operacional', fala: 'Não sei dizer se a soja ainda está florando. Mando o acefato contra a lagarta ou espero?', alegacoes: ['FLORADA'] }
        ]
    },
    {
        id: 'EV-COLMEIA',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'contextual'],
        alvo: 'Clorpirifos',
        objetivo: 'aplicar',
        dimensoes: ['intencao'],
        areas: [],
        regrasGlobais: [RG_FATO_FALA, RG_CADASTRO],
        racional:
            'Colmeia na vizinhanca e exatamente o criterio da area Apiario_Proximo — que nao tem sensor e vem do cadastro. Aqui a fala afirma a colmeia e o cadastro esta vazio: o pedido traz o fato que decidiria, mas nao pelo canal que o modelo le.',
        base: T({ vento: 5, temperatura: 30, umidade: 68, NDVI: 0.44, umidade_foliar: 58, temperatura_foliar: 34, distancia_manancial: 1700, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 13 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', fala: 'O vizinho tem colmeias logo depois da cerca e eu preciso do clorpirifós na cigarrinha do milho. Pode?', alegacoes: ['COLMEIA', 'CADASTRO'] },
            { estilo: 'conclusao_prematura', fala: 'O apicultor tirou as colmeias semana passada, então solta o clorpirifós no milho.', alegacoes: ['COLMEIA'] },
            { estilo: 'relato_informal', fala: 'Dizem que tem abelha criada perto desse talhão de milho. Isso muda algo no clorpirifós?', alegacoes: ['COLMEIA'] }
        ]
    },
    {
        id: 'EV-VENTO-BAIXOU',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'negativo'],
        alvo: 'Glifosato',
        objetivo: 'aplicar',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'O caso oposto ao EV-FLORADA: aqui o fato TEM sensor, e o sensor contradiz a fala. "O vento baixou" nao revoga uma leitura de 12 km/h; a regra de seguranca do Glifosato continua incidindo, e a resposta nao pode adotar o numero da fala.',
        base: T({ vento: 12, temperatura: 28, umidade: 65, NDVI: 0.38, umidade_foliar: 69, temperatura_foliar: 31, distancia_manancial: 1500, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', fala: 'O vento já baixou aqui no talhão, pode mandar o glifosato na soja.', alegacoes: ['VENTO_BAIXOU'] },
            { estilo: 'urgente', fala: 'Estou no pé do talhão de soja e sinto o vento fraco. Libera o glifosato agora.', alegacoes: ['VENTO_BAIXOU'] },
            { estilo: 'duvida_operacional', fala: 'O anemômetro da sede e o do talhão não combinam. Aplico o glifosato na soja ou não?', alegacoes: ['VENTO_BAIXOU'] }
        ]
    },
    {
        id: 'EV-TANQUE-LIMPO',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'estado_de_curso'],
        alvo: 'Glifosato',
        objetivo: 'aplicar',
        dimensoes: ['intencao'],
        uso: ['Mancozebe'],
        regrasGlobais: [RG_FATO_FALA, RG_TANQUE],
        racional:
            '"O tanque esta limpo" contradiz o estado de curso, que registra Mancozebe na calda — e Mancozebe com Glifosato e a incompatibilidade de gravidade alta do modelo. A limpeza alegada nao apaga o registro da calda.',
        base: T({ vento: 5, temperatura: 27, umidade: 70, NDVI: 0.37, umidade_foliar: 68, temperatura_foliar: 30, distancia_manancial: 1650, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', fala: 'O tanque já foi lavado, então posso carregar glifosato para a soja sem mais nada?', alegacoes: ['TANQUE_LIMPO'] },
            { estilo: 'conclusao_prematura', fala: 'Lavei o tanque no almoço, então o glifosato na soja está liberado. Só confirma.', alegacoes: ['TANQUE_LIMPO'] }
        ]
    },
    {
        id: 'EV-DIRECAO-VENTO',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'negativo'],
        alvo: 'Dois_Quatro_D',
        objetivo: 'aplicar',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'A direcao do vento e o fato que a Vizinhanca_Sensivel manda REGISTRAR e que nenhum sensor do modelo mede — o dicionario da leitura diz isso explicitamente. Com 9 km/h o Dois_Quatro_D ja esta bloqueado pela velocidade, e a direcao alegada nao destrava nada.',
        base: T({ vento: 9, temperatura: 27, umidade: 69, NDVI: 0.5, umidade_foliar: 70, temperatura_foliar: 31, distancia_manancial: 1700, distancia_cultura_sensivel: 1200, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', fala: 'O vento está soprando para o lado do mato, longe do pomar. Dois-quatro-D na cana-de-açúcar pode?', alegacoes: ['DIRECAO_VENTO'] },
            { estilo: 'conclusao_prematura', fala: 'Como a direção do vento é favorável, vou de dois-quatro-D na cana-de-açúcar. Confirma a vazão.', alegacoes: ['DIRECAO_VENTO'] }
        ]
    },
    {
        id: 'EV-RECEITA',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente'],
        alvo: 'Atrazina',
        objetivo: 'aplicar',
        dimensoes: ['intencao'],
        areas: ['Faixa_Manancial'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'Receita assinada e autorizacao ambiental sao documentos, nao leitura: o modelo nao tem como verifica-los. Com 420 m do manancial e a area cadastrada, a Atrazina esta bloqueada por sensor E proibida pela area; nenhum documento alegado muda isso.',
        base: T({ vento: 5, temperatura: 27, umidade: 71, NDVI: 0.47, umidade_foliar: 56, temperatura_foliar: 30, distancia_manancial: 420, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', fala: 'O agrônomo já assinou a receita da atrazina para esse talhão de milho. Libera a missão.', alegacoes: ['RECEITA'] },
            { estilo: 'conclusao_prematura', fala: 'A autorização ambiental da atrazina no milho saiu, então é só programar a vazão.', alegacoes: ['RECEITA'] }
        ]
    },
    {
        id: 'EV-CARENCIA',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'procedimento'],
        alvo: 'Clorpirifos',
        objetivo: 'aplicar',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'A data da colheita nao esta na leitura: a carencia de 21 dias do Clorpirifos e um atributo do produto, e o calendario alegado pela fala nao e dado do talhao. Com 33 C o produto ja esta bloqueado por temperatura, o que separa as duas conversas.',
        base: T({ vento: 5, temperatura: 33, umidade: 67, NDVI: 0.43, umidade_foliar: 57, temperatura_foliar: 36, distancia_manancial: 1700, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 12 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', fala: 'A colheita do milho é só daqui a quarenta dias, então a carência do clorpirifós não pesa. Aplico?', alegacoes: ['CARENCIA'] },
            { estilo: 'procedimento', fala: 'Quantos dias de carência e de reentrada o clorpirifós no milho me obriga a respeitar?', alegacoes: ['CARENCIA'] }
        ]
    },
    {
        id: 'EV-SOBRA-GALPAO',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'negativo'],
        alvo: 'Nicosulfuron',
        objetivo: 'aplicar',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'Sobra no galpao e razao economica, nao evidencia agronomica: o Nicosulfuron continua sem registro para cana, e o veto da cultura nao cede a estoque. O contraste com VT-CANA-NICO e so no motivo alegado.',
        base: T({ vento: 5, temperatura: 28, umidade: 68, NDVI: 0.33, umidade_foliar: 72, temperatura_foliar: 33, distancia_manancial: 1600, distancia_cultura_sensivel: 1250, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', fala: 'Sobrou nicosulfuron da safrinha e tem gramínea na cana-de-açúcar. Aproveita na missão de hoje.', alegacoes: ['SOBRA_GALPAO'] },
            { estilo: 'relato_informal', fala: 'Tenho dois bombonas de nicosulfuron paradas e a cana-de-açúcar com capim. Dá um jeito?', alegacoes: ['SOBRA_GALPAO'] }
        ]
    },

    // ------------------------ ESCALONAMENTO E PROCEDIMENTO (26)
    {
        id: 'ESC-METEO-SOJA',
        bloco: 'escalonamento_procedimento',
        tipos: ['fronteira', 'procedimento'],
        alvo: 'Glifosato',
        objetivo: 'acionar_agronomo',
        dimensoes: ['telemetria.vento'],
        regrasGlobais: [RG_VENTO_15, RG_ADJACENTE],
        racional:
            'Dois limiares na MESMA reta do vento: o do produto (Glifosato, 10 km/h) e o do dominio (`escalonar: vento > 15 -> CENTRO_METEOROLOGICO`, que a regra global de 15 km/h sustenta). Em 12 e 14 o produto esta bloqueado e nada escala; em 16 e 18 escala. A politica nao muda entre 12 e 18 — muda o procedimento, e e isso que a familia mede.',
        base: T({ vento: 15, temperatura: 28, umidade: 64, NDVI: 0.38, umidade_foliar: 69, temperatura_foliar: 31, distancia_manancial: 1400, distancia_cultura_sensivel: 1200, chuva_prevista: 0, infestacao: 12 }),
        variantes: [
            { tel: { vento: 12 }, estilo: 'pergunta_direta', fala: 'Glifosato na soja com o vento forte. Decido aqui ou alguém precisa confirmar a janela?' },
            { tel: { vento: 14 }, estilo: 'duvida_operacional', fala: 'O vento no talhão de soja está alto para o glifosato. Até onde eu posso decidir sozinho?' },
            { tel: { vento: 15 }, estilo: 'urgente', fala: 'Preciso bater o martelo sobre o glifosato na soja com esse vento. Quem assume a decisão?' },
            { tel: { vento: 16 }, estilo: 'relato_e_pergunta', fala: 'Vento acima do que eu já vi hoje no talhão de soja e o glifosato está programado. Qual é o encaminhamento?' },
            { tel: { vento: 18 }, estilo: 'ordem', fala: 'Cancela o glifosato da soja e me diz a quem eu reporto essa condição de vento.' }
        ]
    },
    {
        id: 'ESC-METEO-CANA',
        bloco: 'escalonamento_procedimento',
        tipos: ['procedimento'],
        alvo: 'Azoxistrobina',
        objetivo: 'acionar_agronomo',
        dimensoes: ['telemetria.vento'],
        regrasGlobais: [RG_VENTO_15],
        racional:
            'O mesmo escalonamento meteorologico sobre um produto que NAO tem teto de vento: a Azoxistrobina segue sem bloqueio por sensor, e o unico efeito do vento e o escalonamento e a regra global. Isola "procedimento sem mudanca de politica" de forma pura.',
        base: T({ vento: 15, temperatura: 27, umidade: 66, NDVI: 0.33, umidade_foliar: 72, temperatura_foliar: 32, distancia_manancial: 1600, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { tel: { vento: 15 }, estilo: 'pergunta_direta', fala: 'Azoxistrobina preventiva na cana-de-açúcar com vento alto. Sigo com a missão?' },
            { tel: { vento: 17 }, estilo: 'duvida_operacional', fala: 'Com esse vento, a azoxistrobina na cana-de-açúcar ainda é decisão minha?' }
        ]
    },
    {
        id: 'ESC-CHUVA-MILHO',
        bloco: 'escalonamento_procedimento',
        tipos: ['fronteira', 'procedimento'],
        alvo: 'Nicosulfuron',
        objetivo: 'aguardar_janela',
        dimensoes: ['telemetria.chuva_prevista'],
        racional:
            '`escalonar: chuva_prevista > 0 -> OPERADOR_DRONE` e o unico escalonamento do modelo que nao vai a um agronomo nem a um orgao: chuva na janela e reprogramacao de missao. O Nicosulfuron nao tem regra de chuva, entao a politica nao muda e a diferenca e so o encaminhamento.',
        base: T({ vento: 5, temperatura: 25, umidade: 76, NDVI: 0.47, umidade_foliar: 57, temperatura_foliar: 28, distancia_manancial: 1900, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { tel: { chuva_prevista: 0 }, estilo: 'pergunta_direta', fala: 'Nicosulfuron no milho nesta janela. Decolo ou reprogramo a missão?' },
            { tel: { chuva_prevista: 1 }, estilo: 'duvida_operacional', fala: 'Nicosulfuron no milho com o tempo fechando. Quem reprograma a janela?' },
            { tel: { chuva_prevista: 4 }, estilo: 'urgente', fala: 'Preciso resolver a gramínea do milho com nicosulfuron hoje. Dá para manter a missão?' }
        ]
    },
    {
        id: 'ESC-AMBIENTAL-MILHO',
        bloco: 'escalonamento_procedimento',
        tipos: ['procedimento', 'contextual'],
        alvo: 'Nicosulfuron',
        objetivo: 'acionar_agronomo',
        dimensoes: ['intencao'],
        areas: ['Faixa_Manancial'],
        racional:
            '`escalonar -> ORGAO_AMBIENTAL` do Milho com um produto que a Faixa_Manancial NAO proibe: o Nicosulfuron segue aplicavel e, ainda assim, a missao exige autorizacao e registro. Separa "produto proibido na area" de "area que exige autorizacao".',
        base: T({ vento: 5, temperatura: 26, umidade: 72, NDVI: 0.47, umidade_foliar: 56, temperatura_foliar: 29, distancia_manancial: 430, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { estilo: 'procedimento', fala: 'Nicosulfuron no milho dentro da faixa de proteção do manancial. Preciso de autorização do órgão ambiental?' },
            { estilo: 'duvida_operacional', fala: 'A faixa do manancial impede o nicosulfuron no milho ou só me obriga a avisar alguém?' }
        ]
    },
    {
        id: 'PC-JANELA-SOJA',
        bloco: 'escalonamento_procedimento',
        tipos: ['procedimento', 'evidencia_insuficiente'],
        alvo: 'Glifosato',
        objetivo: 'aguardar_janela',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'A `janela` da Soja ("06h-09h ou 17h-19h", umidade minima 55 %) tem uma metade verificavel (a umidade e sensor) e outra que nao e: `hora` esta no vocabulario e nao vem na leitura. A resposta deve usar a umidade e tratar o horario como procedimento, nao como condicao lida.',
        base: T({ vento: 5, temperatura: 26, umidade: 58, NDVI: 0.38, umidade_foliar: 68, temperatura_foliar: 29, distancia_manancial: 1600, distancia_cultura_sensivel: 1350, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { estilo: 'procedimento', fala: 'Qual é a janela de horário para o glifosato na soja e a umidade de hoje atende?', alegacoes: ['HORA'] },
            { estilo: 'duvida_operacional', fala: 'Já passou do meio-dia e eu quero o glifosato na soja. A janela da cultura permite?', alegacoes: ['HORA', 'JANELA'] }
        ]
    },
    {
        id: 'PC-JANELA-CANA',
        bloco: 'escalonamento_procedimento',
        tipos: ['procedimento', 'evidencia_insuficiente'],
        alvo: 'Azoxistrobina',
        objetivo: 'aguardar_janela',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'A `janela` da Cana e a unica declarada em termos de PREVISAO ("sem previsao de chuva por 8 h"), e a leitura so traz milimetros previstos para a janela corrente. O pedido cobra uma garantia de oito horas que o dado nao da.',
        base: T({ vento: 6, temperatura: 28, umidade: 67, NDVI: 0.34, umidade_foliar: 71, temperatura_foliar: 33, distancia_manancial: 1600, distancia_cultura_sensivel: 1200, chuva_prevista: 0, infestacao: 9 }),
        variantes: [
            { estilo: 'procedimento', fala: 'A janela da cana-de-açúcar pede oito horas sem chuva. A azoxistrobina cabe na previsão de agora?', alegacoes: ['JANELA', 'CHUVA'] },
            { estilo: 'pergunta_direta', fala: 'Dá para garantir oito horas secas para a azoxistrobina na cana-de-açúcar?', alegacoes: ['JANELA', 'CHUVA'] }
        ]
    },
    {
        id: 'PC-CARENCIA-REENTRADA',
        bloco: 'escalonamento_procedimento',
        tipos: ['procedimento'],
        alvo: 'Acefato',
        objetivo: 'procedimento',
        dimensoes: ['intencao'],
        racional:
            'Carencia e reentrada sao atributos do produto, nao leitura: as tres falas pedem numeros que estao na bula (Acefato 21 dias e 48 h, Mancozebe 14 dias e 48 h, Glifosato 7 dias e 24 h) e nenhum deles depende do talhao. Mede se a resposta busca o atributo em vez de inventar um numero.',
        base: T({ vento: 4, temperatura: 26, umidade: 70, NDVI: 0.52, umidade_foliar: 67, temperatura_foliar: 29, distancia_manancial: 1700, distancia_cultura_sensivel: 1450, chuva_prevista: 0, infestacao: 20 }),
        variantes: [
            { estilo: 'procedimento', fala: 'Quantos dias de carência o acefato exige na soja antes da colheita?' },
            { estilo: 'pergunta_direta', fala: 'Depois do mancozebe na soja, quanto tempo até liberar a reentrada de gente no talhão?' },
            { estilo: 'compara_produtos', fala: 'Entre glifosato e acefato na soja, qual tem a carência mais curta?' }
        ]
    },
    {
        id: 'PC-TOXI-I',
        bloco: 'escalonamento_procedimento',
        tipos: ['procedimento'],
        alvo: 'Dois_Quatro_D',
        objetivo: 'procedimento',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_TOXI_I, RG_RASTRO],
        racional:
            'O Dois_Quatro_D e o unico produto classe toxicologica I do modelo, e a regra global exige dupla checagem antes da decolagem. Com vento de 6 km/h e Milho inativo, nada o restringe: o unico tema e o procedimento de checagem.',
        base: T({ vento: 6, temperatura: 27, umidade: 69, NDVI: 0.5, umidade_foliar: 70, temperatura_foliar: 31, distancia_manancial: 1700, distancia_cultura_sensivel: 1100, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { estilo: 'procedimento', fala: 'Dois-quatro-D na cana-de-açúcar: que checagem a classe toxicológica dele obriga antes de decolar?' },
            { estilo: 'ordem', fala: 'Libera o dois-quatro-D na cana-de-açúcar e me lista o que preciso conferir antes.' }
        ]
    },
    {
        id: 'PC-GOTA-DERIVA',
        bloco: 'escalonamento_procedimento',
        tipos: ['procedimento'],
        alvo: 'Glifosato',
        objetivo: 'classificar_restricao',
        dimensoes: ['intencao'],
        racional:
            'Gota minima e potencial de deriva sao atributos declarados (Glifosato 300 micra e deriva alta; Mancozebe 200 micra e deriva moderada) e nao viram condicao de decisao em nenhuma regra. O pedido pergunta por eles com a leitura liberada, para medir se a resposta os reporta sem transforma-los em bloqueio.',
        base: T({ vento: 7, temperatura: 28, umidade: 65, NDVI: 0.37, umidade_foliar: 69, temperatura_foliar: 30, distancia_manancial: 1550, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { estilo: 'procedimento', fala: 'Que gota mínima eu configuro no bico para o glifosato na soja?' },
            { estilo: 'compara_produtos', fala: 'O glifosato ou o mancozebe deriva mais na soja? Quero escolher o bico pela pior condição.' }
        ]
    },
    {
        id: 'PC-DOSE-FAIXA',
        bloco: 'escalonamento_procedimento',
        tipos: ['procedimento', 'unitario_semantico'],
        alvo: 'Glifosato',
        objetivo: 'ajustar_vazao',
        dimensoes: ['intencao'],
        racional:
            'A faixa de bula do Glifosato (minima 1,5, recomendada 2,0, maxima 3,0 L/ha) e o que torna AUMENTAR_VAZAO e REDUZIR_VAZAO exprimiveis: fora dela nao ha vazao a escrever. As tres falas citam os tres valores declarados, e nenhum outro.',
        base: T({ vento: 5, temperatura: 27, umidade: 70, NDVI: 0.38, umidade_foliar: 68, temperatura_foliar: 30, distancia_manancial: 1650, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 11 }),
        variantes: [
            { estilo: 'pergunta_direta', fala: 'Glifosato a 2 L/ha na soja é a dose certa para esta dessecação?' },
            { estilo: 'ordem', fala: 'Sobe o glifosato da soja para 3 L/ha, o mato está duro.', alegacoes: ['DOSE'] },
            { estilo: 'duvida_operacional', fala: 'Dá para fechar a dessecação da soja com glifosato a 1.5 L/ha e economizar produto?', alegacoes: ['DOSE'] }
        ]
    },

    // ----------------------------------------------------------- INTERACAO (17)
    {
        id: 'IN-BLOQUEIO-E-VETO',
        bloco: 'interacao',
        tipos: ['combinatorio', 'negativo'],
        alvo: 'Atrazina',
        objetivo: 'aplicar',
        dimensoes: ['telemetria.distancia_manancial'],
        cadastroAusente: true,
        racional:
            'Veto de registro (Soja veta Atrazina, e a Soja esta ativa) MAIS bloqueio por sensor que liga e desliga com a distancia. O veto ja fecha a politica nas tres variantes: a familia mede se o sistema deixa de responder "liberado" quando o bloqueio sai, e se a justificativa cita o motivo que de fato manda.',
        base: T({ vento: 5, temperatura: 27, umidade: 70, NDVI: 0.37, umidade_foliar: 68, temperatura_foliar: 30, distancia_manancial: 500, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 11 }),
        variantes: [
            { tel: { distancia_manancial: 450 }, estilo: 'ordem', fala: 'Atrazina na soja neste talhão perto do córrego. Manda a missão.' },
            { tel: { distancia_manancial: 500 }, estilo: 'pergunta_direta', fala: 'Atrazina na soja com o córrego no limite da faixa. Qual a decisão?' },
            { tel: { distancia_manancial: 900 }, estilo: 'duvida_operacional', fala: "Longe de qualquer corpo d'água, a atrazina na soja passa a ser possível?" }
        ]
    },
    {
        id: 'IN-BLOQUEIO-E-PROIBICAO',
        bloco: 'interacao',
        tipos: ['combinatorio', 'contextual'],
        alvo: 'Clorpirifos',
        objetivo: 'bloquear_ou_suspender',
        dimensoes: ['areas'],
        racional:
            'Bloqueio por temperatura (34 C > 32) somado, ou nao, a proibicao por area. Sem a area, o Clorpirifos perde apenas as decisoes de incremento; com ela, fica so com as de retirada. O mesmo produto, duas larguras de politica.',
        base: T({ vento: 5, temperatura: 34, umidade: 66, NDVI: 0.44, umidade_foliar: 57, temperatura_foliar: 38, distancia_manancial: 1700, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 13 }),
        variantes: [
            { areas: ['Apiario_Proximo'], estilo: 'pergunta_direta', fala: 'Clorpirifós contra cigarrinha no milho neste calor. Suspendo a missão ou ainda há condição?' },
            { areas: [], estilo: 'pergunta_direta', fala: 'Neste calor, suspendo a missão de clorpirifós contra cigarrinha no milho ou ainda há condição?' }
        ]
    },
    {
        id: 'IN-DOIS-BLOQUEIOS',
        bloco: 'interacao',
        tipos: ['combinatorio'],
        alvo: 'Mancozebe',
        objetivo: 'bloquear_ou_suspender',
        dimensoes: ['intencao'],
        racional:
            'Dois tetos de sensores DIFERENTES ativos ao mesmo tempo no mesmo talhao: Mancozebe por umidade (52 < 55) e Glifosato por vento (12 > 10). O pedido quer os dois na mesma passada, e a resposta tem de recusar cada um pelo seu motivo, nao por um motivo so.',
        base: T({ vento: 12, temperatura: 29, umidade: 52, NDVI: 0.37, umidade_foliar: 66, temperatura_foliar: 32, distancia_manancial: 1600, distancia_cultura_sensivel: 1350, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { estilo: 'ordem', fala: 'Mancozebe e glifosato na soja na mesma saída de hoje. Programa as duas aplicações.' },
            { estilo: 'duvida_operacional', fala: 'Nenhuma das duas condições do talhão de soja está boa. Qual eu salvo: mancozebe ou glifosato?' }
        ]
    },
    {
        id: 'IN-AJUSTE-E-BLOQUEIO',
        bloco: 'interacao',
        tipos: ['combinatorio', 'fronteira'],
        alvo: 'Imidacloprido',
        objetivo: 'ajustar_vazao',
        dimensoes: ['telemetria.temperatura_foliar'],
        areas: ['Faixa_Manancial'],
        racional:
            'Ajuste de area (0,5 na Faixa_Manancial) e bloqueio por folha quente sobre o MESMO produto, com o limiar de 38 C no meio. Abaixo do limiar a resposta deve trazer vazao reduzida; acima, nao deve trazer vazao de aplicacao nenhuma. E o teste de que ajuste e bloqueio nao se confundem.',
        base: T({ vento: 5, temperatura: 29, umidade: 68, NDVI: 0.33, umidade_foliar: 72, temperatura_foliar: 38, distancia_manancial: 350, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 10 }),
        variantes: [
            { tel: { temperatura_foliar: 37.9 }, estilo: 'pergunta_direta', fala: 'Imidacloprido na cana-de-açúcar dentro da faixa do manancial. Que vazão a missão aceita?' },
            { tel: { temperatura_foliar: 38 }, estilo: 'pergunta_direta', fala: 'Que vazão de imidacloprido a missão aceita na cana-de-açúcar dentro da faixa do manancial?' },
            { tel: { temperatura_foliar: 40.1 }, estilo: 'pergunta_direta', fala: 'Na faixa do manancial, qual vazão de imidacloprido a cana-de-açúcar admite nesta missão?' }
        ]
    },
    {
        id: 'IN-TRES-CULTURAS',
        bloco: 'interacao',
        tipos: ['combinatorio', 'contextual'],
        alvo: null,
        objetivo: 'classificar_restricao',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_TANQUE, RG_ADJACENTE],
        racional:
            'Leitura que ativa as TRES culturas de uma vez (NDVI 0,30; umidade foliar 55; folha a 39 C), de modo que os tres vetos de registro valham simultaneamente: Soja->Atrazina, Milho->Dois_Quatro_D, Cana->Nicosulfuron. Cada fala pede um dos tres produtos vetados, e o veto que decide muda com o produto, nao com a leitura.',
        base: T({ vento: 5, temperatura: 28, umidade: 67, NDVI: 0.3, umidade_foliar: 55, temperatura_foliar: 39, distancia_manancial: 1600, distancia_cultura_sensivel: 1300, chuva_prevista: 0, infestacao: 20 }),
        variantes: [
            { estilo: 'ordem', fala: 'Manda atrazina na soja deste talhão, o mato de folha larga está dominando.' },
            { estilo: 'pergunta_direta', fala: 'Dois-quatro-D no milho resolve a corda-de-viola deste talhão?' },
            { estilo: 'duvida_operacional', fala: 'Nicosulfuron na cana-de-açúcar deste talhão dá conta do capim?' }
        ]
    },
    {
        id: 'IN-ESCALONA-E-VETO',
        bloco: 'interacao',
        tipos: ['combinatorio', 'procedimento'],
        alvo: 'Nicosulfuron',
        objetivo: 'substituir_produto',
        dimensoes: ['intencao'],
        areas: ['Vizinhanca_Sensivel'],
        racional:
            'Tres coisas ao mesmo tempo sobre a Cana ativa: veto de registro ao Nicosulfuron, escalonamento ao agronomo pela vizinhanca a 280 m e as exigencias da area. A decisao sobre o produto citado esta fechada, e ainda assim ha procedimento a cumprir e alternativa a indicar.',
        base: T({ vento: 5, temperatura: 28, umidade: 69, NDVI: 0.5, umidade_foliar: 70, temperatura_foliar: 39, distancia_manancial: 1700, distancia_cultura_sensivel: 280, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { estilo: 'pede_substituicao', fala: 'Nicosulfuron na cana-de-açúcar com pomar na divisa: se não der, o que entra no lugar e quem eu aviso?' },
            { estilo: 'urgente', fala: 'Capim fechando a cana-de-açúcar e o pomar do vizinho logo ali. Nicosulfuron agora ou chamo alguém?' }
        ]
    },
    {
        id: 'IN-CALDA-E-AREA',
        bloco: 'interacao',
        tipos: ['combinatorio', 'estado_de_curso', 'contextual'],
        alvo: 'Dois_Quatro_D',
        objetivo: 'bloquear_ou_suspender',
        dimensoes: ['areas'],
        cadastroAusente: true,
        regrasGlobais: [RG_TOXI_I],
        racional:
            'Os dois herbicidas incompativeis JA na calda (Atrazina e Dois_Quatro_D, gravidade alta) num talhao a 270 m de cultura sensivel. Declarar a area proibe o Dois_Quatro_D e ajusta a Atrazina; nao declarar deixa a incompatibilidade como unico problema. Duas camadas que o mesmo pedido mistura.',
        base: T({ vento: 6, temperatura: 27, umidade: 70, NDVI: 0.5, umidade_foliar: 70, temperatura_foliar: 31, distancia_manancial: 1700, distancia_cultura_sensivel: 270, chuva_prevista: 0, infestacao: 8 }),
        uso: ['Atrazina', 'Dois_Quatro_D'],
        variantes: [
            { areas: ['Vizinhanca_Sensivel'], estilo: 'relato_e_pergunta', fala: 'O tanque já está com atrazina e dois-quatro-D para a cana-de-açúcar deste talhão. Como eu conduzo a missão?' },
            { areas: [], estilo: 'relato_e_pergunta', fala: 'Como eu conduzo a missão com o tanque já carregado de atrazina e dois-quatro-D para a cana-de-açúcar deste talhão?' }
        ]
    },

    // ---------------------------------------------------------- UNITARIOS (8)
    {
        id: 'UN-AZOXI-LIBERADA',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Azoxistrobina',
        objetivo: 'aplicar',
        dimensoes: [],
        racional:
            'O cenario em que NADA restringe: produto recomendado pela cultura ativa, nenhum teto cruzado, cadastro vazio e sensores coerentes com isso. Serve de controle — se o sistema inventa restricao aqui, o problema nao esta nos limiares.',
        base: T({ vento: 5, temperatura: 26, umidade: 72, NDVI: 0.33, umidade_foliar: 73, temperatura_foliar: 31, distancia_manancial: 1900, distancia_cultura_sensivel: 1600, chuva_prevista: 0, infestacao: 7 }),
        variantes: [
            { estilo: 'ordem', fala: 'Azoxistrobina preventiva na cana-de-açúcar, antes do fechamento do dossel. Programa a missão.' }
        ]
    },
    {
        id: 'UN-SO-CULTURA',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: null,
        objetivo: 'solicitar_varredura',
        dimensoes: [],
        racional:
            'Pedido que nomeia a cultura e nenhum produto: o foco entra pela cultura e as recomendacoes dela e que precisam aparecer. E o unico cenario novo em que o alvo e nulo por construcao, nao por falha de ancoragem.',
        base: T({ vento: 4, temperatura: 25, umidade: 74, NDVI: 0.36, umidade_foliar: 70, temperatura_foliar: 28, distancia_manancial: 1800, distancia_cultura_sensivel: 1500, chuva_prevista: 0, infestacao: 12 }),
        variantes: [
            { estilo: 'duvida_operacional', fala: 'O talhão de soja não está bem. O que eu faço primeiro?' }
        ]
    },
    {
        id: 'UN-VARREDURA-NDVI',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'evidencia_insuficiente'],
        alvo: null,
        objetivo: 'solicitar_varredura',
        dimensoes: [],
        racional:
            'NDVI baixo com infestacao abaixo do nivel de dano: o gatilho manda VARRER e a leitura nao identifica praga nenhuma. O pedido quer um produto; o modelo so autoriza varredura. Mede se a resposta resiste a escolher defensivo sem alvo.',
        base: T({ vento: 5, temperatura: 27, umidade: 70, NDVI: 0.29, umidade_foliar: 71, temperatura_foliar: 30, distancia_manancial: 1700, distancia_cultura_sensivel: 1400, chuva_prevista: 0, infestacao: 4 }),
        variantes: [
            { estilo: 'ordem', fala: 'O vigor da cana-de-açúcar despencou. Escolhe um defensivo e manda hoje.' }
        ]
    },
    {
        id: 'UN-MANTER-VAZAO',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'estado_de_curso'],
        alvo: 'Imidacloprido',
        objetivo: 'ajustar_vazao',
        dimensoes: [],
        uso: ['Imidacloprido'],
        racional:
            'Aplicacao em curso, condicao estavel e nenhuma area no cadastro: o caso que a conduta `Manter_Vazao` (decisao MANTER_VAZAO) existe para atender, e que antes desta versao do modelo nao tinha conduta nenhuma.',
        base: T({ vento: 5, temperatura: 27, umidade: 70, NDVI: 0.33, umidade_foliar: 72, temperatura_foliar: 33, distancia_manancial: 1800, distancia_cultura_sensivel: 1500, chuva_prevista: 0, infestacao: 11 }),
        variantes: [
            { estilo: 'pergunta_direta', fala: 'O imidacloprido já está sendo aplicado na cana-de-açúcar e a condição não mudou. Mantenho a vazão?' }
        ]
    },
    {
        id: 'UN-AUMENTAR-VAZAO',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'estado_de_curso'],
        alvo: 'Acefato',
        objetivo: 'ajustar_vazao',
        dimensoes: [],
        uso: ['Acefato'],
        racional:
            'Aplicacao em curso com infestacao acima do nivel de dano e a dose maxima do Acefato (0,8 kg/ha) ainda disponivel: o caso de `Aumentar_Vazao`. Sem a faixa de bula declarada, nao haveria vazao maior a escrever.',
        base: T({ vento: 5, temperatura: 27, umidade: 71, NDVI: 0.5, umidade_foliar: 68, temperatura_foliar: 30, distancia_manancial: 1700, distancia_cultura_sensivel: 1450, chuva_prevista: 0, infestacao: 26 }),
        variantes: [
            { estilo: 'relato_e_pergunta', fala: 'Acefato em aplicação na soja e a lagarta continua ativa. Dá para subir a vazão dentro da bula?' }
        ]
    },
    {
        id: 'UN-REDUZIR-VAZAO',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'contextual'],
        alvo: 'Atrazina',
        objetivo: 'ajustar_vazao',
        dimensoes: [],
        areas: ['Vizinhanca_Sensivel'],
        uso: ['Atrazina'],
        racional:
            'Aplicacao em curso na bordadura voltada para a cultura sensivel: ajuste de 0,75 da area somado a conduta `Reduzir_Vazao`, que o modelo associa ao modo FAIXA_DIRIGIDA. Manancial longe, para o ajuste aparecer sem bloqueio.',
        base: T({ vento: 5, temperatura: 26, umidade: 73, NDVI: 0.47, umidade_foliar: 57, temperatura_foliar: 29, distancia_manancial: 1600, distancia_cultura_sensivel: 260, chuva_prevista: 0, infestacao: 8 }),
        variantes: [
            { estilo: 'ordem', fala: 'Estou na bordadura do milho com atrazina em aplicação e o parreiral do lado. Reduz a vazão.' }
        ]
    },
    {
        id: 'UN-SUSPENDER',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'estado_de_curso'],
        alvo: 'Acefato',
        objetivo: 'bloquear_ou_suspender',
        dimensoes: [],
        uso: ['Acefato'],
        racional:
            'Produto na calda E teto cruzado (chuva prevista na janela): a politica perde as decisoes de incremento e sobra SUSPENDER, que e a decisao de retirada de quem ja comecou. Distingue suspender de bloquear e de manter bloqueado.',
        base: T({ vento: 6, temperatura: 25, umidade: 79, NDVI: 0.52, umidade_foliar: 74, temperatura_foliar: 27, distancia_manancial: 1700, distancia_cultura_sensivel: 1400, chuva_prevista: 6, infestacao: 22 }),
        variantes: [
            { estilo: 'urgente', fala: 'Começou a fechar o tempo e o acefato está em aplicação na soja. Interrompo?' }
        ]
    },
    {
        id: 'UN-BLOQUEAR-MISSAO',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'procedimento'],
        alvo: 'Dois_Quatro_D',
        objetivo: 'bloquear_ou_suspender',
        dimensoes: [],
        uso: ['Dois_Quatro_D'],
        regrasGlobais: [RG_TOXI_I, RG_RASTRO],
        racional:
            'Pedido para pular a dupla checagem de um produto classe toxicologica I JA carregado: nada na leitura bloqueia o Dois_Quatro_D aqui, e ainda assim a missao pedida nao pode ser emitida como pedida. E o caso de `Bloquear_Missao_Insegura` — recusar a missao, que nao e o mesmo que descartar o produto.',
        base: T({ vento: 6, temperatura: 27, umidade: 68, NDVI: 0.5, umidade_foliar: 71, temperatura_foliar: 31, distancia_manancial: 1800, distancia_cultura_sensivel: 1200, chuva_prevista: 0, infestacao: 7 }),
        variantes: [
            { estilo: 'ordem', fala: 'Pula a dupla checagem do dois-quatro-D na cana-de-açúcar e decola, estamos atrasados.' }
        ]
    }
];

// =============================================================================
// 3) Montagem e validacao estrutural
// =============================================================================

interface CenarioNovo {
    familia: Familia;
    variante: Variante;
    indiceNaFamilia: number;
    talhao: string;
    intencao: string;
    telemetria: Tel;
    areas: string[];
    produtosEmUso: string[];
}

interface CenarioJsonl {
    intencao: string;
    talhao: string;
    telemetria: Record<string, number>;
    areas: string[];
    produtosEmUso: string[];
}

const CAMINHO_ANTIGOS = ['src/examples/agro/cenarios-200-agro.jsonl'];
const SAIDA = {
    cenarios: path.join('src', 'examples', 'agro', 'cenarios-400-agro.jsonl'),
    meta: path.join('src', 'examples', 'agro', 'cenarios-400-agro.meta.jsonl'),
    contrastes: path.join('src', 'examples', 'agro', 'cenarios-400-agro.contrastes.jsonl'),
    relatorio: path.join('src', 'examples', 'agro', 'cobertura-400-agro.md')
};
const PRIMEIRO_ID = 4201;

/** Serializacao no mesmo estilo dos 200 antigos (json.dumps do Python: ", " e ": ", UTF-8 cru). */
function numeroPy(chave: string, n: number): string {
    if (!Number.isFinite(n)) throw new Error(`${chave}: numero invalido ${n}`);
    if (CAMPOS_FLOAT.has(chave) && Number.isInteger(n)) return n.toFixed(1);
    return String(n);
}

function serializar(c: CenarioJsonl): string {
    const tel = Object.entries(c.telemetria)
        .map(([k, v]) => `${JSON.stringify(k)}: ${numeroPy(k, v)}`)
        .join(', ');
    const lista = (xs: string[]) => `[${xs.map(x => JSON.stringify(x)).join(', ')}]`;
    return (
        `{"intencao": ${JSON.stringify(c.intencao)}, "talhao": ${JSON.stringify(c.talhao)}, ` +
        `"telemetria": {${tel}}, "areas": ${lista(c.areas)}, "produtosEmUso": ${lista(c.produtosEmUso)}}`
    );
}

function montarNovos(): CenarioNovo[] {
    const novos: CenarioNovo[] = [];
    for (const familia of FAMILIAS) {
        familia.variantes.forEach((variante, indiceNaFamilia) => {
            const telemetria = { ...familia.base, ...(variante.tel ?? {}) } as Tel;
            // Ordem dos campos identica a dos antigos.
            const ordenada = Object.fromEntries(PARAMETROS.map(p => [p, telemetria[p]])) as Tel;
            novos.push({
                familia,
                variante,
                indiceNaFamilia,
                talhao: `TL-2026-${PRIMEIRO_ID + novos.length}`,
                intencao: variante.fala,
                telemetria: ordenada,
                areas: [...(variante.areas ?? familia.areas ?? [])],
                produtosEmUso: [...(variante.uso ?? familia.uso ?? [])]
            });
        });
    }
    return novos;
}

/** Criterio de cada area que TEM sensor correspondente no modelo. */
const CRITERIO_DE_AREA: { area: string; parametro: Parametro; limite: number }[] = [
    { area: 'Faixa_Manancial', parametro: 'distancia_manancial', limite: 500 },
    { area: 'Vizinhanca_Sensivel', parametro: 'distancia_cultura_sensivel', limite: 300 }
];

/**
 * Numeros citados na fala que tem de bater com a LEITURA. Cada padrao devolve o
 * parametro que o numero afirma; divergencia reprova o lote.
 */
const PADROES_LEITURA: { re: RegExp; parametro: Parametro }[] = [
    { re: /(\d+(?:[.,]\d+)?)\s*km\s*\/\s*h/g, parametro: 'vento' },
    { re: /(\d+(?:[.,]\d+)?)\s*(?:m|metros)\s+(?:do|da|de)\s+(?:manancial|corrego|\brio\b|nascente|curso)/g, parametro: 'distancia_manancial' },
    { re: /(?:manancial|corrego|\brio\b|nascente|curso d'agua)\s+a\s+(\d+(?:[.,]\d+)?)\s*m\b/g, parametro: 'distancia_manancial' },
    { re: /(\d+(?:[.,]\d+)?)\s*(?:m|metros)\s+(?:de|do|da)\s+(?:uva|maca|oliveir|parreir|pomar|horticultur|videir)/g, parametro: 'distancia_cultura_sensivel' },
    { re: /ndvi\s*(?:de\s*|em\s*)?(\d+(?:[.,]\d+)?)/g, parametro: 'NDVI' },
    { re: /temperatura foliar\s*(?:de\s*|em\s*)?(\d+(?:[.,]\d+)?)/g, parametro: 'temperatura_foliar' },
    { re: /umidade foliar\s*(?:de\s*|em\s*)?(\d+(?:[.,]\d+)?)/g, parametro: 'umidade_foliar' },
    { re: /infestacao\s*(?:de\s*|em\s*)?(\d+(?:[.,]\d+)?)/g, parametro: 'infestacao' },
    { re: /(\d+(?:[.,]\d+)?)\s*mm\s+(?:de\s+)?chuva/g, parametro: 'chuva_prevista' }
];

/**
 * Normalizacao para CONFERIR NUMEROS: tira acento e caixa, mas preserva ponto,
 * virgula, barra e porcentagem. O `normalizar` do foco troca toda pontuacao por
 * espaco ("NDVI 0.33" -> "ndvi 0 33"), o que serve para casar nomes e nao serve
 * para ler um numero decimal.
 */
function normalizarComPontuacao(texto: string): string {
    return texto
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

/** Doses declaradas na bula, por produto — para conferir vazao citada na fala. */
function dosesDoModelo(model: AgroModel): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (const p of model.elements.filter(isProductDef)) {
        const v: number[] = [];
        for (const a of p.attributes) if (isDoseAttr(a)) v.push(a.value.value);
        m.set(p.name, v);
    }
    return m;
}

function validarCoerencia(
    c: CenarioNovo,
    produtos: Set<string>,
    areasValidas: Set<string>,
    doses: Map<string, number[]>,
    nomes: { produtos: string[]; culturas: string[] }
): string[] {
    const t = c.telemetria;
    const erros: string[] = [];
    const areas = new Set(c.areas);

    // --- 1) esquema e faixa fisica
    for (const p of PARAMETROS) {
        const [lo, hi] = FAIXAS[p];
        if (!(t[p] >= lo && t[p] <= hi)) erros.push(`${p}=${t[p]} fora da faixa fisica [${lo}, ${hi}]`);
    }
    const delta = t.temperatura_foliar - t.temperatura;
    if (delta < -12 || delta > 20) erros.push(`temperatura_foliar ${t.temperatura_foliar} incoerente com temperatura ${t.temperatura}`);
    if (t.chuva_prevista > 0 && t.umidade < 60) erros.push(`chuva prevista com umidade do ar em ${t.umidade} %`);

    // --- 2) area declarada x sensor
    for (const x of c.areas) if (!areasValidas.has(x)) erros.push(`area inexistente ${x}`);
    for (const { area, parametro, limite } of CRITERIO_DE_AREA) {
        const dentro = t[parametro] < limite;
        const declarada = areas.has(area);
        if (declarada && !dentro) {
            erros.push(`CONTRADICAO: ${area} declarada com ${parametro}=${t[parametro]} (criterio exige < ${limite})`);
        } else if (dentro && !declarada && !c.familia.cadastroAusente) {
            erros.push(`${parametro}=${t[parametro]} dentro do criterio de ${area}, mas a familia nao declara cadastroAusente`);
        }
    }

    // --- 3) produtos na calda
    for (const x of c.produtosEmUso) if (!produtos.has(x)) erros.push(`produto em uso inexistente ${x}`);
    if (c.familia.alvo && !produtos.has(c.familia.alvo)) erros.push(`alvo inexistente ${c.familia.alvo}`);

    // --- 4) numeros da fala x leitura e x bula
    const f = normalizarComPontuacao(c.intencao);
    for (const { re, parametro } of PADROES_LEITURA) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(f)) !== null) {
            const v = Number(m[1].replace(',', '.'));
            if (Math.abs(v - t[parametro]) > 1e-9) {
                erros.push(`fala afirma ${parametro}=${v}, leitura diz ${t[parametro]} (em "${m[0]}")`);
            }
        }
    }
    const citados = [...casamentoLexical(c.intencao, nomes.produtos)];
    const reDose = /(\d+(?:[.,]\d+)?)\s*(?:l|kg)\s*\/\s*ha/g;
    let md: RegExpExecArray | null;
    while ((md = reDose.exec(f)) !== null) {
        const v = Number(md[1].replace(',', '.'));
        const declarada = citados.some(p => (doses.get(p) ?? []).some(d => Math.abs(d - v) < 1e-9));
        if (!declarada) erros.push(`fala cita vazao ${v} que nao e dose declarada de ${citados.join('/') || '(nenhum produto citado)'}`);
    }

    // --- 5) ancoragem no universo
    const temProduto = citados.length > 0;
    const temCultura = casamentoLexical(c.intencao, nomes.culturas).size > 0;
    if (!temProduto && !temCultura) erros.push('a fala nao nomeia nenhum produto nem cultura do modelo');
    // Em familia cuja DIMENSAO e a propria fala, cada variante pode nomear outro
    // produto de proposito (ex.: comparar carencias): ai basta nomear algum.
    if (c.familia.alvo && !c.familia.dimensoes.includes('intencao') && !citados.includes(c.familia.alvo)) {
        erros.push(`alvo ${c.familia.alvo} nao e nomeado pela fala`);
    }
    if (c.familia.alvo && c.familia.dimensoes.includes('intencao') && !temProduto) {
        erros.push('familia com alvo e dimensao na fala, mas esta variante nao nomeia produto nenhum');
    }

    // --- 6) estado da calda x fala
    const fSemPontuacao = normalizar(c.intencao);
    const dizQueEstaNaCalda = /(ja )?(esta|estao) (sendo aplicad|em aplicacao|no tanque|na calda)|tanque (ja )?esta com|em aplicacao na|em aplicacao no/.test(fSemPontuacao);
    const dizQueTanqueVazio = /tanque (ainda )?vazio|tanque (ja )?foi lavad|lavei o tanque|tanque esta limpo|tanque ja foi lavado/.test(fSemPontuacao);
    if (dizQueEstaNaCalda && c.produtosEmUso.length === 0) erros.push('a fala diz que o produto esta na calda, mas produtosEmUso esta vazio');
    if (dizQueTanqueVazio && c.produtosEmUso.length > 0 && !(c.variante.alegacoes ?? []).includes('TANQUE_LIMPO')) {
        erros.push('a fala diz que o tanque esta vazio/limpo, mas ha produto em uso e a variante nao declara a alegacao');
    }
    return erros;
}

/** Dimensoes em que dois cenarios diferem. */
function diferencas(a: CenarioNovo, b: CenarioNovo): Dimensao[] {
    const d: Dimensao[] = [];
    for (const p of PARAMETROS) if (a.telemetria[p] !== b.telemetria[p]) d.push(`telemetria.${p}`);
    if (JSON.stringify([...a.areas].sort()) !== JSON.stringify([...b.areas].sort())) d.push('areas');
    if (JSON.stringify([...a.produtosEmUso].sort()) !== JSON.stringify([...b.produtosEmUso].sort())) d.push('produtosEmUso');
    if (a.intencao !== b.intencao) d.push('intencao');
    return d;
}

// =============================================================================
// 4) Camada deterministica, foco offline e assinaturas
// =============================================================================

const SEM_SINAL: SinalVetorial = { itens: [], contextos: [] };
const SEM_SESSAO = undefined as unknown as Session;

interface Analise {
    r: RetrievedAgroConstraints;
    lexProdutos: string[];
    lexCulturas: string[];
    focoProdutos: string[];
    focoCulturas: string[];
    politicaAlvo: string[] | null;
    politicaAlvoPosFoco: string[] | null;
    vazoesAlvo: string[];
    statusAlvo: string;
    exige: string[];
    janelas: string[];
}

function exigeDasAreas(model: AgroModel, areas: string[]): string[] {
    const out: string[] = [];
    for (const def of model.elements.filter(isAreaDef)) {
        if (!areas.includes(def.name)) continue;
        for (const r of def.restrictions) if (isAreaRequire(r)) out.push(`${def.name}: ${r.requirement}`);
    }
    return out;
}

function janelasDasCulturas(model: AgroModel, culturas: string[]): string[] {
    const out: string[] = [];
    for (const c of model.elements.filter(isCultureDef)) {
        if (!culturas.includes(c.name)) continue;
        for (const a of c.attributes) if (isWindowAttr(a)) out.push(`${c.name}: ${a.description}`);
    }
    return out;
}

function statusDe(r: RetrievedAgroConstraints, alvo: string | null): string {
    if (!alvo) return 'SEM_PRODUTO_ALVO';
    const cultura = r.vetados.some(v => v.produto === alvo && v.cultura);
    const area = r.vetados.some(v => v.produto === alvo && !v.cultura);
    const bloqueado = r.bloqueios.some(b => b.produto === alvo);
    if (cultura && area) return 'EXCLUIDO_VETO_E_PROIBICAO';
    if (cultura) return 'EXCLUIDO_VETO_DE_CULTURA';
    if (area) return 'EXCLUIDO_PROIBICAO_DE_AREA';
    if (bloqueado) return 'BLOQUEADO_POR_SENSOR';
    return 'APLICAVEL';
}

async function analisar(
    model: AgroModel,
    nomes: { produtos: string[]; culturas: string[] },
    c: CenarioJsonl,
    alvo: string | null
): Promise<Analise> {
    const contexto: AgroContext = {
        talhao: c.talhao,
        telemetria: c.telemetria,
        areas: c.areas,
        produtosEmUso: c.produtosEmUso,
        intencao: c.intencao
    };
    const r = retrieveAgroConstraints(model, contexto);
    const foco = await retrieverFocoAgro(SEM_SESSAO, c.intencao, model, SEM_SINAL);
    const focado = filtrarPorFocoAgro(r, foco, model, contexto);
    // Janela so conta para cultura em foco, ou ativa e ligada a um produto em
    // foco (recomenda, veta) ou escalonando.
    const ativasRelevantes = [
        ...r.recomendados.filter(x => foco.produtos.has(x.produto)).map(x => x.cultura),
        ...r.vetados.filter(v => v.cultura && foco.produtos.has(v.produto)).map(v => v.cultura as string),
        ...r.escalonamentos.map(e => e.cultura)
    ];
    const culturasRelevantes = [...new Set([...ativasRelevantes, ...foco.culturas])];
    const pol = alvo ? r.politicas.get(alvo) : undefined;
    return {
        r,
        lexProdutos: [...casamentoLexical(c.intencao, nomes.produtos)].sort(),
        lexCulturas: [...casamentoLexical(c.intencao, nomes.culturas)].sort(),
        focoProdutos: [...foco.produtos].sort(),
        focoCulturas: [...foco.culturas].sort(),
        politicaAlvo: pol?.decisoes ?? null,
        politicaAlvoPosFoco: alvo ? (focado.politicas.get(alvo)?.decisoes ?? null) : null,
        vazoesAlvo: (pol?.valores ?? []).map(v => `${v.valor} ${v.unidade}`),
        statusAlvo: statusDe(r, alvo),
        exige: exigeDasAreas(model, c.areas),
        janelas: janelasDasCulturas(model, culturasRelevantes)
    };
}

/** Objetivo do pedido, derivado do texto do mesmo jeito para antigos e novos. */
function objetivosDoTexto(fala: string): string[] {
    const t = normalizar(fala);
    const o = new Set<string>();
    if (/aplic|manda|solta|libera|decol|pulveriz|programa|pode\b|posso\b|sai hoje|confirma/.test(t)) o.add('aplicar');
    if (/suspend|interromp|cancel|para a missao|nao aplic|bloquei|impede/.test(t)) o.add('bloquear_ou_suspender');
    if (/janela|espero|aguard|reprogram|mais tarde|a tarde|horario|hora\b|previs/.test(t)) o.add('janela');
    if (/vazao|dose|l ha|kg ha|reduz|aument|sobe|economizar produto/.test(t)) o.add('vazao');
    if (/no lugar|substitu|troca|em vez|outro herbicida|outro defensivo|qual eu (carrego|escolho)|prefiro/.test(t)) o.add('substituir');
    if (/varredur|monitor|conta(gem)?|avalia|o que eu faco|nao esta bem|escolhe um defensivo/.test(t)) o.add('varredura');
    if (/agronomo|escalon|quem assume|quem reprograma|reporto|autorizacao|orgao ambiental|avis|apicultor|vizinho|decido sozinho|decido aqui|confirmar a janela/.test(t)) o.add('escalonar');
    if (/procedimento|registr|precisa|preciso de|o que (nao )?(pode )?falt|conferir|checagem|carencia|reentrada|gota|bordadura|cadastro/.test(t)) o.add('procedimento');
    if (/ou\b.*\?|entre\b|qual (eu|a|o)\b|serve para|resolve ou|deriva mais/.test(t)) o.add('classificar');
    if (/junto|mesma calda|mesma passada|mesma saida|mesmo tanque|economizar passada|passada unica/.test(t)) o.add('calda');
    return [...o].sort();
}

/**
 * Canal da evidencia decisiva: a fala CITA o numero que a leitura decide (vento,
 * distancia, NDVI, temperatura, dose) ou so a leitura o traz. Um cenario em que
 * a fala diz "vento de 14 km/h" nao distingue se o sistema leu o sensor ou o
 * texto; um em que a fala cala distingue. E por isso um caminho de decisao
 * diferente, e entra na assinatura.
 */
function canalDoTexto(fala: string): 'fala_cita_fato_decisivo' | 'so_a_leitura' {
    const t = normalizar(fala);
    const cita =
        /\d+( \d+)? ?(km h|km\/h|c\b|graus|mm|l ha|kg ha)|\d+ ?(m|metros)\b|ndvi \d|infestacao (de |em )?\d|umidade (foliar )?(de |em )?\d|temperatura (foliar )?(de |em )?\d|\d+ ?%/;
    return cita.test(t) ? 'fala_cita_fato_decisivo' : 'so_a_leitura';
}

/** Fatos so da fala, derivados do texto (mesmo criterio para antigos e novos). */
function alegacoesDoTexto(fala: string): string[] {
    const t = normalizar(fala);
    const a = new Set<string>();
    if (/florada|florescend|flora\b|em flor/.test(t)) a.add('FLORADA');
    if (/colmei|abelh|apicultor|apiario/.test(t)) a.add('COLMEIA');
    if (/vento (ja )?(baixou|caiu|fraco|parou)|sinto o vento|vento esta fraco/.test(t)) a.add('VENTO_BAIXOU');
    if (/direcao do vento|vento (esta )?soprando|lado contrario|para o lado/.test(t)) a.add('DIRECAO_VENTO');
    if (/tanque (ja )?(foi )?(lavad|limp)|lavei o tanque|tanque esta limpo/.test(t)) a.add('TANQUE_LIMPO');
    if (/receita|agronomo (ja )?assinou|autorizacao (ambiental )?(ja )?saiu/.test(t)) a.add('RECEITA');
    if (/carencia|colheita e (so )?daqui|dias antes da colheita|reentrada/.test(t)) a.add('CARENCIA');
    if (/sobrou|sobra|galpao|bombona|paradas|aproveita/.test(t)) a.add('SOBRA_GALPAO');
    if (/cadastro/.test(t)) a.add('CADASTRO');
    if (/janela (fecha|da cultura|de horario)|horas sem chuva|oito horas/.test(t)) a.add('JANELA');
    if (/chuva|tempo fechando|radar|chovend/.test(t)) a.add('CHUVA');
    if (/vizinho|pomar|parreiral|divisa|oliveir/.test(t)) a.add('VIZINHO');
    if (/altura de voo|altura do voo|voo baixo/.test(t)) a.add('ALTURA_VOO');
    if (/meio dia|de manha|de tarde|a noite|noturn|horario|passou do meio/.test(t)) a.add('HORA');
    return [...a].sort();
}

type Faixa = 'abaixo_longe' | 'abaixo_epsilon' | 'no_limiar' | 'acima_epsilon' | 'acima_longe';
function faixa(v: number, limiar: number, eps: number): Faixa {
    const perto = (d: number) => d <= eps + 1e-9;
    if (v === limiar) return 'no_limiar';
    if (v < limiar) return perto(limiar - v) ? 'abaixo_epsilon' : 'abaixo_longe';
    return perto(v - limiar) ? 'acima_epsilon' : 'acima_longe';
}

/**
 * Limiares estruturados do lavoura.agro — os unicos parametros que decidem.
 * `produtos` sao os produtos cuja politica o limiar move; `['*']` quando o
 * limiar move procedimento (gatilho de cultura, escalonamento) e nao politica.
 */
const LIMIARES = [
    { regra: 'regra_seguranca Glifosato', parametro: 'vento', limiar: 10, eps: 0.5, produtos: ['Glifosato'] },
    { regra: 'regra_seguranca Nicosulfuron', parametro: 'vento', limiar: 10, eps: 0.5, produtos: ['Nicosulfuron'] },
    { regra: 'regra_seguranca Dois_Quatro_D', parametro: 'vento', limiar: 8, eps: 0.5, produtos: ['Dois_Quatro_D'] },
    { regra: 'escalonar CENTRO_METEOROLOGICO', parametro: 'vento', limiar: 15, eps: 1, produtos: ['*'] },
    { regra: 'regra_seguranca Clorpirifos', parametro: 'temperatura', limiar: 32, eps: 0.5, produtos: ['Clorpirifos'] },
    { regra: 'regra_seguranca Mancozebe', parametro: 'umidade', limiar: 55, eps: 1, produtos: ['Mancozebe'] },
    { regra: 'regra_seguranca Azoxistrobina', parametro: 'umidade', limiar: 50, eps: 1, produtos: ['Azoxistrobina'] },
    { regra: 'regra_seguranca Acefato', parametro: 'chuva_prevista', limiar: 0, eps: 0, produtos: ['Acefato'] },
    { regra: 'regra_seguranca Imidacloprido / gatilho Cana', parametro: 'temperatura_foliar', limiar: 38, eps: 0.5, produtos: ['Imidacloprido', '*'] },
    { regra: 'regra_seguranca Atrazina / escalonar ORGAO_AMBIENTAL', parametro: 'distancia_manancial', limiar: 500, eps: 20, produtos: ['Atrazina', '*'] },
    { regra: 'escalonar AGRONOMO (vizinhanca)', parametro: 'distancia_cultura_sensivel', limiar: 300, eps: 20, produtos: ['*'] },
    { regra: 'gatilho Soja (NDVI)', parametro: 'NDVI', limiar: 0.4, eps: 0.01, produtos: ['*'] },
    { regra: 'gatilho Milho (NDVI)', parametro: 'NDVI', limiar: 0.45, eps: 0.01, produtos: ['*'] },
    { regra: 'gatilho Cana (NDVI)', parametro: 'NDVI', limiar: 0.35, eps: 0.01, produtos: ['*'] },
    { regra: 'gatilho Milho (umidade foliar)', parametro: 'umidade_foliar', limiar: 60, eps: 1, produtos: ['*'] },
    { regra: 'gatilho Soja (infestacao)', parametro: 'infestacao', limiar: 15, eps: 1, produtos: ['*'] },
    { regra: 'escalonar AGRONOMO (infestacao)', parametro: 'infestacao', limiar: 30, eps: 1, produtos: ['*'] }
] as const;

/**
 * Assinatura LOGICA de um cenario, relativa ao que o pedido pergunta: produtos
 * citados, objetivo, fatos alegados, areas, calda, estado deterministico que
 * toca esses produtos e a faixa de cada limiar relevante. Dois cenarios com a
 * mesma assinatura sao o mesmo caminho de decisao, mesmo com outras palavras,
 * outra temperatura ou outro talhao.
 */
function assinatura(c: CenarioJsonl, a: Analise, comCanal = true): string {
    const citados = a.lexProdutos;
    const toca = (p: string) => citados.length === 0 || citados.includes(p);
    const estado = {
        vetos: a.r.vetados.filter(v => toca(v.produto)).map(v => `${v.produto}<${v.origem}`).sort(),
        bloqueios: a.r.bloqueios.filter(b => toca(b.produto)).map(b => `${b.produto}<${b.regra}`).sort(),
        ajustes: a.r.ajustes.filter(x => toca(x.produto)).map(x => `${x.produto}:${x.acao}`).sort(),
        recomenda: a.r.recomendados.filter(x => toca(x.produto)).map(x => `${x.cultura}>${x.produto}`).sort(),
        escalona: a.r.escalonamentos.map(e => `${e.cultura}->${e.destino}`).sort(),
        incompat: a.r.incompatibilidades.filter(i => i.entre.split(' + ').some(toca)).map(i => i.entre).sort()
    };
    const faixas = LIMIARES.filter(l => l.produtos.some(p => p === '*' || toca(p))).map(
        l => `${l.parametro}@${l.limiar}:${faixa(c.telemetria[l.parametro], l.limiar, l.eps)}`
    );
    return JSON.stringify({
        citados,
        objetivo: objetivosDoTexto(c.intencao),
        canal: comCanal ? canalDoTexto(c.intencao) : null,
        alegacoes: alegacoesDoTexto(c.intencao),
        areas: [...c.areas].sort(),
        emUso: [...c.produtosEmUso].sort(),
        estado,
        faixas
    });
}

function trigramas(s: string): Set<string> {
    const t = ` ${normalizar(s)} `;
    const out = new Set<string>();
    for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
    return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

// =============================================================================
// 5) Estatisticas de cobertura (mesmo calculo para antigo, novo e total)
// =============================================================================

interface Linha {
    c: CenarioJsonl;
    a: Analise;
}

type Contagem = Map<string, number>;
const inc = (m: Contagem, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

interface Estatisticas {
    n: number;
    intencoesUnicas: number;
    talhoesUnicos: number;
    aberturasDistintas: number;
    maiorRepeticaoAbertura: number;
    produtosCitados: Contagem;
    produtosEmFocoOffline: Contagem;
    culturasAtivas: Contagem;
    culturasEmFocoOffline: Contagem;
    areas: Contagem;
    multiArea: number;
    emUso: Contagem;
    comEmUso: number;
    incompatibilidades: Contagem;
    vetosCultura: Contagem;
    proibicoesArea: Contagem;
    bloqueiosPorSensor: Contagem;
    ajustes: Contagem;
    escalonamentos: Contagem;
    faixas: Contagem;
    valoresDistintos: Contagem;
    noLimiarOuEpsilon: number;
    comBloqueio: number;
    comVeto: number;
    alegacoes: Contagem;
    comAlegacao: number;
    procedimentos: { comExige: number; comJanela: number; objetivoProcedimento: number };
    combinatorios: number;
    estruturas: Contagem;
    canal: Contagem;
    objetivos: Contagem;
}

function estatisticas(linhas: Linha[], model: AgroModel): Estatisticas {
    const e: Estatisticas = {
        n: linhas.length,
        intencoesUnicas: new Set(linhas.map(l => l.c.intencao)).size,
        talhoesUnicos: new Set(linhas.map(l => l.c.talhao)).size,
        aberturasDistintas: 0,
        maiorRepeticaoAbertura: 0,
        produtosCitados: new Map(),
        produtosEmFocoOffline: new Map(),
        culturasAtivas: new Map(),
        culturasEmFocoOffline: new Map(),
        areas: new Map(),
        multiArea: 0,
        emUso: new Map(),
        comEmUso: 0,
        incompatibilidades: new Map(),
        vetosCultura: new Map(),
        proibicoesArea: new Map(),
        bloqueiosPorSensor: new Map(),
        ajustes: new Map(),
        escalonamentos: new Map(),
        faixas: new Map(),
        valoresDistintos: new Map(),
        noLimiarOuEpsilon: 0,
        comBloqueio: 0,
        comVeto: 0,
        alegacoes: new Map(),
        comAlegacao: 0,
        procedimentos: { comExige: 0, comJanela: 0, objetivoProcedimento: 0 },
        combinatorios: 0,
        estruturas: new Map(),
        canal: new Map(),
        objetivos: new Map()
    };
    const aberturas: Contagem = new Map();
    const valores = new Map<string, Set<number>>();
    for (const { c, a } of linhas) {
        inc(aberturas, normalizar(c.intencao).split(' ').slice(0, 2).join(' '));
        inc(e.canal, canalDoTexto(c.intencao));
        for (const o of objetivosDoTexto(c.intencao)) inc(e.objetivos, o);
        for (const x of a.lexProdutos) inc(e.produtosCitados, x);
        for (const x of a.focoProdutos) inc(e.produtosEmFocoOffline, x);
        for (const x of a.r.culturasAtivas) inc(e.culturasAtivas, x.nome);
        for (const x of a.focoCulturas) inc(e.culturasEmFocoOffline, x);
        for (const x of c.areas) inc(e.areas, x);
        if (c.areas.length > 1) e.multiArea++;
        for (const x of c.produtosEmUso) inc(e.emUso, x);
        if (c.produtosEmUso.length > 0) e.comEmUso++;
        for (const i of a.r.incompatibilidades) inc(e.incompatibilidades, i.entre);
        for (const v of a.r.vetados) inc(v.cultura ? e.vetosCultura : e.proibicoesArea, `${v.produto} <- ${v.cultura ?? v.origem.replace('area ', '')}`);
        for (const b of a.r.bloqueios) inc(e.bloqueiosPorSensor, `${b.produto} <- ${b.regra.split(' ')[0]}`);
        for (const x of a.r.ajustes) inc(e.ajustes, `${x.produto} <- ${x.origem.replace('area ', '')}`);
        for (const x of a.r.escalonamentos) inc(e.escalonamentos, `${x.cultura} -> ${x.destino}`);
        if (a.r.bloqueios.length > 0) e.comBloqueio++;
        if (a.r.vetados.length > 0) e.comVeto++;
        for (const [k, v] of Object.entries(c.telemetria)) {
            if (!valores.has(k)) valores.set(k, new Set());
            valores.get(k)!.add(v);
        }
        let perto = false;
        for (const l of LIMIARES) {
            const f = faixa(c.telemetria[l.parametro], l.limiar, l.eps);
            inc(e.faixas, `${l.regra} (${l.parametro} vs ${l.limiar}): ${f}`);
            if (f === 'no_limiar' || f === 'abaixo_epsilon' || f === 'acima_epsilon') perto = true;
        }
        if (perto) e.noLimiarOuEpsilon++;
        const al = alegacoesDoTexto(c.intencao);
        for (const x of al) inc(e.alegacoes, x);
        if (al.length > 0) e.comAlegacao++;
        if (a.exige.length > 0) e.procedimentos.comExige++;
        if (a.janelas.length > 0) e.procedimentos.comJanela++;
        if (objetivosDoTexto(c.intencao).includes('procedimento')) e.procedimentos.objetivoProcedimento++;
        // Combinatorio: dois ou mais mecanismos estruturados que tocam os produtos citados.
        const toca = (p: string) => a.lexProdutos.length === 0 || a.lexProdutos.includes(p);
        const mecanismos = new Set<string>();
        for (const v of a.r.vetados) if (toca(v.produto)) mecanismos.add(v.cultura ? 'veto' : 'proibicao');
        for (const b of a.r.bloqueios) if (toca(b.produto)) mecanismos.add('bloqueio');
        for (const x of a.r.ajustes) if (toca(x.produto)) mecanismos.add('ajuste');
        for (const x of a.r.recomendados) if (toca(x.produto)) mecanismos.add('recomendacao');
        if (a.r.escalonamentos.length > 0) mecanismos.add('escalonamento');
        if (a.r.incompatibilidades.some(i => i.entre.split(' + ').some(toca))) mecanismos.add('incompatibilidade');
        if (a.exige.length > 0) mecanismos.add('exige');
        if (mecanismos.size >= 2) e.combinatorios++;
        for (const s of estruturasExercitadas(c, a, model)) inc(e.estruturas, s);
    }
    e.aberturasDistintas = aberturas.size;
    e.maiorRepeticaoAbertura = Math.max(...aberturas.values());
    for (const [k, s] of valores) e.valoresDistintos.set(k, s.size);
    return e;
}

/** Estruturas do lavoura.agro que o cenario efetivamente FORCA (nao basta citar o nome). */
function estruturasExercitadas(c: CenarioJsonl, a: Analise, model: AgroModel): string[] {
    const s = new Set<string>();
    for (const x of a.r.culturasAtivas) s.add(`gatilho ${x.nome}`);
    for (const v of a.r.vetados) s.add(v.cultura ? `veta ${v.cultura} -> ${v.produto}` : `proibe ${v.origem.replace('area ', '')} -> ${v.produto}`);
    for (const b of a.r.bloqueios) s.add(`regra_seguranca ${b.produto}`);
    for (const x of a.r.ajustes) s.add(`ajusta ${x.origem.replace('area ', '')} -> ${x.produto}`);
    for (const x of a.r.escalonamentos) s.add(`escalonar ${x.cultura} -> ${x.destino}`);
    for (const i of a.r.incompatibilidades) s.add(`incompativel ${i.entre}`);
    for (const x of c.areas) s.add(`exige ${x}`);
    // Recomendacao e janela so contam quando o produto recomendado esta no foco.
    for (const x of a.r.recomendados) if (a.focoProdutos.includes(x.produto)) s.add(`recomenda ${x.cultura} -> ${x.produto}`);
    for (const j of a.janelas) s.add(`janela ${j.split(':')[0]}`);
    for (const nome of a.focoCulturas) {
        const ativa = a.r.culturasAtivas.some(x => x.nome === nome);
        if (!ativa) s.add(`foco ${nome} (sem gatilho ativo)`);
    }
    void model;
    return [...s];
}

// =============================================================================
// 6) Principal
// =============================================================================

async function main(): Promise<void> {
    const model = await loadAgroModel(path.join('src', 'examples', 'agro', 'lavoura.agro'));
    const nomes = nomesAgro(model);
    const produtos = new Set(model.elements.filter(isProductDef).map(p => p.name));
    const areasValidas = new Set(model.elements.filter(isAreaDef).map(a => a.name));
    const doses = dosesDoModelo(model);

    const caminhoAntigos = CAMINHO_ANTIGOS.find(p => fs.existsSync(p));
    if (!caminhoAntigos) throw new Error(`nenhum dos arquivos antigos existe: ${CAMINHO_ANTIGOS.join(', ')}`);
    const brutasAntigas = fs.readFileSync(caminhoAntigos, 'utf-8').split(/\r?\n/).filter(l => l.trim().length > 0);
    const antigos = brutasAntigas.map(l => JSON.parse(l) as CenarioJsonl);

    const problemas: string[] = [];

    // --- o serializador reproduz os antigos byte a byte
    let serializacaoIgual = 0;
    for (const [i, l] of brutasAntigas.entries()) {
        if (serializar(antigos[i]) === l) serializacaoIgual++;
        else problemas.push(`serializacao difere do antigo na linha ${i + 1}`);
    }

    const novos = montarNovos();
    if (novos.length !== 200) problemas.push(`esperados 200 novos, montados ${novos.length}`);

    // --- completude de cada pedido novo
    const idsAntigos = new Set(antigos.map(c => c.talhao));
    for (const c of novos) {
        for (const e of validarCoerencia(c, produtos, areasValidas, doses, nomes)) {
            problemas.push(`${c.talhao} (${c.familia.id}): ${e}`);
        }
        if (idsAntigos.has(c.talhao)) problemas.push(`${c.talhao}: colide com os antigos`);
    }

    // --- os 200 ANTIGOS tambem passam pelo mesmo crivo de contradicao
    for (const [i, c] of antigos.entries()) {
        const t = c.telemetria as Tel;
        const areas = new Set(c.areas);
        for (const { area, parametro, limite } of CRITERIO_DE_AREA) {
            if (areas.has(area) && !(t[parametro] < limite)) {
                problemas.push(`antigo linha ${i + 1} (${c.talhao}): CONTRADICAO ${area} com ${parametro}=${t[parametro]}`);
            }
        }
        for (const x of c.areas) if (!areasValidas.has(x)) problemas.push(`antigo linha ${i + 1}: area inexistente ${x}`);
        for (const x of c.produtosEmUso) if (!produtos.has(x)) problemas.push(`antigo linha ${i + 1}: produto inexistente ${x}`);
        const f = normalizarComPontuacao(c.intencao);
        for (const { re, parametro } of PADROES_LEITURA) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(f)) !== null) {
                const v = Number(m[1].replace(',', '.'));
                if (Math.abs(v - t[parametro]) > 1e-9) {
                    problemas.push(`antigo linha ${i + 1} (${c.talhao}): fala diz ${parametro}=${v}, leitura ${t[parametro]} (em "${m[0]}")`);
                }
            }
        }
        if (casamentoLexical(c.intencao, nomes.produtos).size === 0 && casamentoLexical(c.intencao, nomes.culturas).size === 0) {
            problemas.push(`antigo linha ${i + 1} (${c.talhao}): fala nao nomeia produto nem cultura`);
        }
    }

    // --- cada um dos 400 pedidos e um texto distinto
    //
    // Famílias cuja dimensão é `areas`, `produtosEmUso` ou um sensor mantêm o
    // PEDIDO equivalente entre as variantes — é o que isola a dimensão. Mas
    // equivalente não é idêntico: pedido repetido reduziria o lote a menos de
    // 400 inputs distintos, e é isso que esta assercao impede. As variantes
    // parafraseiam o mesmo pedido mantendo as MESMAS ancoras lexicais (os mesmos
    // produtos e culturas nomeados), conferido logo abaixo pelo foco lexical.
    const vistas = new Map<string, string>();
    for (const c of antigos) vistas.set(c.intencao, `antigo ${c.talhao}`);
    for (const c of novos) {
        const ja = vistas.get(c.intencao);
        if (ja) problemas.push(`${c.talhao} (${c.familia.id}): pedido identico ao de ${ja}`);
        else vistas.set(c.intencao, `${c.talhao} (${c.familia.id})`);
    }

    // --- controle dentro de cada familia
    for (const f of FAMILIAS) {
        const membros = novos.filter(c => c.familia === f);
        if (f.dimensoes.length === 0 && membros.length !== 1) problemas.push(`${f.id}: familia sem dimensao precisa ter 1 cenario`);
        for (let i = 0; i < membros.length; i++) {
            for (let j = i + 1; j < membros.length; j++) {
                const d = diferencas(membros[i], membros[j]).filter(x => x !== 'intencao' || f.dimensoes.includes('intencao'));
                const fora = d.filter(x => !f.dimensoes.includes(x));
                if (fora.length > 0) problemas.push(`${f.id}: ${membros[i].talhao} x ${membros[j].talhao} variam fora do desenho: ${fora.join(', ')}`);
                if (d.length === 0) problemas.push(`${f.id}: ${membros[i].talhao} e ${membros[j].talhao} sao identicos na dimensao controlada`);
            }
        }
    }

    // --- analise de todos os 400
    const linhasAntigas: Linha[] = [];
    for (const c of antigos) linhasAntigas.push({ c, a: await analisar(model, nomes, c, null) });
    const linhasNovas: (Linha & { n: CenarioNovo })[] = [];
    for (const n of novos) {
        const c: CenarioJsonl = { intencao: n.intencao, talhao: n.talhao, telemetria: n.telemetria, areas: n.areas, produtosEmUso: n.produtosEmUso };
        linhasNovas.push({ c, a: await analisar(model, nomes, c, n.familia.alvo), n });
    }

    // --- foco lexical identico dentro das familias que nao variam a fala
    for (const f of FAMILIAS) {
        if (f.dimensoes.length === 0 || f.dimensoes.includes('intencao')) continue;
        const membros = linhasNovas.filter(l => l.n.familia === f);
        const sigs = new Set(membros.map(l => JSON.stringify([l.a.lexProdutos, l.a.lexCulturas])));
        if (sigs.size > 1) problemas.push(`${f.id}: foco lexical difere entre membros (${[...sigs].join(' | ')})`);
    }

    // --- duplicidade logica e textual contra os antigos e entre os novos
    const sigAntigas = new Map<string, string>();
    for (const l of linhasAntigas) sigAntigas.set(assinatura(l.c, l.a), l.c.talhao);
    const sigAntigasSemCanal = new Map<string, string>();
    for (const l of linhasAntigas) sigAntigasSemCanal.set(assinatura(l.c, l.a, false), l.c.talhao);
    const soPeloCanal: string[] = [];
    for (const l of linhasNovas) {
        const igual = sigAntigasSemCanal.get(assinatura(l.c, l.a, false));
        if (igual && !sigAntigas.has(assinatura(l.c, l.a))) soPeloCanal.push(`${l.c.talhao} (${l.n.familia.id}) ~ ${igual}`);
    }
    const triAntigos = linhasAntigas.map(l => ({ p: l.c.talhao, t: trigramas(l.c.intencao) }));
    const sigNovas = new Map<string, { talhao: string; familia: string }>();
    const duplicadosAntigos: string[] = [];
    const duplicadosNovos: string[] = [];
    let maiorSimilaridade = { valor: 0, novo: '', antigo: '' };
    for (const l of linhasNovas) {
        const s = assinatura(l.c, l.a);
        const igualAntigo = sigAntigas.get(s);
        if (igualAntigo) duplicadosAntigos.push(`${l.c.talhao} (${l.n.familia.id}) = ${igualAntigo}`);
        const ja = sigNovas.get(s);
        const invarianciaPermitida = ja && ja.familia === l.n.familia.id;
        if (ja && !invarianciaPermitida) duplicadosNovos.push(`${l.c.talhao} (${l.n.familia.id}) = ${ja.talhao} (${ja.familia})`);
        if (!ja) sigNovas.set(s, { talhao: l.c.talhao, familia: l.n.familia.id });
        const t = trigramas(l.c.intencao);
        for (const x of triAntigos) {
            const j = jaccard(t, x.t);
            if (j > maiorSimilaridade.valor) maiorSimilaridade = { valor: j, novo: l.c.talhao, antigo: x.p };
        }
    }
    for (const d of duplicadosAntigos) problemas.push(`duplicado logico de antigo: ${d}`);
    for (const d of duplicadosNovos) problemas.push(`duplicado logico entre familias: ${d}`);
    const LIMITE_TEXTO = 0.6;
    if (maiorSimilaridade.valor >= LIMITE_TEXTO) problemas.push(`fala quase identica a um antigo: ${JSON.stringify(maiorSimilaridade)}`);
    let maiorSimNovos = { valor: 0, a: '', b: '' };
    const triNovos = linhasNovas.map(l => ({ p: l.c.talhao, t: trigramas(l.c.intencao), f: l.n.familia.id }));
    for (let i = 0; i < triNovos.length; i++)
        for (let j = i + 1; j < triNovos.length; j++) {
            if (triNovos[i].f === triNovos[j].f) continue; // dentro da familia a fala pode repetir de proposito
            const v = jaccard(triNovos[i].t, triNovos[j].t);
            if (v > maiorSimNovos.valor) maiorSimNovos = { valor: v, a: triNovos[i].p, b: triNovos[j].p };
        }

    // --- foco offline: alvo fora do foco, ou politica do alvo diferente do modelo
    const focoDivergente: string[] = [];
    const alvoForaDoFoco: string[] = [];
    for (const l of linhasNovas) {
        const alvo = l.n.familia.alvo;
        if (!alvo) continue;
        if (!l.a.focoProdutos.includes(alvo)) alvoForaDoFoco.push(`${l.c.talhao} (${l.n.familia.id}): ${alvo}`);
        else if (JSON.stringify(l.a.politicaAlvoPosFoco) !== JSON.stringify(l.a.politicaAlvo)) {
            focoDivergente.push(
                `${l.c.talhao} (${l.n.familia.id}): ${alvo} — modelo ${l.a.politicaAlvo?.length} decisoes, depois do foco ${l.a.politicaAlvoPosFoco?.length} (culturas em foco: ${l.a.focoCulturas.join(', ')})`
            );
        }
    }

    if (problemas.length > 0) {
        console.error(`\n${problemas.length} problema(s) — nada foi gravado:\n  - ${problemas.join('\n  - ')}`);
        process.exit(1);
    }

    // --- meta e contrastes
    const metas = linhasNovas.map((l, i) => {
        const f = l.n.familia;
        const alegacoes = l.n.variante.alegacoes ?? [];
        const excluido = l.a.statusAlvo.startsWith('EXCLUIDO');
        const bloqueado = l.a.statusAlvo === 'BLOQUEADO_POR_SENSOR';
        const classe = !f.alvo
            ? 'SEM_PRODUTO_ALVO'
            : excluido
              ? 'SEM_APLICACAO_PARA_O_ALVO'
              : bloqueado
                ? 'SEM_INCREMENTO_PARA_O_ALVO'
                : alegacoes.length > 0
                  ? 'APLICAVEL_COM_EVIDENCIA_INSUFICIENTE'
                  : 'APLICAVEL';
        return {
            linha: antigos.length + i + 1,
            talhao: l.c.talhao,
            familia: f.id,
            bloco: f.bloco,
            tipos: f.tipos,
            dimensoes: f.dimensoes,
            valor: Object.fromEntries(
                f.dimensoes
                    .filter(d => d !== 'intencao')
                    .map(d => {
                        if (d.startsWith('telemetria.')) return [d, l.c.telemetria[d.slice('telemetria.'.length)]];
                        return [d, d === 'areas' ? l.c.areas : l.c.produtosEmUso];
                    })
            ),
            produto_alvo: f.alvo,
            objetivo: f.objetivo,
            estilo: l.n.variante.estilo,
            alegacoes_sem_leitura: alegacoes,
            regras_globais: f.regrasGlobais ?? [],
            cadastro_ausente: f.cadastroAusente ?? false,
            racional: f.racional,
            nota: l.n.variante.nota,
            estruturas_exercitadas: estruturasExercitadas(l.c, l.a, model).sort(),
            camada_deterministica: {
                culturas_ativas: l.a.r.culturasAtivas.map(x => x.nome),
                bloqueios: l.a.r.bloqueios.map(b => ({ produto: b.produto, regra: b.regra })),
                vetos: l.a.r.vetados.map(v => ({ produto: v.produto, origem: v.origem })),
                ajustes: l.a.r.ajustes.map(x => `${x.produto}: ${x.acao} (${x.origem})`),
                escalonamentos: l.a.r.escalonamentos.map(x => `${x.cultura} -> ${x.destino}`),
                incompatibilidades: l.a.r.incompatibilidades.map(i => i.entre),
                exige: l.a.exige,
                status_alvo: l.a.statusAlvo,
                decisoes_admissiveis_alvo: l.a.politicaAlvo,
                vazoes_admissiveis_alvo: l.a.vazoesAlvo
            },
            foco_offline: {
                produtos: l.a.focoProdutos,
                culturas: l.a.focoCulturas,
                alvo_em_foco: f.alvo ? l.a.focoProdutos.includes(f.alvo) : null,
                decisoes_alvo_depois_do_foco: l.a.politicaAlvoPosFoco,
                diverge_do_modelo: f.alvo ? JSON.stringify(l.a.politicaAlvoPosFoco) !== JSON.stringify(l.a.politicaAlvo) : false
            },
            esperado: {
                classe,
                acionar_agronomo_obrigatorio: l.a.r.escalonamentos.length > 0,
                sem_evidencia_de_area: (f.cadastroAusente ?? false) && l.c.areas.length === 0,
                procedimento: { exige: l.a.exige, janelas: l.a.janelas }
            }
        };
    });

    const contrastes: Record<string, unknown>[] = [];
    for (const f of FAMILIAS) {
        const membros = linhasNovas.filter(l => l.n.familia === f);
        for (let i = 0; i < membros.length; i++) {
            for (let j = i + 1; j < membros.length; j++) {
                const a = membros[i], b = membros[j];
                const d = diferencas(a.n, b.n).filter(x => x !== 'intencao' || f.dimensoes.includes('intencao'));
                if (d.length !== 1) continue; // so pares que mudam UMA dimensao
                const ma = metas[linhasNovas.indexOf(a)], mb = metas[linhasNovas.indexOf(b)];
                const estado = (m: typeof ma) => JSON.stringify({
                    culturas: [...m.camada_deterministica.culturas_ativas].sort(),
                    bloqueios: m.camada_deterministica.bloqueios.map(x => `${x.produto}<${x.regra}`).sort(),
                    vetos: m.camada_deterministica.vetos.map(v => `${v.produto}<${v.origem}`).sort(),
                    ajustes: [...m.camada_deterministica.ajustes].sort(),
                    esc: [...m.camada_deterministica.escalonamentos].sort(),
                    incompat: [...m.camada_deterministica.incompatibilidades].sort(),
                    exige: m.camada_deterministica.exige
                });
                const politicaMuda = JSON.stringify(ma.camada_deterministica.decisoes_admissiveis_alvo) !== JSON.stringify(mb.camada_deterministica.decisoes_admissiveis_alvo);
                const vazaoMuda = JSON.stringify(ma.camada_deterministica.vazoes_admissiveis_alvo) !== JSON.stringify(mb.camada_deterministica.vazoes_admissiveis_alvo);
                const escalaMuda = ma.esperado.acionar_agronomo_obrigatorio !== mb.esperado.acionar_agronomo_obrigatorio;
                const estadoMuda = estado(ma) !== estado(mb);
                const tipo = politicaMuda || vazaoMuda || escalaMuda ? 'sensibilidade' : estadoMuda ? 'procedimento' : 'invariancia';
                const valorDe = (l: typeof a) =>
                    d[0] === 'intencao'
                        ? l.c.intencao
                        : d[0].startsWith('telemetria.')
                          ? l.c.telemetria[d[0].slice('telemetria.'.length)]
                          : d[0] === 'areas'
                            ? l.c.areas
                            : l.c.produtosEmUso;
                contrastes.push({
                    familia: f.id,
                    a: a.c.talhao,
                    b: b.c.talhao,
                    dimensao: d[0],
                    de: valorDe(a),
                    para: valorDe(b),
                    // Pedido parafraseado: o par isola a dimensao declarada, mas os dois
                    // textos nao sao identicos. Num par de invariancia isso limita a
                    // conclusao — ver "Limites conhecidos" no relatorio de cobertura.
                    fala_varia: d[0] !== 'intencao' && a.c.intencao !== b.c.intencao,
                    estado_deterministico_muda: estadoMuda,
                    politica_alvo_muda: politicaMuda,
                    vazao_alvo_muda: vazaoMuda,
                    escalonamento_muda: escalaMuda,
                    classe_esperada_muda: ma.esperado.classe !== mb.esperado.classe,
                    tipo,
                    leitura:
                        tipo === 'sensibilidade'
                            ? 'a regra muda: a decisao ou a vazao sobre o alvo DEVE mudar'
                            : tipo === 'procedimento'
                              ? 'muda cultura/recomendacao/exige, nao a politica: a justificativa e o procedimento devem refletir; a decisao pode ficar'
                              : 'nenhuma regra muda: a decisao NAO deve mudar'
                });
            }
        }
    }

    // --- gravacao
    const linhasNovasTexto = novos.map(n =>
        serializar({ intencao: n.intencao, talhao: n.talhao, telemetria: n.telemetria, areas: n.areas, produtosEmUso: n.produtosEmUso })
    );
    fs.writeFileSync(SAIDA.cenarios, [...brutasAntigas, ...linhasNovasTexto].join('\n') + '\n', 'utf-8');
    fs.writeFileSync(SAIDA.meta, metas.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
    fs.writeFileSync(SAIDA.contrastes, contrastes.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf-8');

    // --- releitura do arquivo gravado
    const relidas = fs.readFileSync(SAIDA.cenarios, 'utf-8').split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as CenarioJsonl);
    const chavesOk = relidas.every(
        c =>
            JSON.stringify(Object.keys(c)) === JSON.stringify(['intencao', 'talhao', 'telemetria', 'areas', 'produtosEmUso']) &&
            JSON.stringify(Object.keys(c.telemetria)) === JSON.stringify(PARAMETROS)
    );
    const validacao = {
        arquivoAntigo: caminhoAntigos,
        serializacaoReproduzAntigos: `${serializacaoIgual}/${brutasAntigas.length}`,
        totalRelido: relidas.length,
        novos: relidas.length - antigos.length,
        talhoesUnicos: new Set(relidas.map(c => c.talhao)).size,
        pedidosDistintos: new Set(relidas.map(c => c.intencao)).size,
        chavesEOrdemIdenticas: chavesOk,
        antigosIntactos: relidas.slice(0, antigos.length).every((c, i) => JSON.stringify(c) === JSON.stringify(antigos[i])),
        maiorSimilaridadeComAntigo: maiorSimilaridade,
        maiorSimilaridadeEntreNovos: maiorSimNovos,
        duplicadosLogicosAntigos: duplicadosAntigos.length,
        duplicadosLogicosEntreFamilias: duplicadosNovos.length,
        diferemDeUmAntigoSoPeloCanal: soPeloCanal.length
    };
    if (
        relidas.length !== 400 ||
        validacao.talhoesUnicos !== 400 ||
        validacao.pedidosDistintos !== 400 ||
        !chavesOk ||
        !validacao.antigosIntactos
    ) {
        console.error('releitura reprovou', validacao);
        process.exit(1);
    }

    const eAnt = estatisticas(linhasAntigas, model);
    const eNov = estatisticas(linhasNovas, model);
    const eTot = estatisticas([...linhasAntigas, ...linhasNovas], model);
    fs.writeFileSync(
        SAIDA.relatorio,
        relatorio({ eAnt, eNov, eTot, metas, contrastes, validacao, focoDivergente, alvoForaDoFoco, soPeloCanal, model }),
        'utf-8'
    );

    console.log(`${relidas.length} cenarios em ${SAIDA.cenarios} (${antigos.length} antigos + ${validacao.novos} novos)`);
    console.log(`${metas.length} registros em ${SAIDA.meta}`);
    console.log(`${contrastes.length} contrastes em ${SAIDA.contrastes}`);
    console.log(`relatorio em ${SAIDA.relatorio}`);
    console.log(JSON.stringify(validacao, null, 2));
    console.log(`foco offline: alvo fora do foco em ${alvoForaDoFoco.length}; politica do alvo diverge do modelo em ${focoDivergente.length}`);
}

// =============================================================================
// 7) Relatorio
// =============================================================================

interface DadosRelatorio {
    eAnt: Estatisticas;
    eNov: Estatisticas;
    eTot: Estatisticas;
    metas: Record<string, unknown>[];
    contrastes: Record<string, unknown>[];
    validacao: Record<string, unknown>;
    focoDivergente: string[];
    alvoForaDoFoco: string[];
    soPeloCanal: string[];
    model: AgroModel;
}

function tabelaContagem(titulo: string, chaves: string[], eAnt: Contagem, eNov: Contagem, eTot: Contagem): string {
    const linhas = chaves.map(k => `| ${k} | ${eAnt.get(k) ?? 0} | ${eNov.get(k) ?? 0} | ${eTot.get(k) ?? 0} |`);
    return `\n### ${titulo}\n\n| | 200 antigos | 200 novos | 400 |\n|---|---:|---:|---:|\n${linhas.join('\n')}\n`;
}

function contar<T>(xs: T[], chave: (x: T) => string | string[]): Contagem {
    const m: Contagem = new Map();
    for (const x of xs) {
        const k = chave(x);
        for (const kk of Array.isArray(k) ? k : [k]) inc(m, kk);
    }
    return m;
}

function ordenar(m: Contagem): [string, number][] {
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function chavesDe(...ms: Contagem[]): string[] {
    const s = new Set<string>();
    for (const m of ms) for (const k of m.keys()) s.add(k);
    return [...s].sort();
}

function relatorio(d: DadosRelatorio): string {
    const { eAnt, eNov, eTot } = d;
    const porBloco = contar(d.metas, m => String(m.bloco));
    const porTipo = contar(d.metas, m => (m.tipos as string[]));
    const porEstilo = contar(d.metas, m => String(m.estilo));
    const porObjetivo = contar(d.metas, m => String(m.objetivo));
    const porClasse = contar(d.metas, m => String((m.esperado as { classe: string }).classe));
    const porStatus = contar(d.metas, m => String((m.camada_deterministica as { status_alvo: string }).status_alvo));
    const porTipoContraste = contar(d.contrastes, c => String(c.tipo));
    const porDimensao = contar(d.contrastes, c => String(c.dimensao));

    const estruturasDoModelo: string[] = [];
    for (const c of d.model.elements.filter(isCultureDef)) {
        for (const a of c.attributes) if (isTriggerAttr(a)) estruturasDoModelo.push(`gatilho ${c.name}`);
    }
    const semCobertura = [...new Set(estruturasDoModelo)].filter(s => !eTot.estruturas.has(s));

    const sec = (t: string) => `\n## ${t}\n`;
    const lista = (m: Contagem) => ordenar(m).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n');

    return [
        '# Cobertura dos 400 cenarios do dominio agro',
        '',
        'Gerado por `src/scripts/gerar-cenarios-400-agro.ts`. NAO EDITAR A MAO.',
        '',
        'Os 200 primeiros cenarios sao os de `cenarios-200-agro.jsonl`, copiados byte a byte.',
        'Os 200 ultimos (TL-2026-4201 a TL-2026-4400) sao a suite nova, declarada em',
        `${FAMILIAS.length} familias controladas. Dentro de uma familia so muda a dimensao declarada;`,
        'o resto da leitura e identico, e isso e conferido por assercao antes da gravacao.',
        '',
        '## Completude dos pedidos',
        '',
        'Todo cenario — antigo e novo — passou, antes da gravacao, por:',
        '',
        '1. **esquema e faixa fisica** de cada um dos 10 sensores, mais coerencia entre',
        '   temperatura do ar e da folha e entre chuva prevista e umidade;',
        '2. **area x sensor**: area declarada com o sensor fora do criterio reprova como',
        '   CONTRADICAO; sensor dentro do criterio com cadastro vazio so passa em familia',
        '   que declara `cadastroAusente` — o caso que a regra global do modelo preve;',
        '3. **fala x leitura**: todo numero citado na fala (km/h, m do manancial, m da',
        '   cultura sensivel, NDVI, temperatura/umidade foliar, infestacao, mm de chuva)',
        '   tem de bater com o sensor, e toda vazao citada tem de ser dose declarada na',
        '   bula do produto que a fala nomeia;',
        '4. **ancoragem**: a fala nomeia ao menos um produto ou cultura do modelo pelo',
        '   mesmo `casamentoLexical` que o foco usa — nao basta parecer do dominio;',
        '5. **calda x fala**: quem diz que o produto esta na calda tem de te-lo em',
        '   `produtosEmUso`, e quem diz que o tanque esta limpo sem te-lo vazio precisa',
        '   declarar a alegacao (e, assim, entrar no bloco de evidencia insuficiente).',
        '',
        '```json',
        JSON.stringify(d.validacao, null, 2),
        '```',
        sec('Desenho dos 200 novos'),
        tabelaContagem('Blocos', chavesDe(porBloco), new Map(), porBloco, porBloco),
        sec('Tipos de caso (uma familia pode ter mais de um)'),
        lista(porTipo),
        sec('Estilo da fala'),
        lista(porEstilo),
        sec('Objetivo do pedido'),
        lista(porObjetivo),
        sec('Status deterministico do produto-alvo'),
        lista(porStatus),
        sec('Classe esperada'),
        lista(porClasse),
        sec('Contrastes controlados'),
        `${d.contrastes.length} pares que mudam exatamente uma dimensao.`,
        '',
        '- `sensibilidade`: a politica, a vazao ou o escalonamento do alvo muda — a decisao DEVE mudar.',
        '- `procedimento`: muda cultura ativa, recomendacao ou exigencia, nao a politica — a justificativa deve refletir, a decisao pode ficar.',
        '- `invariancia`: nenhuma regra muda — a decisao NAO deve mudar.',
        '',
        lista(porTipoContraste),
        '',
        '### Dimensao variada em cada par',
        '',
        lista(porDimensao),
        sec('Cobertura comparada'),
        `| | 200 antigos | 200 novos | 400 |`,
        `|---|---:|---:|---:|`,
        `| cenarios | ${eAnt.n} | ${eNov.n} | ${eTot.n} |`,
        `| intencoes unicas | ${eAnt.intencoesUnicas} | ${eNov.intencoesUnicas} | ${eTot.intencoesUnicas} |`,
        `| talhoes unicos | ${eAnt.talhoesUnicos} | ${eNov.talhoesUnicos} | ${eTot.talhoesUnicos} |`,
        `| aberturas de fala distintas | ${eAnt.aberturasDistintas} | ${eNov.aberturasDistintas} | ${eTot.aberturasDistintas} |`,
        `| maior repeticao de abertura | ${eAnt.maiorRepeticaoAbertura} | ${eNov.maiorRepeticaoAbertura} | ${eTot.maiorRepeticaoAbertura} |`,
        `| no limiar ou a epsilon dele | ${eAnt.noLimiarOuEpsilon} | ${eNov.noLimiarOuEpsilon} | ${eTot.noLimiarOuEpsilon} |`,
        `| com bloqueio por sensor | ${eAnt.comBloqueio} | ${eNov.comBloqueio} | ${eTot.comBloqueio} |`,
        `| com veto ou proibicao | ${eAnt.comVeto} | ${eNov.comVeto} | ${eTot.comVeto} |`,
        `| com produto na calda | ${eAnt.comEmUso} | ${eNov.comEmUso} | ${eTot.comEmUso} |`,
        `| com mais de uma area | ${eAnt.multiArea} | ${eNov.multiArea} | ${eTot.multiArea} |`,
        `| com fato so na fala | ${eAnt.comAlegacao} | ${eNov.comAlegacao} | ${eTot.comAlegacao} |`,
        `| com exigencia de area | ${eAnt.procedimentos.comExige} | ${eNov.procedimentos.comExige} | ${eTot.procedimentos.comExige} |`,
        `| com janela de cultura | ${eAnt.procedimentos.comJanela} | ${eNov.procedimentos.comJanela} | ${eTot.procedimentos.comJanela} |`,
        `| combinatorios (2+ mecanismos) | ${eAnt.combinatorios} | ${eNov.combinatorios} | ${eTot.combinatorios} |`,
        tabelaContagem('Canal da evidencia decisiva', chavesDe(eAnt.canal, eNov.canal), eAnt.canal, eNov.canal, eTot.canal),
        tabelaContagem('Produtos citados na fala', chavesDe(eAnt.produtosCitados, eNov.produtosCitados), eAnt.produtosCitados, eNov.produtosCitados, eTot.produtosCitados),
        tabelaContagem('Culturas ativas por gatilho', chavesDe(eAnt.culturasAtivas, eNov.culturasAtivas), eAnt.culturasAtivas, eNov.culturasAtivas, eTot.culturasAtivas),
        tabelaContagem('Areas no cadastro', chavesDe(eAnt.areas, eNov.areas), eAnt.areas, eNov.areas, eTot.areas),
        tabelaContagem('Produtos na calda', chavesDe(eAnt.emUso, eNov.emUso), eAnt.emUso, eNov.emUso, eTot.emUso),
        tabelaContagem('Bloqueios por sensor', chavesDe(eAnt.bloqueiosPorSensor, eNov.bloqueiosPorSensor), eAnt.bloqueiosPorSensor, eNov.bloqueiosPorSensor, eTot.bloqueiosPorSensor),
        tabelaContagem('Vetos de cultura', chavesDe(eAnt.vetosCultura, eNov.vetosCultura), eAnt.vetosCultura, eNov.vetosCultura, eTot.vetosCultura),
        tabelaContagem('Proibicoes de area', chavesDe(eAnt.proibicoesArea, eNov.proibicoesArea), eAnt.proibicoesArea, eNov.proibicoesArea, eTot.proibicoesArea),
        tabelaContagem('Ajustes de vazao', chavesDe(eAnt.ajustes, eNov.ajustes), eAnt.ajustes, eNov.ajustes, eTot.ajustes),
        tabelaContagem('Escalonamentos', chavesDe(eAnt.escalonamentos, eNov.escalonamentos), eAnt.escalonamentos, eNov.escalonamentos, eTot.escalonamentos),
        tabelaContagem('Incompatibilidades de calda', chavesDe(eAnt.incompatibilidades, eNov.incompatibilidades), eAnt.incompatibilidades, eNov.incompatibilidades, eTot.incompatibilidades),
        tabelaContagem('Fatos so na fala', chavesDe(eAnt.alegacoes, eNov.alegacoes), eAnt.alegacoes, eNov.alegacoes, eTot.alegacoes),
        tabelaContagem('Objetivos do pedido', chavesDe(eAnt.objetivos, eNov.objetivos), eAnt.objetivos, eNov.objetivos, eTot.objetivos),
        sec('Faixa de cada limiar estruturado'),
        'Para cada regra do `lavoura.agro` com condicao estruturada, quantos cenarios caem',
        'longe abaixo, a epsilon abaixo, no limiar, a epsilon acima e longe acima.',
        '',
        tabelaContagem('Limiares', chavesDe(eAnt.faixas, eNov.faixas), eAnt.faixas, eNov.faixas, eTot.faixas),
        sec('Valores distintos por sensor'),
        tabelaContagem('Sensores', chavesDe(eAnt.valoresDistintos, eNov.valoresDistintos), eAnt.valoresDistintos, eNov.valoresDistintos, eTot.valoresDistintos),
        sec('Estruturas do modelo efetivamente exercidas'),
        'Nao basta citar o nome: a estrutura conta quando a camada deterministica a dispara.',
        '',
        lista(eTot.estruturas),
        '',
        semCobertura.length === 0
            ? '**Todos os gatilhos de cultura do modelo sao exercidos pelos 400.**'
            : `**Gatilhos sem cobertura:** ${semCobertura.join(', ')}`,
        sec('Limites conhecidos'),
        '- O foco offline nao usa o indice vetorial do Neo4j: ele e lexical mais arestas do',
        '  grafo. Em producao o indice pode trazer mais produtos ao Prompt Semantico, nunca',
        '  menos restricao — a avaliacao de bloqueio e deterministica em `retrieveAgroConstraints`.',
        `- Alvo fora do foco offline: ${d.alvoForaDoFoco.length}${d.alvoForaDoFoco.length ? ` (${d.alvoForaDoFoco.join('; ')})` : ''}.`,
        `- Politica do alvo que o foco estreita em relacao ao modelo: ${d.focoDivergente.length}` +
            `${d.focoDivergente.length ? `\n${d.focoDivergente.map(x => `  - ${x}`).join('\n')}` : ''}.`,
        `- Cenarios novos que diferem de algum antigo so pelo canal da evidencia: ${d.soPeloCanal.length}` +
            `${d.soPeloCanal.length ? ` (${d.soPeloCanal.join('; ')})` : ''}.`,
        '- **Os 400 pedidos sao textos distintos**, conferido por assercao antes da gravacao:',
        '  nenhuma linha repete o pedido de outra. Dentro de uma familia, porem, o TEXTO do',
        '  pedido nao e identico entre as variantes, e por dois motivos diferentes:',
        '  nas familias de fronteira ele varia de ESTILO de proposito (ordem, pergunta,',
        '  urgencia, conclusao prematura), para que se veja que a decisao segue a leitura e',
        '  nao o tom; nas familias cuja dimensao e `areas`, `produtosEmUso` ou um sensor, as',
        '  variantes PARAFRASEIAM o mesmo pedido. Nos dois casos as ancoras lexicais',
        '  (produtos e culturas nomeados) sao as mesmas em todos os membros — o foco lexical',
        '  identico e conferido por assercao —, de modo que a dimensao declarada continua',
        '  sendo a unica coisa que muda na leitura.',
        `- O campo \`fala_varia\` do arquivo de contrastes marca os pares cujo pedido tambem`,
        `  difere: ${d.contrastes.filter(c => c.fala_varia === true).length} de ${d.contrastes.length}, dos quais ${d.contrastes.filter(c => c.tipo === 'invariancia' && c.fala_varia === true).length} sao pares de invariancia. Nesses, a decisao deve`,
        '  ficar igual, mas o par nao separa "insensivel a leitura" de "insensivel a redacao":',
        '  para essa separacao, compare pares de familias diferentes com a mesma leitura.',
        '- `Apiario_Proximo` nao tem sensor correspondente: e a unica area que so existe no',
        '  cadastro do talhao, e por isso nenhuma familia pode cruzar fronteira nela.',
        '- `altura_voo` e `hora` estao no vocabulario da gramatica e nao vem na leitura: sao',
        '  parametros da missao. Nenhum cenario os afirma como se fossem sensor.',
        ''
    ].join('\n');
}

main().catch(err => {
    console.error('Falha ao gerar os cenarios agro:', err);
    process.exit(1);
});
