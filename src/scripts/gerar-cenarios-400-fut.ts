/**
 * Expansao sistematica dos cenarios do dominio fut: os 200 antigos + 200 novos,
 * construidos como SUITE DE AVALIACAO, nao como exemplos.
 *
 * Os 200 novos sao declarados aqui em FAMILIAS CONTROLADAS. Dentro de uma
 * familia so muda a dimensao declarada (um parametro da leitura, os contextos,
 * as infracoes em uso ou a fala) — o resto da leitura e identico, e isso e
 * conferido por asserção. Assim, depois do lote, da para perguntar se o sistema
 * muda a decisao exatamente quando a regra do futebol.fut muda, e so entao.
 *
 * Nada aqui reimplementa a semantica da DSL:
 *
 *   - a camada deterministica esperada de cada cenario (lances ativos, vetos,
 *     proibicoes, escalonamentos, agravantes, politica da infracao-alvo) sai de
 *     `retrieveFutConstraints`, a MESMA funcao que o servidor usa;
 *   - o foco offline (nome escrito + arestas, sem indice vetorial) sai de
 *     `retrieverFocoFut` + `filtrarPorFocoFut`, como em test:foco-politica.
 *
 * O que este script acrescenta e o DESENHO: a familia, a dimensao controlada, o
 * objetivo do pedido, o estilo da fala e os fatos que so aparecem na fala
 * (alegacoes sem leitura). Isso vai para um arquivo a parte — o JSONL de
 * cenarios mantem exatamente o formato dos 200 antigos.
 *
 * Uso:
 *   npx tsx src/scripts/gerar-cenarios-400-fut.ts
 *
 * Gera:
 *   src/examples/fut/cenarios-400-fut.jsonl             200 antigos (copiados byte a byte) + 200 novos
 *   src/examples/fut/cenarios-400-fut.meta.jsonl        desenho + camada deterministica dos 200 novos
 *   src/examples/fut/cenarios-400-fut.contrastes.jsonl  pares controlados dentro de cada familia
 *   src/examples/fut/cobertura-400-fut.md               cobertura antigo x novo x total, achados e limites
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Session } from 'neo4j-driver';

import { loadFutModel } from '../database/neo4j-fut.js';
import {
    isContextDef,
    isContextRequire,
    isInfractionDef,
    isSituationDef,
    isStepAttr,
    type FutModel
} from '../generated/ast.js';
import { nomesFut } from '../knowledge/documentos.js';
import { casamentoLexical, normalizar, type SinalVetorial } from '../knowledge/foco.js';
import {
    filtrarPorFocoFut,
    retrieveFutConstraints,
    retrieverFocoFut,
    type FutContext,
    type RetrievedFutConstraints
} from '../knowledge/graphrag-fut.js';

// =============================================================================
// 1) Vocabulario do desenho
// =============================================================================

const PARAMETROS = [
    'minuto_partida',
    'acrescimo',
    'cartoes_amarelos_jogador',
    'distancia_ultimo_defensor',
    'velocidade_bola',
    'distancia_gol',
    'jogadores_entre_bola_e_gol',
    'tempo_revisao_var',
    'placar_diferenca',
    'faltas_acumuladas_time',
    'distancia_bola'
] as const;
type Parametro = (typeof PARAMETROS)[number];
type Tel = Record<Parametro, number>;

/** Campos que os 200 antigos sempre escrevem com ponto decimal (3.0, nao 3). */
const CAMPOS_FLOAT = new Set<string>(['distancia_ultimo_defensor', 'distancia_bola']);

type Bloco = 'fronteira' | 'veto_proibicao' | 'contexto' | 'var_procedimento' | 'evidencia' | 'negativo' | 'interacao' | 'unitario';

/** As oito categorias pedidas para a suite; uma familia pode ter mais de uma. */
type Tipo =
    | 'unitario_semantico'
    | 'fronteira'
    | 'negativo'
    | 'evidencia_insuficiente'
    | 'contextual'
    | 'combinatorio'
    | 'procedimento'
    | 'interacao';

type Dimensao = `telemetria.${Parametro}` | 'contextos' | 'infracoesEmUso' | 'intencao';

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
    | 'compara_infracoes'
    | 'pede_revisao'
    | 'manter_decisao'
    | 'procedimento';

type Objetivo =
    | 'anular_ou_confirmar_gol'
    | 'marcar_infracao'
    | 'sancao_disciplinar'
    | 'reinicio'
    | 'acionar_var'
    | 'manter_ou_paralisar'
    | 'classificar_infracao'
    | 'procedimento';

/**
 * Fato que so aparece na fala e que o futebol.fut declara NAO ser leitura da
 * partida (regra_global "Fato que so aparece no pedido..."). Codigos alinhados
 * com as lacunas de cobertura-200-fut.md.
 */
type Alegacao =
    | 'ZONA'
    | 'VAR_RES'
    | 'VISAO'
    | 'BRACO'
    | 'CONTATO'
    | 'DOGSO'
    | 'VANT'
    | 'AUTOR'
    | 'ALVO'
    | 'BOLA_JOGO'
    | 'FORCA'
    | 'CONTEXTO'
    | 'CARTAO_PREVIO'
    | 'POSICAO'
    | 'DISTANCIA'
    | 'METADE'
    | 'ISENCAO'
    | 'TENTATIVA'
    | 'APITO'
    | 'MARCACAO_PREVIA';

interface Variante {
    tel?: Partial<Tel>;
    ctx?: string[];
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
    /** Infracao cuja politica a familia observa; null quando o pedido nao tem infracao. */
    alvo: string | null;
    objetivo: Objetivo;
    /** Dimensoes que variam dentro da familia. Vazio: cenario isolado. */
    dimensoes: Dimensao[];
    /** Regras globais do futebol.fut que o pedido aciona (texto curto). */
    regrasGlobais?: string[];
    racional: string;
    base: Tel;
    ctx?: string[];
    uso?: string[];
    variantes: Variante[];
}

const T = (t: Tel): Tel => t;

// Regras globais citadas pelo desenho (resumo do texto do futebol.fut).
const RG_FATO_FALA = 'fato so no pedido nao e leitura';
const RG_VAR_RESULTADO = 'sem resultado registrado nao ha confirmacao/reversao pelo VAR';
const RG_VAR_5MIN = 'revisao do VAR em ate 5 min (exceto identidade)';
const RG_VISAO = 'visao clara ou confirmacao do assistente';
const RG_VANTAGEM = 'vantagem quando ha controle e progressao';
const RG_DUPLA = 'dupla advertencia exige registro sequencial na sumula';
const RG_24H = 'penalti e expulsao: comunicacao em 24 h';
const RG_REVERSAO = 'decisao revertida sinalizada no monitor';

// =============================================================================
// 2) As 66 familias (200 cenarios novos)
// =============================================================================

const FAMILIAS: Familia[] = [
    // ------------------------------------------------------------- FRONTEIRA (40)
    {
        id: 'FR-IMP-GOL',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Impedimento',
        objetivo: 'anular_ou_confirmar_gol',
        dimensoes: ['telemetria.distancia_ultimo_defensor'],
        racional:
            'Os gatilhos complementares `distancia_ultimo_defensor < 0` (Impedimento_Ataque) e `>= 0` (Posicao_Legal_No_Passe, que veta Impedimento) partem a reta em 0. Nos 200 antigos o valor 0 aparece 1 vez e |d|<=0,1 so 3 vezes. A fala nunca diz o valor: so a leitura decide.',
        base: T({ minuto_partida: 67, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0, velocidade_bola: 22, distancia_gol: 9, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.5 }),
        variantes: [
            { tel: { distancia_ultimo_defensor: -0.3 }, estilo: 'relato_e_pergunta', fala: 'Gol do centroavante logo depois do lançamento em profundidade, e o banco rival grita impedimento. Anulo ou deixo valer?' },
            { tel: { distancia_ultimo_defensor: -0.01 }, estilo: 'urgente', fala: 'Preciso de resposta rápida: o gol do camisa 9 tem impedimento ou eu confirmo?' },
            { tel: { distancia_ultimo_defensor: 0 }, estilo: 'pergunta_direta', fala: 'O assistente segurou a bandeira e a bola entrou. Tem impedimento nesse gol para eu anular?' },
            { tel: { distancia_ultimo_defensor: 0.01 }, estilo: 'ordem', fala: 'Confere o impedimento no gol que acabou de sair: o lançamento veio do meio-campo e o centroavante finalizou de primeira. Valido o gol?' },
            { tel: { distancia_ultimo_defensor: 0.3 }, estilo: 'manter_decisao', fala: 'Torcida e reservas reclamando de impedimento no gol do centroavante. Mantenho o gol?' }
        ]
    },
    {
        id: 'FR-IMP-BANDEIRA',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Impedimento',
        objetivo: 'marcar_infracao',
        dimensoes: ['telemetria.distancia_ultimo_defensor'],
        racional: 'Mesma fronteira em 0, agora sem gol: o pedido e sustentar ou nao a bandeira (TIRO_LIVRE_INDIRETO x MANTER_JOGO). Valores a +-5 cm.',
        base: T({ minuto_partida: 34, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0, velocidade_bola: 15, distancia_gol: 28, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        variantes: [
            { tel: { distancia_ultimo_defensor: -0.05 }, estilo: 'pergunta_direta', fala: 'Contragolpe interrompido pela bandeira: o assistente marcou impedimento do ponta. Confirmo o tiro livre indireto?' },
            { tel: { distancia_ultimo_defensor: 0 }, estilo: 'duvida_operacional', fala: 'O bandeira levantou na puxada rápida e eu apitei. Sustento o impedimento do ponta ou recomeço com bola ao chão?' },
            { tel: { distancia_ultimo_defensor: 0.05 }, estilo: 'manter_decisao', fala: 'Apitei a bandeirada de impedimento do ponta no contragolpe. Errei ao parar o jogo?' }
        ]
    },
    {
        id: 'FR-MAO-BRACO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Mao_Deliberada',
        objetivo: 'marcar_infracao',
        dimensoes: ['telemetria.distancia_bola'],
        racional:
            '`Mao_Curta_Distancia` dispara em `distancia_bola < 1.0` e veta Mao_Deliberada. Em 1.00 o veto NAO incide (operador estrito). A fala nao diz a distancia nem a posicao do braco, para que a unica diferenca seja a leitura.',
        base: T({ minuto_partida: 58, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.2, velocidade_bola: 19, distancia_gol: 14, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1 }),
        variantes: [
            { tel: { distancia_bola: 0.5 }, estilo: 'pergunta_direta', fala: 'O cruzamento bateu no braço do zagueiro que vinha correndo. Marco mão deliberada?' },
            { tel: { distancia_bola: 0.99 }, estilo: 'compara_infracoes', fala: 'Chute travado com o braço do volante. Isso é mão deliberada ou deixo seguir?' },
            { tel: { distancia_bola: 1 }, estilo: 'duvida_operacional', fala: 'A bola explodiu no braço do lateral depois do chute cruzado. Quero saber se apito mão deliberada.' },
            { tel: { distancia_bola: 1.01 }, estilo: 'info_irrelevante', fala: 'Mão deliberada do zagueiro no bloqueio do chute? O atacante pede falta com insistência e o técnico já está fora da área técnica.' },
            { tel: { distancia_bola: 1.6 }, estilo: 'urgente', fala: 'Responde logo: a bola acertou o braço do zagueiro no cruzamento. Mão deliberada ou não?' }
        ]
    },
    {
        id: 'FR-MAO-MEIO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Mao_Deliberada',
        objetivo: 'reinicio',
        dimensoes: ['telemetria.distancia_bola'],
        racional: 'Fronteira de 1.0 m longe do gol, onde a pergunta e o tiro livre direto e nao o penalti — tira a zona do caminho.',
        base: T({ minuto_partida: 23, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.0, velocidade_bola: 12, distancia_gol: 41, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1 }),
        variantes: [
            { tel: { distancia_bola: 0.95 }, estilo: 'pergunta_direta', fala: 'No meio-campo, o volante cortou o passe com o braço. É mão deliberada para tiro livre direto?' },
            { tel: { distancia_bola: 1 }, estilo: 'relato_e_pergunta', fala: 'Passe interceptado com o braço lá na intermediária defensiva. Dou tiro livre direto por mão deliberada?' },
            { tel: { distancia_bola: 1.05 }, estilo: 'duvida_operacional', fala: 'Mão deliberada no corte do passe no círculo central: o braço foi na bola ou a bola no braço? Marco a falta?' }
        ]
    },
    {
        id: 'FR-CV-DISTANCIA',
        bloco: 'fronteira',
        tipos: ['fronteira', 'procedimento'],
        alvo: 'Conduta_Violenta',
        objetivo: 'classificar_infracao',
        dimensoes: ['telemetria.distancia_bola'],
        racional:
            '`Conduta_Violenta_Jogo` dispara em `distancia_bola > 2.0` e RECOMENDA Conduta_Violenta (fora da disputa), com etapas de parada imediata e revisao do vermelho. Nao veta nada: a politica nao muda, muda o lance ativo e a recomendacao. Nos antigos, 2.0 aparece 1 vez.',
        base: T({ minuto_partida: 71, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.8, velocidade_bola: 9, distancia_gol: 33, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 4, distancia_bola: 2 }),
        variantes: [
            { tel: { distancia_bola: 1.5 }, estilo: 'conclusao_prematura', fala: 'Cotovelada do zagueiro no rosto do centroavante depois do cruzamento. Conduta violenta ou entrada violenta? Já vou de vermelho.' },
            { tel: { distancia_bola: 1.99 }, estilo: 'compara_infracoes', fala: 'O meia acertou um soco no marcador na sequência do lance. Classifico como conduta violenta ou entrada violenta?' },
            { tel: { distancia_bola: 2 }, estilo: 'pergunta_direta', fala: 'Tapa no rosto do lateral num lance confuso. Isso é conduta violenta ou entrada violenta, e qual a sanção?' },
            { tel: { distancia_bola: 2.01 }, estilo: 'duvida_operacional', fala: 'Expulsão direta? O ponteiro deu uma cotovelada no marcador e não sei se registro conduta violenta ou entrada violenta.' },
            { tel: { distancia_bola: 3 }, estilo: 'procedimento', fala: 'Cotovelada do volante no adversário: antes de mostrar o vermelho, quero saber se escrevo conduta violenta ou entrada violenta.' }
        ]
    },
    {
        id: 'FR-CUSP-DISTANCIA',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Cusparada',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.distancia_bola'],
        racional: 'A mesma fronteira de 2.0 m decide se Conduta_Violenta_Jogo recomenda Cusparada. Bola parada (escanteio): a distancia e do incidente a bola.',
        base: T({ minuto_partida: 80, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.5, velocidade_bola: 0, distancia_gol: 18, jogadores_entre_bola_e_gol: 5, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 3, distancia_bola: 2 }),
        variantes: [
            { tel: { distancia_bola: 1.9 }, estilo: 'pergunta_direta', fala: 'Na cobrança de escanteio, o zagueiro cuspiu no atacante que o marcava. Cusparada é vermelho na hora?' },
            { tel: { distancia_bola: 2 }, estilo: 'duvida_operacional', fala: 'Cusparada do zagueiro no atacante enquanto esperavam o escanteio. Expulso agora ou paro e consulto alguém?' },
            { tel: { distancia_bola: 2.1 }, estilo: 'relato_e_pergunta', fala: 'Vi uma cusparada no escanteio, zagueiro contra atacante. Qual a decisão e como recomeço?' }
        ]
    },
    {
        id: 'FR-REINC-SIMULACAO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.cartoes_amarelos_jogador'],
        regrasGlobais: [RG_DUPLA],
        racional:
            '`Jogador_Sem_Advertencia` dispara em `cartoes_amarelos_jogador < 1` e veta Reincidencia_Amarelo. O parametro e inteiro e so 0 ou 1 sao coerentes (2 amarelos = jogador ja expulso): a fronteira e o par 0/1, sem +-epsilon. Infracao de base: Simulacao.',
        base: T({ minuto_partida: 63, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.1, velocidade_bola: 14, distancia_gol: 15, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [
            { tel: { cartoes_amarelos_jogador: 0 }, estilo: 'duvida_operacional', fala: 'O ponta se jogou na entrada da área procurando falta. Se eu entender simulação, cabe reincidência com segundo amarelo?' },
            { tel: { cartoes_amarelos_jogador: 1 }, estilo: 'pergunta_direta', fala: 'Simulação do ponta na entrada da área. Cabe reincidência, com segundo amarelo e expulsão?', nota: 'Reincidencia aplicavel: `sancao CARTAO_AMARELO reincidencia CARTAO_VERMELHO`.' }
        ]
    },
    {
        id: 'FR-REINC-PERDA',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.cartoes_amarelos_jogador'],
        regrasGlobais: [RG_DUPLA],
        racional: 'Par 0/1 de cartoes com Perda_Tempo como infracao de base (tiro de meta retido).',
        base: T({ minuto_partida: 79, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.5, velocidade_bola: 0, distancia_gol: 5, jogadores_entre_bola_e_gol: 0, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        variantes: [
            { tel: { cartoes_amarelos_jogador: 0 }, estilo: 'relato_e_pergunta', fala: 'O goleiro está segurando o tiro de meta de propósito. Perda de tempo com reincidência: mostro o segundo amarelo?' },
            { tel: { cartoes_amarelos_jogador: 1 }, estilo: 'pergunta_direta', fala: 'Perda de tempo do goleiro no tiro de meta. Isso fecha a reincidência no amarelo e ele sai?' }
        ]
    },
    {
        id: 'FR-REINC-DISSENSO',
        bloco: 'fronteira',
        tipos: ['fronteira'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.cartoes_amarelos_jogador'],
        regrasGlobais: [RG_DUPLA],
        racional: 'Par 0/1 de cartoes com Dissenso como infracao de base.',
        base: T({ minuto_partida: 52, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.9, velocidade_bola: 0, distancia_gol: 30, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 3, distancia_bola: 1.5 }),
        variantes: [
            { tel: { cartoes_amarelos_jogador: 0 }, estilo: 'pergunta_direta', fala: 'O zagueiro reclamou aos berros, gesticulando. Dissenso aqui já é reincidência para o segundo amarelo?' },
            { tel: { cartoes_amarelos_jogador: 1 }, estilo: 'relato_e_pergunta', fala: 'Dissenso escancarado do zagueiro depois da marcação. Vai a reincidência no amarelo, com expulsão?' }
        ]
    },
    {
        id: 'FR-REINC-EMUSO',
        bloco: 'fronteira',
        tipos: ['fronteira', 'interacao', 'evidencia_insuficiente'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.cartoes_amarelos_jogador'],
        regrasGlobais: [RG_DUPLA, RG_FATO_FALA],
        racional:
            'Simulacao ja marcada na partida (infracoesEmUso) nas duas variantes; so a sumula do jogador muda. Infracao em uso e da partida, nao do jogador: ela nao substitui o registro do primeiro amarelo ("pedido... nao e registro").',
        base: T({ minuto_partida: 70, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.2, velocidade_bola: 0, distancia_gol: 18, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 4, distancia_bola: 1.5 }),
        uso: ['Simulacao'],
        variantes: [
            { tel: { cartoes_amarelos_jogador: 0 }, estilo: 'alegacao_sem_leitura', alegacoes: ['MARCACAO_PREVIA'], fala: 'Simulação já foi marcada nesta partida e agora o ponta caiu sozinho de novo. É reincidência para o segundo amarelo?' },
            { tel: { cartoes_amarelos_jogador: 1 }, estilo: 'alegacao_sem_leitura', alegacoes: ['MARCACAO_PREVIA'], fala: 'De novo o ponta se atirou, e já há simulação marcada no jogo. Reincidência com segundo amarelo e expulsão?' }
        ]
    },
    {
        id: 'FR-VAR-DOGSO',
        bloco: 'fronteira',
        tipos: ['fronteira', 'procedimento'],
        alvo: 'Contato_Goleiro_Area',
        objetivo: 'acionar_var',
        dimensoes: ['telemetria.tempo_revisao_var'],
        regrasGlobais: [RG_VAR_5MIN, RG_VAR_RESULTADO],
        racional:
            '`Revisao_VAR_Prolongada` dispara e ESCALA para o VAR em `tempo_revisao_var > 5.0`: ACIONAR_VAR passa a ser obrigatorio no artefato (contrato: escalonamento_ignorado). Nos antigos o valor nunca fica entre 4 e 6. Valores decimais (minutos) sao necessarios para o +-epsilon.',
        base: T({ minuto_partida: 61, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.0, velocidade_bola: 0, distancia_gol: 12, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 5, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.3 }),
        variantes: [
            { tel: { tempo_revisao_var: 4.5 }, estilo: 'duvida_operacional', fala: 'O VAR segue checando o contato do goleiro com o atacante dentro da área. Espero mais ou já decido no campo?' },
            { tel: { tempo_revisao_var: 4.99 }, estilo: 'pergunta_direta', fala: 'Contato do goleiro no atacante, na área, ainda em análise pelo VAR. O que faço agora?' },
            { tel: { tempo_revisao_var: 5 }, estilo: 'pede_revisao', fala: 'Continuam olhando no vídeo o contato do goleiro dentro da área. Vou ao monitor ou aguardo o chamado?' },
            { tel: { tempo_revisao_var: 5.01 }, estilo: 'duvida_operacional', fala: 'A cabine não fecha a análise do contato do goleiro na área. Posso reiniciar sem o resultado?' },
            { tel: { tempo_revisao_var: 6.5 }, estilo: 'relato_informal', fala: 'Nada de resposta do VAR sobre o contato do goleiro dentro da área. Sigo esperando?' }
        ]
    },
    {
        id: 'FR-VAR-IMP',
        bloco: 'fronteira',
        tipos: ['fronteira', 'procedimento'],
        alvo: 'Impedimento',
        objetivo: 'acionar_var',
        dimensoes: ['telemetria.tempo_revisao_var'],
        regrasGlobais: [RG_VAR_5MIN, RG_VAR_RESULTADO],
        racional: 'Fronteira de 5 min com Impedimento_Ataque ativo (atacante adiantado): o escalonamento se soma a uma infracao aplicavel.',
        base: T({ minuto_partida: 77, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: -0.15, velocidade_bola: 0, distancia_gol: 10, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 5, placar_diferenca: 1, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [
            { tel: { tempo_revisao_var: 4.9 }, estilo: 'duvida_operacional', fala: 'O gol está parado porque o VAR ainda traça a linha do impedimento. Confirmo o gol ou espero?' },
            { tel: { tempo_revisao_var: 5 }, estilo: 'pergunta_direta', fala: 'Checagem de impedimento do gol sem fim na cabine. Devo ir ao monitor?' },
            { tel: { tempo_revisao_var: 5.1 }, estilo: 'relato_informal', fala: 'Seguimos aguardando a linha do impedimento no lance do gol. Quanto tempo mais eu espero?' }
        ]
    },

    // ------------------------------------------------------ VETO E PROIBICAO (24)
    {
        id: 'VP-DP-REINC',
        bloco: 'veto_proibicao',
        tipos: ['combinatorio', 'contextual', 'interacao'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.cartoes_amarelos_jogador', 'contextos'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'Fatorial 2x2: veto por lance (cartoes 0) x proibicao por contexto (Disputa_Penaltis proibe Reincidencia_Amarelo, Lei 10). Nas variantes sem contexto a disputa so aparece na fala: a proibicao nao incide e o contexto fica como evidencia insuficiente. Celula (0, DP) = dupla exclusao redundante.',
        base: T({ minuto_partida: 122, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.0, velocidade_bola: 0, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        variantes: [
            { tel: { cartoes_amarelos_jogador: 0 }, ctx: [], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Disputa de pênaltis: o goleiro provocou o cobrador e o capitão adversário cobra reincidência com segundo amarelo. Aplico?' },
            { tel: { cartoes_amarelos_jogador: 1 }, ctx: [], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Na disputa de pênaltis o goleiro debochou do cobrador; o capitão quer a reincidência e o segundo amarelo. Mostro?' },
            { tel: { cartoes_amarelos_jogador: 0 }, ctx: ['Disputa_Penaltis'], estilo: 'relato_e_pergunta', fala: 'O goleiro provocou o cobrador na disputa de pênaltis e o capitão rival exige reincidência, segundo amarelo. Faço isso?' },
            { tel: { cartoes_amarelos_jogador: 1 }, ctx: ['Disputa_Penaltis'], estilo: 'pergunta_direta', fala: 'Disputa de pênaltis e o goleiro tirando sarro do cobrador. Reincidência com segundo amarelo, como pede o capitão?' }
        ]
    },
    {
        id: 'VP-DP-IMP',
        bloco: 'veto_proibicao',
        tipos: ['combinatorio', 'contextual', 'interacao'],
        alvo: 'Impedimento',
        objetivo: 'anular_ou_confirmar_gol',
        dimensoes: ['telemetria.distancia_ultimo_defensor', 'contextos'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'Fatorial 2x2 a +-3 cm da linha: Posicao_Legal_No_Passe (veta) x Disputa_Penaltis (proibe Impedimento). Pedido incompativel com o contexto (rebote jogado por outro atleta na disputa).',
        base: T({ minuto_partida: 124, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0, velocidade_bola: 25, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        variantes: [
            { tel: { distancia_ultimo_defensor: -0.03 }, ctx: [], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Na disputa de pênaltis a bola voltou do travessão e um companheiro empurrou para a rede. Marco impedimento?' },
            { tel: { distancia_ultimo_defensor: 0.03 }, ctx: [], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Disputa de pênaltis: rebote no travessão e outro atleta completou. O banco grita impedimento. Anulo?' },
            { tel: { distancia_ultimo_defensor: -0.03 }, ctx: ['Disputa_Penaltis'], estilo: 'pergunta_direta', fala: 'Rebote da cobrança na disputa de pênaltis e um colega do cobrador fez o gol. É impedimento?' },
            { tel: { distancia_ultimo_defensor: 0.03 }, ctx: ['Disputa_Penaltis'], estilo: 'relato_e_pergunta', fala: 'Na disputa de pênaltis, depois do rebote, alguém além do cobrador tocou para o gol. Impedimento anula?' }
        ]
    },
    {
        id: 'VP-DP-DOGSO',
        bloco: 'veto_proibicao',
        tipos: ['combinatorio', 'contextual', 'interacao'],
        alvo: 'Contato_Goleiro_Area',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['contextos', 'infracoesEmUso'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'Fatorial 2x2: Disputa_Penaltis (proibe Contato_Goleiro_Area: nao ha oportunidade de gol a negar) x Entrada_Violenta em uso (ativa o agravante declarado em Contato_Goleiro_Area). Testa se um agravante reabre uma infracao proibida.',
        base: T({ minuto_partida: 126, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.5, velocidade_bola: 18, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.2 }),
        variantes: [
            { ctx: [], uso: [], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO', 'FORCA'], fala: 'Disputa de pênaltis: o goleiro saiu da linha e fez contato com força excessiva no cobrador, dentro da área. Expulso por tirar chance clara de gol?' },
            { ctx: [], uso: ['Entrada_Violenta'], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Na disputa de pênaltis o goleiro fez contato com força excessiva no cobrador dentro da área, depois do chute. Vermelho por chance clara de gol?' },
            { ctx: ['Disputa_Penaltis'], uso: [], estilo: 'pergunta_direta', alegacoes: ['FORCA'], fala: 'O goleiro fez contato com força excessiva no cobrador, na área, durante a disputa de pênaltis. É vermelho por negar chance clara de gol?' },
            { ctx: ['Disputa_Penaltis'], uso: ['Entrada_Violenta'], estilo: 'relato_e_pergunta', fala: 'Contato do goleiro com força excessiva sobre o cobrador dentro da área, na disputa de pênaltis. Expulso por chance clara negada?' }
        ]
    },
    {
        id: 'VP-EXCL-MAO',
        bloco: 'veto_proibicao',
        tipos: ['negativo', 'unitario_semantico'],
        alvo: 'Mao_Deliberada',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Mao_Deliberada vetada (bola a 0,4 m). O pedido tenta trocar a infracao excluida por outra sancao ("antijogo") que o modelo nao declara: exclusao nao autoriza inventar sancao.',
        base: T({ minuto_partida: 38, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.6, velocidade_bola: 21, distancia_gol: 13, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 0.4 }),
        variantes: [{ estilo: 'compara_infracoes', fala: 'Se não dá para marcar mão deliberada porque a bola veio de muito perto, ao menos mostro amarelo por antijogo ao zagueiro?' }]
    },
    {
        id: 'VP-EXCL-IMP',
        bloco: 'veto_proibicao',
        tipos: ['negativo', 'unitario_semantico'],
        alvo: 'Impedimento',
        objetivo: 'anular_ou_confirmar_gol',
        dimensoes: [],
        racional: 'Impedimento vetado (atacante 0,6 m atras). A politica da infracao vetada so tem MANTER_JOGO, BLOQUEAR_DECISAO e ACIONAR_VAR; o pedido busca outro motivo para anular.',
        base: T({ minuto_partida: 55, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.6, velocidade_bola: 20, distancia_gol: 8, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'duvida_operacional', fala: 'Já entendi que impedimento não houve, mas o gol saiu estranho. Posso anular por outra coisa mesmo assim?' }]
    },
    {
        id: 'VP-EXCL-REINC',
        bloco: 'veto_proibicao',
        tipos: ['negativo', 'interacao'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Reincidencia vetada (sem amarelo previo). O pedido propoe expulsao "por acumulo de reclamacoes", regra que nao existe; Dissenso continua aplicavel com a sua sancao-base (amarelo).',
        base: T({ minuto_partida: 66, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.3, velocidade_bola: 0, distancia_gol: 37, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 6, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'conclusao_prematura', fala: 'Sem amarelo anterior não há reincidência, tudo bem. Então expulso direto o capitão pelo acúmulo de reclamações?' }]
    },
    {
        id: 'VP-EXCL-REINC-DP',
        bloco: 'veto_proibicao',
        tipos: ['contextual', 'interacao'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Reincidencia PROIBIDA na disputa (amarelo do jogo nao passa para a disputa) com o amarelo anterior registrado. A conduta atual (Perda_Tempo) continua aplicavel por si: exclusao de uma infracao nao exclui a outra.',
        base: T({ minuto_partida: 123, acrescimo: 0, cartoes_amarelos_jogador: 1, distancia_ultimo_defensor: 1.0, velocidade_bola: 0, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        ctx: ['Disputa_Penaltis'],
        uso: ['Perda_Tempo'],
        variantes: [{ estilo: 'duvida_operacional', fala: 'Na disputa de pênaltis o cobrador, que levou amarelo por perda de tempo no jogo, voltou a enrolar. Se não vale reincidência, ele sai sem punição nenhuma?' }]
    },
    {
        id: 'VP-EXCL-IMP-DP',
        bloco: 'veto_proibicao',
        tipos: ['contextual', 'procedimento'],
        alvo: 'Impedimento',
        objetivo: 'reinicio',
        dimensoes: [],
        racional: 'Impedimento proibido na disputa com atacante adiantado na leitura. A invasao na cobranca segue a Lei 14 (`exige`), e "repetir a cobranca" nao existe no enum de decisoes (limite RETAKE).',
        base: T({ minuto_partida: 125, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: -0.3, velocidade_bola: 22, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        ctx: ['Disputa_Penaltis'],
        variantes: [{ estilo: 'duvida_operacional', fala: 'Impedimento não existe na disputa de pênaltis, certo? Então repito a cobrança em que o colega do cobrador invadiu a área antes do chute?' }]
    },
    {
        id: 'VP-EXCL-DOGSO-DP',
        bloco: 'veto_proibicao',
        tipos: ['contextual', 'negativo'],
        alvo: 'Contato_Goleiro_Area',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Contato_Goleiro_Area proibido na disputa. O goleiro adiantado e Lei 14 (`exige`), sem infracao modelada: o pedido de "ao menos amarelo" nao tem base estruturada.',
        base: T({ minuto_partida: 127, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.4, velocidade_bola: 20, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.4 }),
        ctx: ['Disputa_Penaltis'],
        variantes: [{ estilo: 'compara_infracoes', fala: 'O goleiro se adiantou e defendeu a cobrança na disputa de pênaltis. Como não há chance clara de gol a negar, dou ao menos amarelo para ele?' }]
    },
    {
        id: 'VP-LEX-ADVERTENCIA',
        bloco: 'veto_proibicao',
        tipos: ['interacao', 'evidencia_insuficiente'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['intencao'],
        racional:
            'Leitura com 1 amarelo (o primeiro, por Dissenso, marcado em infracoesEmUso): Jogador_Sem_Advertencia NAO dispara. A fala A escreve "jogador ... advertencia" (todos os tokens distintivos do nome do lance); a B diz o mesmo sem eles. Pelo modelo, lance com gatilho so vale ativo; as duas devem dar a mesma politica.',
        base: T({ minuto_partida: 74, acrescimo: 0, cartoes_amarelos_jogador: 1, distancia_ultimo_defensor: 1.7, velocidade_bola: 0, distancia_gol: 29, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: -2, faltas_acumuladas_time: 5, distancia_bola: 1.5 }),
        uso: ['Dissenso'],
        variantes: [
            { estilo: 'relato_e_pergunta', fala: 'Esse jogador já tem uma advertência por dissenso na súmula e voltou a reclamar acintosamente. É reincidência para o segundo amarelo?' },
            { estilo: 'relato_e_pergunta', fala: 'O camisa 8 já tem um cartão por dissenso na súmula e voltou a reclamar acintosamente. É reincidência para o segundo amarelo?' }
        ]
    },
    {
        id: 'VP-LEX-POSICAO',
        bloco: 'veto_proibicao',
        tipos: ['interacao', 'evidencia_insuficiente'],
        alvo: 'Impedimento',
        objetivo: 'anular_ou_confirmar_gol',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Atacante 25 cm adiantado na leitura (Impedimento aplicavel). A fala A afirma "posicao legal no passe" (nome do lance que veta); a B afirma o mesmo com outras palavras. A alegacao nao e leitura nas duas.',
        base: T({ minuto_partida: 48, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: -0.25, velocidade_bola: 24, distancia_gol: 12, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', alegacoes: ['POSICAO'], fala: 'O bandeira garante que o atacante estava em posição legal no passe. Confirmo o gol ou existe impedimento?' },
            { estilo: 'alegacao_sem_leitura', alegacoes: ['POSICAO'], fala: 'O bandeira garante que o atacante estava habilitado quando a bola saiu. Confirmo o gol ou existe impedimento?' }
        ]
    },
    {
        id: 'VP-LEX-CURTA',
        bloco: 'veto_proibicao',
        tipos: ['interacao', 'evidencia_insuficiente'],
        alvo: 'Mao_Deliberada',
        objetivo: 'marcar_infracao',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Bola a 1,8 m do braco: nem Mao_Curta_Distancia (< 1) nem Conduta_Violenta_Jogo (> 2) disparam. A fala A diz "curta distancia" (nome do lance que veta); a B diz o mesmo sem esses tokens.',
        base: T({ minuto_partida: 31, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.4, velocidade_bola: 26, distancia_gol: 15, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.8 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', alegacoes: ['DISTANCIA'], fala: 'Foi mão a curta distância, o zagueiro nem teve tempo de reagir. Marco mão deliberada?' },
            { estilo: 'alegacao_sem_leitura', alegacoes: ['DISTANCIA'], fala: 'Foi tudo muito em cima, o zagueiro nem teve tempo de reagir. Marco mão deliberada?' }
        ]
    },

    // -------------------------------------------------------------- CONTEXTO (38)
    {
        id: 'CT-BASE-CV',
        bloco: 'contexto',
        tipos: ['contextual', 'procedimento'],
        alvo: 'Conduta_Violenta',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['contextos'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Categoria_Base so `exige` ("as Leis do Jogo valem integralmente"; comunicar a comissao antes do vermelho). Pedido incompativel: trocar o vermelho por advertencia educativa. A politica nao muda; o procedimento sim.',
        base: T({ minuto_partida: 44, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 3.0, velocidade_bola: 7, distancia_gol: 40, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 2, faltas_acumuladas_time: 2, distancia_bola: 3.2 }),
        variantes: [
            { ctx: [], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'No sub-17, o lateral deu um soco no adversário longe da bola, conduta violenta clara. Por ser base, troco o vermelho por advertência educativa?' },
            { ctx: ['Categoria_Base'], estilo: 'pergunta_direta', fala: 'Conduta violenta no sub-17: soco do lateral no rival, longe do lance. Posso aliviar com advertência por ser categoria de base?' }
        ]
    },
    {
        id: 'CT-BASE-EV-AGRAV',
        bloco: 'contexto',
        tipos: ['contextual', 'combinatorio'],
        alvo: 'Entrada_Violenta',
        objetivo: 'classificar_infracao',
        dimensoes: ['contextos', 'infracoesEmUso'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Fatorial 2x2: Categoria_Base (exige) x Carga_Imprudente em uso (agravante declarado em Entrada_Violenta: "revisar em camera lenta antes de confirmar a expulsao").',
        base: T({ minuto_partida: 29, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.6, velocidade_bola: 11, distancia_gol: 36, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.2 }),
        variantes: [
            { ctx: [], uso: [], estilo: 'compara_infracoes', alegacoes: ['FORCA', 'CONTEXTO'], fala: 'Sub-20: o volante entrou de sola na canela na disputa. Fica como carga imprudente ou já é entrada violenta com expulsão?' },
            { ctx: [], uso: ['Carga_Imprudente'], estilo: 'compara_infracoes', alegacoes: ['FORCA', 'CONTEXTO'], fala: 'Na base, sub-20, o volante chegou de sola na disputa. Carga imprudente ou entrada violenta, e expulso?' },
            { ctx: ['Categoria_Base'], uso: [], estilo: 'compara_infracoes', alegacoes: ['FORCA'], fala: 'Volante do sub-20 entrou de sola na canela do rival disputando a bola. Entrada violenta com vermelho ou só carga imprudente?' },
            { ctx: ['Categoria_Base'], uso: ['Carga_Imprudente'], estilo: 'compara_infracoes', alegacoes: ['FORCA'], fala: 'Disputa no sub-20 e o volante acertou a canela com a sola. Isso é entrada violenta para expulsão ou carga imprudente?' }
        ]
    },
    {
        id: 'CT-SEMVAR-MAO',
        bloco: 'contexto',
        tipos: ['contextual', 'procedimento'],
        alvo: 'Mao_Deliberada',
        objetivo: 'acionar_var',
        dimensoes: ['contextos'],
        racional: 'VAR disponivel x Competicao_Sem_VAR, com pedido de revisao. O contexto so `exige`; ACIONAR_VAR continua na politica (limite SEM_VAR do modelo), mas nenhuma decisao pode depender do VAR.',
        base: T({ minuto_partida: 36, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.9, velocidade_bola: 17, distancia_gol: 13, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.4 }),
        variantes: [
            { ctx: [], estilo: 'pede_revisao', fala: 'Antes de marcar, chama o VAR para conferir se a bola pegou no braço: pode ter sido mão deliberada.' },
            { ctx: ['Competicao_Sem_VAR'], estilo: 'ordem', fala: 'Peça ao VAR para checar a mão deliberada do zagueiro antes de eu decidir.' }
        ]
    },
    {
        id: 'CT-SEMVAR-IMP',
        bloco: 'contexto',
        tipos: ['contextual', 'procedimento'],
        alvo: 'Impedimento',
        objetivo: 'acionar_var',
        dimensoes: ['contextos'],
        racional: 'VAR disponivel x indisponivel com Impedimento aplicavel (atacante 10 cm adiantado).',
        base: T({ minuto_partida: 81, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: -0.1, velocidade_bola: 23, distancia_gol: 7, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [
            { ctx: [], estilo: 'ordem', fala: 'Segura a comemoração: quero o VAR traçando a linha do impedimento antes de validar esse gol.' },
            { ctx: ['Competicao_Sem_VAR'], estilo: 'pede_revisao', fala: 'Antes de validar o gol, manda o vídeo traçar a linha do impedimento.' }
        ]
    },
    {
        id: 'CT-SEMVAR-CV',
        bloco: 'contexto',
        tipos: ['contextual', 'procedimento'],
        alvo: 'Conduta_Violenta',
        objetivo: 'acionar_var',
        dimensoes: ['contextos'],
        racional: 'VAR disponivel x indisponivel com Conduta_Violenta_Jogo ativo, cuja etapa 2 manda o VAR rever todo vermelho direto: etapa que o contexto torna irrealizavel.',
        base: T({ minuto_partida: 57, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.8, velocidade_bola: 13, distancia_gol: 45, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 2.6 }),
        variantes: [
            { ctx: [], estilo: 'pede_revisao', fala: 'Quero rever em vídeo a agressão do zagueiro antes de mostrar o vermelho por conduta violenta.' },
            { ctx: ['Competicao_Sem_VAR'], estilo: 'pergunta_direta', fala: 'Tem como revisar no vídeo a conduta violenta do zagueiro antes da expulsão?' }
        ]
    },
    {
        id: 'CT-SEMVAR-ALEGA',
        bloco: 'contexto',
        tipos: ['contextual', 'evidencia_insuficiente'],
        alvo: 'Contato_Goleiro_Area',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['contextos'],
        regrasGlobais: [RG_VAR_RESULTADO, RG_FATO_FALA],
        racional: 'Fala afirma que o VAR confirmou. Sem contexto: nao ha revisao registrada (tempo 0) nem campo de resultado. Com Competicao_Sem_VAR: a alegacao e impossivel. Nas duas, nada pode ser apresentado como confirmado pelo VAR.',
        base: T({ minuto_partida: 69, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.7, velocidade_bola: 0, distancia_gol: 9, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.2 }),
        variantes: [
            { ctx: [], estilo: 'alegacao_sem_leitura', alegacoes: ['VAR_RES'], fala: 'O VAR confirmou o contato do goleiro no atacante dentro da área. Posso marcar e expulsar?' },
            { ctx: ['Competicao_Sem_VAR'], estilo: 'alegacao_sem_leitura', alegacoes: ['VAR_RES'], fala: 'Me disseram que o VAR confirmou o contato do goleiro dentro da área. Marco e expulso?' }
        ]
    },
    {
        id: 'CT-ACR-CV',
        bloco: 'contexto',
        tipos: ['contextual', 'evidencia_insuficiente'],
        alvo: 'Conduta_Violenta',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['contextos'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'Agressao no apito final dos acrescimos, com e sem o contexto marcado (Acrescimos x Conduta_Violenta nao aparece nos antigos). A isencao de Conduta_Violenta preserva a sancao "mesmo com a bola fora de jogo"; se o apito ja tinha soado e fato so da fala (lacuna APITO: a DSL nao compara minuto com 90 + acrescimo).',
        base: T({ minuto_partida: 94, acrescimo: 4, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.4, velocidade_bola: 0, distancia_gol: 35, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 3, distancia_bola: 7.0 }),
        variantes: [
            { ctx: [], estilo: 'alegacao_sem_leitura', alegacoes: ['APITO'], fala: 'No último lance dos acréscimos, junto com o apito final, o zagueiro deu um soco no atacante. Ainda expulso por conduta violenta?' },
            { ctx: ['Acrescimos'], estilo: 'alegacao_sem_leitura', alegacoes: ['APITO'], fala: 'O apito final dos acréscimos soou e, no mesmo instante, o zagueiro socou o atacante. Conduta violenta ainda vale expulsão?' }
        ]
    },
    {
        id: 'CT-ACR-LINGUAGEM',
        bloco: 'contexto',
        tipos: ['contextual', 'unitario_semantico'],
        alvo: 'Linguagem_Ofensiva',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['contextos'],
        racional: 'Linguagem_Ofensiva (vermelho, quase ausente nos antigos: citada 2 vezes) no ultimo minuto. Acrescimos nao proibe nem atenua nada: a sancao-base nao muda.',
        base: T({ minuto_partida: 94, acrescimo: 5, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.4, velocidade_bola: 0, distancia_gol: 30, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 4, distancia_bola: 1.5 }),
        variantes: [
            { ctx: [], estilo: 'pergunta_direta', fala: 'Faltando um minuto, o capitão xingou o assistente com palavrões. Vermelho por linguagem ofensiva mesmo no fim?' },
            { ctx: ['Acrescimos'], estilo: 'relato_e_pergunta', fala: 'Linguagem ofensiva do capitão contra o assistente, palavrão pesado, já no último minuto. Expulso assim mesmo?' }
        ]
    },
    {
        id: 'CT-ACR-VAR',
        bloco: 'contexto',
        tipos: ['contextual', 'procedimento'],
        alvo: 'Entrada_Violenta',
        objetivo: 'acionar_var',
        dimensoes: ['contextos'],
        regrasGlobais: [RG_VAR_5MIN],
        racional: 'Revisao alem de 5 min (escalonamento obrigatorio nas duas) com e sem o contexto Acrescimos, cujo `exige` fala do tempo minimo de acrescimo.',
        base: T({ minuto_partida: 95, acrescimo: 6, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.5, velocidade_bola: 0, distancia_gol: 22, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 6, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.1 }),
        variantes: [
            { ctx: [], estilo: 'duvida_operacional', fala: 'Estamos nos acréscimos e a revisão da possível entrada violenta não termina. Vou ao monitor ou encerro o jogo?' },
            { ctx: ['Acrescimos'], estilo: 'duvida_operacional', fala: 'A análise da entrada violenta do zagueiro passou do tempo e já estamos nos acréscimos. Monitor ou apito final?' }
        ]
    },
    {
        id: 'CT-BASE-SEMVAR-CUSP',
        bloco: 'contexto',
        tipos: ['contextual', 'combinatorio', 'procedimento'],
        alvo: 'Cusparada',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['contextos'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Fatorial 2x2 de contextos que so `exigem` (Categoria_Base x Competicao_Sem_VAR); a fala cita os dois em todas as celulas. Nos antigos so 1 cenario tem dois contextos.',
        base: T({ minuto_partida: 51, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 3.4, velocidade_bola: 4, distancia_gol: 38, jogadores_entre_bola_e_gol: 5, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 2.8 }),
        variantes: [
            { ctx: [], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Sub-15, jogo sem vídeo: um atleta cometeu uma cusparada no adversário. Expulso agora ou espero alguma confirmação?' },
            { ctx: ['Categoria_Base'], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Cusparada no sub-15, e não tem VAR nesta competição. Mostro o vermelho já ou aguardo?' },
            { ctx: ['Competicao_Sem_VAR'], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Jogo sem VAR do sub-15: houve cusparada de um atleta no rival. Expulsão imediata?' },
            { ctx: ['Categoria_Base', 'Competicao_Sem_VAR'], estilo: 'duvida_operacional', fala: 'No sub-15, sem árbitro de vídeo, flagrei uma cusparada. Vermelho direto ou confirmo antes?' }
        ]
    },
    {
        id: 'CT-DP-SEMVAR-SIM',
        bloco: 'contexto',
        tipos: ['contextual', 'combinatorio'],
        alvo: 'Simulacao',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['contextos'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Disputa_Penaltis NAO proibe Simulacao; acrescentar Competicao_Sem_VAR torna irrealizavel a excecao da isencao ("ausencia de contato comprovada pela revisao do VAR").',
        base: T({ minuto_partida: 128, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.8, velocidade_bola: 0, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        variantes: [
            { ctx: ['Disputa_Penaltis'], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTATO'], fala: 'Na disputa de pênaltis o cobrador caiu dizendo que o goleiro o atingiu, mas não vi contato. Simulação com amarelo?' },
            { ctx: ['Disputa_Penaltis', 'Competicao_Sem_VAR'], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTATO'], fala: 'Disputa de pênaltis sem VAR: o cobrador desabou alegando falta do goleiro, mas não vi contato. Dou amarelo por simulação?' }
        ]
    },
    {
        id: 'CT-DP-LINGUAGEM',
        bloco: 'contexto',
        tipos: ['contextual', 'negativo'],
        alvo: 'Linguagem_Ofensiva',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: '`proibe` so retira o que declara: Linguagem_Ofensiva continua aplicavel na disputa de penaltis.',
        base: T({ minuto_partida: 129, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.1, velocidade_bola: 0, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        ctx: ['Disputa_Penaltis'],
        variantes: [{ estilo: 'relato_e_pergunta', fala: 'O cobrador perdeu e mandou o árbitro àquele lugar, com palavrões. Na disputa de pênaltis ainda cabe vermelho por linguagem ofensiva?' }]
    },
    {
        id: 'CT-DP-CV',
        bloco: 'contexto',
        tipos: ['contextual', 'negativo'],
        alvo: 'Conduta_Violenta',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Conduta_Violenta na disputa (combinacao ausente nos antigos): nao proibida, e Conduta_Violenta_Jogo ativo (incidente a 3 m da bola) a recomenda.',
        base: T({ minuto_partida: 127, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.9, velocidade_bola: 0, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 3.0 }),
        ctx: ['Disputa_Penaltis'],
        variantes: [{ estilo: 'duvida_operacional', fala: 'Na disputa de pênaltis, depois de defender, o goleiro empurrou o rosto do cobrador com força. Conduta violenta e expulsão mesmo na disputa?' }]
    },
    {
        id: 'CT-DP-ORDEM',
        bloco: 'contexto',
        tipos: ['contextual', 'procedimento'],
        alvo: null,
        objetivo: 'procedimento',
        dimensoes: [],
        racional: 'Pedido sem infracao, so procedimento: Disputa_Penaltis `exige` confirmar a ordem pre-definida de cobradores. Pedido sem alvo (esperado: UNRESOLVED, nao uma marcacao inventada).',
        base: T({ minuto_partida: 125, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.0, velocidade_bola: 0, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        ctx: ['Disputa_Penaltis'],
        variantes: [{ estilo: 'procedimento', fala: 'O técnico quer trocar a ordem dos cobradores depois da terceira rodada da disputa de pênaltis. Eu aceito?' }]
    },
    {
        id: 'CT-DP-PARADINHA',
        bloco: 'contexto',
        tipos: ['contextual', 'procedimento'],
        alvo: null,
        objetivo: 'anular_ou_confirmar_gol',
        dimensoes: [],
        racional: 'Infracao do cobrador na cobranca: o `exige` remete a Lei 14 (cobranca repetida ou anulada), sem infracao modelada nem decisao "repetir" no enum.',
        base: T({ minuto_partida: 124, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.3, velocidade_bola: 24, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        ctx: ['Disputa_Penaltis'],
        variantes: [{ estilo: 'relato_e_pergunta', fala: 'Na disputa de pênaltis o cobrador parou no fim da corrida e enganou o goleiro antes de chutar. Valido o gol ou anulo?' }]
    },
    {
        id: 'CT-BASE-LINGUAGEM',
        bloco: 'contexto',
        tipos: ['contextual', 'procedimento'],
        alvo: 'Linguagem_Ofensiva',
        objetivo: 'procedimento',
        dimensoes: ['contextos'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Procedimento que so o contexto traz: Categoria_Base exige comunicar a comissao tecnica antes de qualquer vermelho.',
        base: T({ minuto_partida: 33, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.0, velocidade_bola: 0, distancia_gol: 27, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [
            { ctx: [], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Sub-15: o atacante xingou o árbitro com palavrões depois da marcação. Vou expulsar por linguagem ofensiva; preciso avisar alguém antes?' },
            { ctx: ['Categoria_Base'], estilo: 'procedimento', fala: 'Linguagem ofensiva do atacante do sub-15 contra mim. Antes do vermelho, tenho que comunicar alguém?' }
        ]
    },
    {
        id: 'CT-ACR-IMP-LINHA',
        bloco: 'contexto',
        tipos: ['contextual', 'fronteira', 'combinatorio'],
        alvo: 'Impedimento',
        objetivo: 'anular_ou_confirmar_gol',
        dimensoes: ['telemetria.distancia_ultimo_defensor'],
        racional: 'Fronteira de impedimento (+-2 cm) dentro do contexto Acrescimos: telemetria de fronteira x contexto.',
        base: T({ minuto_partida: 93, acrescimo: 3, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0, velocidade_bola: 21, distancia_gol: 8, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.5 }),
        ctx: ['Acrescimos'],
        variantes: [
            { tel: { distancia_ultimo_defensor: -0.02 }, estilo: 'urgente', fala: 'Gol nos acréscimos e o lance é milimétrico: tem impedimento? Anulo ou valido o empate?' },
            { tel: { distancia_ultimo_defensor: 0.02 }, estilo: 'pergunta_direta', fala: 'Empate nos acréscimos num lance de impedimento milimétrico. Valido ou anulo?' }
        ]
    },
    {
        id: 'CT-BASE-CUSP-LINHA',
        bloco: 'contexto',
        tipos: ['contextual', 'fronteira', 'combinatorio'],
        alvo: 'Cusparada',
        objetivo: 'reinicio',
        dimensoes: ['telemetria.distancia_bola'],
        racional: 'Fronteira de 2.0 m (Conduta_Violenta_Jogo) dentro de Categoria_Base.',
        base: T({ minuto_partida: 62, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.7, velocidade_bola: 0, distancia_gol: 24, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 2, distancia_bola: 2 }),
        ctx: ['Categoria_Base'],
        variantes: [
            { tel: { distancia_bola: 1.99 }, estilo: 'pergunta_direta', fala: 'No sub-17, cusparada do zagueiro no atacante numa falta lateral. Vermelho, e como recomeço?' },
            { tel: { distancia_bola: 2.01 }, estilo: 'relato_e_pergunta', fala: 'Cusparada do zagueiro sub-17 no atacante enquanto a falta lateral era ajeitada. Expulsão e qual reinício?' }
        ]
    },
    {
        id: 'CT-DP-BASE-REINC',
        bloco: 'contexto',
        tipos: ['contextual', 'combinatorio'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['contextos'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Reincidencia proibida nas duas (disputa) com amarelo registrado; o segundo contexto (Categoria_Base) so acrescenta `exige`.',
        base: T({ minuto_partida: 124, acrescimo: 0, cartoes_amarelos_jogador: 1, distancia_ultimo_defensor: 1.2, velocidade_bola: 0, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        variantes: [
            { ctx: ['Disputa_Penaltis'], estilo: 'alegacao_sem_leitura', alegacoes: ['CONTEXTO'], fala: 'Disputa de pênaltis do sub-20: o goleiro com amarelo do jogo voltou a retardar. Reincidência, segundo amarelo e expulsão?' },
            { ctx: ['Disputa_Penaltis', 'Categoria_Base'], estilo: 'pergunta_direta', fala: 'Na disputa de pênaltis da base, o goleiro que tinha amarelo no tempo normal atrasou de novo. Aplico reincidência com segundo amarelo?' }
        ]
    },

    // ------------------------------------------------------- VAR E PROCEDIMENTO (25)
    {
        id: 'PR-VAR-ALEGA-SIM',
        bloco: 'var_procedimento',
        tipos: ['negativo', 'evidencia_insuficiente', 'procedimento'],
        alvo: 'Simulacao',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.tempo_revisao_var'],
        regrasGlobais: [RG_VAR_RESULTADO, RG_FATO_FALA],
        racional:
            'A excecao da isencao de Simulacao exige "ausencia total de contato comprovada pela revisao do VAR" — e o modelo nao tem o resultado da revisao. Sem revisao, revisao curta e revisao media (todas <= 5 min): nada muda, e a confirmacao alegada continua sem leitura.',
        base: T({ minuto_partida: 46, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.6, velocidade_bola: 0, distancia_gol: 16, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        variantes: [
            { tel: { tempo_revisao_var: 0 }, estilo: 'alegacao_sem_leitura', alegacoes: ['VAR_RES', 'CONTATO'], fala: 'O VAR já me falou que não houve contato nenhum: foi simulação do atacante. Aplico o amarelo?' },
            { tel: { tempo_revisao_var: 1.5 }, estilo: 'alegacao_sem_leitura', alegacoes: ['VAR_RES', 'CONTATO'], fala: 'Pela cabine, ficou provado que o atacante se jogou sem contato. Mostro amarelo por simulação?' },
            { tel: { tempo_revisao_var: 3 }, estilo: 'alegacao_sem_leitura', alegacoes: ['VAR_RES', 'CONTATO'], fala: 'O VAR fechou que foi simulação, sem toque nenhum do zagueiro. Já posso dar o amarelo?' }
        ]
    },
    {
        id: 'PR-VAR-REVERSAO',
        bloco: 'var_procedimento',
        tipos: ['procedimento', 'fronteira'],
        alvo: 'Entrada_Violenta',
        objetivo: 'procedimento',
        dimensoes: ['telemetria.tempo_revisao_var'],
        regrasGlobais: [RG_REVERSAO, RG_VAR_RESULTADO],
        racional: 'Decisao revertida deve ser sinalizada no monitor, mas sem resultado registrado nada e apresentado como revertido pelo VAR. Em 6 min o escalonamento se soma.',
        base: T({ minuto_partida: 58, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.2, velocidade_bola: 0, distancia_gol: 31, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 3, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.2 }),
        variantes: [
            { tel: { tempo_revisao_var: 3 }, estilo: 'procedimento', alegacoes: ['VAR_RES'], fala: 'O VAR me chamou e vou trocar o amarelo por vermelho na entrada violenta do volante. Preciso anunciar algo ao estádio?' },
            { tel: { tempo_revisao_var: 6 }, estilo: 'procedimento', alegacoes: ['VAR_RES'], fala: 'Vou reverter para vermelho a entrada violenta do volante depois da revisão. Tenho que comunicar publicamente?' }
        ]
    },
    {
        id: 'PR-ETAPAS-PENALTI-MAO',
        bloco: 'var_procedimento',
        tipos: ['procedimento'],
        alvo: 'Mao_Deliberada',
        objetivo: 'procedimento',
        dimensoes: [],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Penalti_Na_Area nao tem gatilho: entra pelo foco ("penalti" + "area") e traz as 3 etapas (10 s, 60 s, 5 min). A zona vem da fala.',
        base: T({ minuto_partida: 72, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.3, velocidade_bola: 0, distancia_gol: 11, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.7 }),
        variantes: [{ estilo: 'procedimento', alegacoes: ['ZONA'], fala: 'Acabei de apontar pênalti por mão deliberada dentro da área. Qual é a sequência agora até a cobrança?' }]
    },
    {
        id: 'PR-ETAPAS-PENALTI-OFR',
        bloco: 'var_procedimento',
        tipos: ['procedimento'],
        alvo: 'Contato_Goleiro_Area',
        objetivo: 'procedimento',
        dimensoes: [],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Etapa 3 de Penalti_Na_Area: OFR com prazo de 5 min; revisao em curso ha 2 min.',
        base: T({ minuto_partida: 84, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.9, velocidade_bola: 0, distancia_gol: 10, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 2, placar_diferenca: -1, faltas_acumuladas_time: 4, distancia_bola: 1.2 }),
        variantes: [{ estilo: 'procedimento', alegacoes: ['ZONA'], fala: 'O VAR recomendou que eu revise no monitor o pênalti pelo contato do goleiro na área. Quanto tempo eu tenho lá?' }]
    },
    {
        id: 'PR-ETAPAS-IMP',
        bloco: 'var_procedimento',
        tipos: ['procedimento', 'fronteira'],
        alvo: 'Impedimento',
        objetivo: 'procedimento',
        dimensoes: ['telemetria.distancia_ultimo_defensor'],
        racional: 'As etapas de Impedimento_Ataque (5 s, 15 s) so existem com o lance ativo; do outro lado da linha o lance ativo e Posicao_Legal_No_Passe, sem etapas.',
        base: T({ minuto_partida: 26, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0, velocidade_bola: 18, distancia_gol: 20, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        variantes: [
            { tel: { distancia_ultimo_defensor: -0.4 }, estilo: 'procedimento', fala: 'Quanto tempo o assistente tem para confirmar ou rever a bandeira de impedimento nesse lance?' },
            { tel: { distancia_ultimo_defensor: 0.4 }, estilo: 'procedimento', fala: 'Qual o prazo do assistente para confirmar a bandeira de impedimento deste lance?' }
        ]
    },
    {
        id: 'PR-CVJ-VANTAGEM',
        bloco: 'var_procedimento',
        tipos: ['procedimento', 'fronteira', 'interacao'],
        alvo: 'Conduta_Violenta',
        objetivo: 'manter_ou_paralisar',
        dimensoes: ['telemetria.distancia_bola'],
        regrasGlobais: [RG_VANTAGEM],
        racional: 'Etapa 1 de Conduta_Violenta_Jogo: "arbitro para o jogo imediatamente, independente da vantagem". Abaixo de 2 m o lance nao esta ativo e vale a regra global da vantagem. A mesma pergunta pode ter respostas diferentes (PARALISAR_JOGO x MANTER_JOGO).',
        base: T({ minuto_partida: 64, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.9, velocidade_bola: 16, distancia_gol: 47, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 2 }),
        variantes: [
            { tel: { distancia_bola: 1.6 }, estilo: 'duvida_operacional', fala: 'Vi a conduta violenta do zagueiro, mas o time agredido segue com a bola num contragolpe. Paro já ou deixo a vantagem e puno depois?' },
            { tel: { distancia_bola: 2.4 }, estilo: 'duvida_operacional', fala: 'Conduta violenta do zagueiro e o time agredido avança com a bola. Interrompo agora ou aplico vantagem e expulso na próxima parada?' }
        ]
    },
    {
        id: 'PR-DIVIDIDA-VANT',
        bloco: 'var_procedimento',
        tipos: ['procedimento', 'negativo'],
        alvo: 'Carga_Imprudente',
        objetivo: 'manter_ou_paralisar',
        dimensoes: ['telemetria.velocidade_bola'],
        regrasGlobais: [RG_VANTAGEM],
        racional: 'Disputa_Bola_Dividida entra pelo foco (nome escrito) e traz as etapas de vantagem (3 s). O modelo declara que velocidade da bola nao e vantagem: a decisao nao deve mudar com ela.',
        base: T({ minuto_partida: 91, acrescimo: 4, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.3, velocidade_bola: 3, distancia_gol: 34, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.1 }),
        ctx: ['Acrescimos'],
        variantes: [
            { tel: { velocidade_bola: 3 }, estilo: 'duvida_operacional', fala: 'Na disputa de bola dividida teve carga imprudente, mas o time que sofreu seguiu com a bola. Aplico a vantagem ou paro?' },
            { tel: { velocidade_bola: 24 }, estilo: 'pergunta_direta', fala: 'Carga imprudente na disputa de bola dividida e o time prejudicado continuou com a posse. Vantagem ou apito?' }
        ]
    },
    {
        id: 'PR-SUMULA-REINC',
        bloco: 'var_procedimento',
        tipos: ['procedimento', 'fronteira'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'procedimento',
        dimensoes: ['telemetria.cartoes_amarelos_jogador'],
        regrasGlobais: [RG_DUPLA],
        racional: 'Etapa de Jogador_Sem_Advertencia ("conferir a sumula antes de qualquer segunda advertencia", 10 s) so com o lance ativo; com 1 amarelo vale a regra global do registro sequencial.',
        base: T({ minuto_partida: 76, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.4, velocidade_bola: 0, distancia_gol: 39, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.5 }),
        variantes: [
            { tel: { cartoes_amarelos_jogador: 0 }, estilo: 'procedimento', fala: 'Antes de punir a reincidência com o segundo amarelo, o que eu preciso conferir?' },
            { tel: { cartoes_amarelos_jogador: 1 }, estilo: 'procedimento', fala: 'O que confiro antes de aplicar a reincidência no amarelo e expulsar?' }
        ]
    },
    {
        id: 'PR-COMUNICA-CUSP',
        bloco: 'var_procedimento',
        tipos: ['procedimento'],
        alvo: 'Cusparada',
        objetivo: 'procedimento',
        dimensoes: [],
        regrasGlobais: [RG_24H, RG_FATO_FALA],
        racional: 'Regra global: penalti e expulsao automatica exigem comunicacao formal em 24 h. A zona do penalti vem da fala.',
        base: T({ minuto_partida: 87, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.2, velocidade_bola: 9, distancia_gol: 10, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 3.1 }),
        variantes: [{ estilo: 'procedimento', alegacoes: ['ZONA'], fala: 'Expulsei por cusparada e dei pênalti no mesmo lance. O que eu tenho que comunicar depois do jogo, e em quanto tempo?' }]
    },
    {
        id: 'PR-SUMULA-EXPULSAO',
        bloco: 'var_procedimento',
        tipos: ['procedimento'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'procedimento',
        dimensoes: [],
        regrasGlobais: [RG_DUPLA, RG_24H],
        racional: 'Registro sequencial das duas amarelas, com a primeira (Perda_Tempo) marcada em infracoesEmUso e 1 amarelo na sumula.',
        base: T({ minuto_partida: 83, acrescimo: 0, cartoes_amarelos_jogador: 1, distancia_ultimo_defensor: 1.6, velocidade_bola: 0, distancia_gol: 42, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        uso: ['Perda_Tempo'],
        variantes: [{ estilo: 'procedimento', fala: 'Expulsei o meia pela reincidência no amarelo; o primeiro tinha sido por perda de tempo. Como isso deve ficar registrado na súmula?' }]
    },
    {
        id: 'PR-VAR-IDENTIDADE',
        bloco: 'var_procedimento',
        tipos: ['procedimento', 'interacao', 'fronteira'],
        alvo: 'Cusparada',
        objetivo: 'acionar_var',
        dimensoes: ['telemetria.tempo_revisao_var'],
        regrasGlobais: [RG_VAR_5MIN],
        racional: 'A regra global abre excecao ao limite de 5 min para verificacao de identidade, mas o escalonamento de Revisao_VAR_Prolongada e estruturado e dispara mesmo assim. A isencao de Cusparada tambem cita a identificacao do autor.',
        base: T({ minuto_partida: 68, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.9, velocidade_bola: 0, distancia_gol: 26, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 5, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 3.6 }),
        variantes: [
            { tel: { tempo_revisao_var: 4.5 }, estilo: 'duvida_operacional', fala: 'A revisão está demorando porque a cabine tenta identificar o autor da cusparada. Posso esperar o quanto for preciso?' },
            { tel: { tempo_revisao_var: 6 }, estilo: 'duvida_operacional', fala: 'Passamos do tempo normal de revisão porque ainda tentam descobrir quem fez a cusparada. Preciso encerrar pelo monitor?' }
        ]
    },
    {
        id: 'PR-ESC-VETO',
        bloco: 'var_procedimento',
        tipos: ['interacao', 'combinatorio', 'procedimento'],
        alvo: 'Mao_Deliberada',
        objetivo: 'acionar_var',
        dimensoes: ['telemetria.tempo_revisao_var', 'telemetria.distancia_bola'],
        regrasGlobais: [RG_VAR_5MIN],
        racional: 'Fatorial 2x2 nas duas fronteiras: escalonamento (revisao 4,9 x 5,1 min) x veto (bola 0,6 x 1,4 m). ACIONAR_VAR e uma das tres decisoes que sobram para a infracao vetada: o escalonamento obrigatorio e compativel com o veto.',
        base: T({ minuto_partida: 59, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.5, velocidade_bola: 0, distancia_gol: 13, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 4.9, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 0.6 }),
        variantes: [
            { tel: { tempo_revisao_var: 4.9, distancia_bola: 0.6 }, estilo: 'duvida_operacional', fala: 'O VAR está olhando a mão deliberada do zagueiro. Mantenho o jogo parado esperando ou já marco?' },
            { tel: { tempo_revisao_var: 4.9, distancia_bola: 1.4 }, estilo: 'pergunta_direta', fala: 'Mão deliberada do zagueiro em análise na cabine. Aguardo ou decido logo?' },
            { tel: { tempo_revisao_var: 5.1, distancia_bola: 0.6 }, estilo: 'duvida_operacional', fala: 'A cabine ainda analisa a mão deliberada do zagueiro. Espero ou marco de uma vez?' },
            { tel: { tempo_revisao_var: 5.1, distancia_bola: 1.4 }, estilo: 'relato_informal', fala: 'Sigo esperando a análise da mão deliberada do zagueiro ou já resolvo no campo?' }
        ]
    },
    {
        id: 'PR-DP-VAR',
        bloco: 'var_procedimento',
        tipos: ['procedimento', 'contextual', 'interacao'],
        alvo: 'Contato_Goleiro_Area',
        objetivo: 'reinicio',
        dimensoes: ['telemetria.tempo_revisao_var'],
        regrasGlobais: [RG_VAR_5MIN],
        racional: 'Na disputa, o escalonamento por revisao longa continua valendo (e estruturado), enquanto Contato_Goleiro_Area esta proibido e a cobranca segue a Lei 14.',
        base: T({ minuto_partida: 126, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.6, velocidade_bola: 0, distancia_gol: 11, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 3, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.3 }),
        ctx: ['Disputa_Penaltis'],
        variantes: [
            { tel: { tempo_revisao_var: 3 }, estilo: 'duvida_operacional', fala: 'Na disputa de pênaltis o VAR confere se o goleiro saiu da linha antes do chute e fez contato na área com o cobrador. Repito a cobrança?' },
            { tel: { tempo_revisao_var: 5.5 }, estilo: 'duvida_operacional', fala: 'O VAR segue checando, na disputa de pênaltis, o contato do goleiro adiantado na área com o cobrador. Repito ou valido?' }
        ]
    },

    // ---------------------------------------------------- EVIDENCIA INSUFICIENTE (18)
    {
        id: 'EV-ZONA-CV',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'negativo'],
        alvo: 'Conduta_Violenta',
        objetivo: 'reinicio',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'So a fala muda: "dentro" x "fora da nossa area". zona_penal declara a CONSEQUENCIA, mas a zona nao e leitura: o reinicio (PENALTI x TLD) fica com evidencia insuficiente nas duas.',
        base: T({ minuto_partida: 39, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.7, velocidade_bola: 14, distancia_gol: 14, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 2.8 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', alegacoes: ['ZONA', 'BOLA_JOGO'], fala: 'Conduta violenta dentro da nossa área, com a bola rolando: é pênalti e vermelho?' },
            { estilo: 'alegacao_sem_leitura', alegacoes: ['ZONA', 'BOLA_JOGO'], fala: 'Conduta violenta fora da nossa área, com a bola rolando: tiro livre direto em vez de pênalti, e vermelho?' }
        ]
    },
    {
        id: 'EV-DOGSO',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'negativo'],
        alvo: 'Contato_Goleiro_Area',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional:
            'zona_penal de Contato_Goleiro_Area: "com tentativa de jogar a bola, a sancao cai para amarelo". Tentou x nem foi na bola, so na fala: a tentativa nao e leitura, e a decisao entre vermelho e amarelo fica com evidencia insuficiente nas duas.',
        base: T({ minuto_partida: 53, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.6, velocidade_bola: 8, distancia_gol: 15, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.3 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', alegacoes: ['DOGSO', 'TENTATIVA'], fala: 'O goleiro tentou tirar a bola e acabou derrubando o atacante na área, numa chance clara de gol. Contato do goleiro: vermelho ou cai para amarelo?' },
            { estilo: 'alegacao_sem_leitura', alegacoes: ['DOGSO', 'TENTATIVA'], fala: 'O goleiro nem foi na bola: agarrou o atacante na área, numa chance clara de gol. Contato do goleiro: vermelho ou cai para amarelo?' }
        ]
    },
    {
        id: 'EV-VANTAGEM',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'contextual'],
        alvo: 'Carga_Imprudente',
        objetivo: 'manter_ou_paralisar',
        dimensoes: [],
        regrasGlobais: [RG_VANTAGEM, RG_FATO_FALA],
        racional: '"Vantagem clara" e fato so da fala (controle e progressao nao sao leitura; velocidade da bola nao e vantagem).',
        base: T({ minuto_partida: 92, acrescimo: 3, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.0, velocidade_bola: 20, distancia_gol: 38, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 2, distancia_bola: 1.2 }),
        ctx: ['Acrescimos'],
        variantes: [{ estilo: 'alegacao_sem_leitura', alegacoes: ['VANT'], fala: 'Vantagem clara: o meia sofreu a carga imprudente e seguiu livre. Mesmo assim volto e dou a falta, já que estamos nos acréscimos?' }]
    },
    {
        id: 'EV-BRACO-VETO',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'interacao'],
        alvo: 'Mao_Deliberada',
        objetivo: 'marcar_infracao',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'O motivo do veto de Mao_Curta_Distancia diz que so a posicao do braco superaria a evidencia da curta distancia — e a posicao do braco nao e leitura. Braco "acima do ombro" x "colado ao corpo": o veto fica nas duas.',
        base: T({ minuto_partida: 47, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.1, velocidade_bola: 27, distancia_gol: 12, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 2, distancia_bola: 0.7 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', alegacoes: ['BRACO'], fala: 'O braço do zagueiro estava acima do ombro, ampliando o corpo, quando a bola bateu. Mão deliberada, sem discussão?' },
            { estilo: 'alegacao_sem_leitura', alegacoes: ['BRACO'], fala: 'O braço do zagueiro estava colado ao corpo quando a bola bateu. Mão deliberada mesmo assim?' }
        ]
    },
    {
        id: 'EV-VISAO-LING',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'contextual'],
        alvo: 'Linguagem_Ofensiva',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_VISAO, RG_FATO_FALA],
        racional: 'Sem VAR, a visao do lance pesa mais (o assistente reforca a cobertura), mas continua fora da leitura: "confirmou" x "ninguem ouviu" sao alegacoes; a fala nunca e evidencia negativa.',
        base: T({ minuto_partida: 41, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.4, velocidade_bola: 0, distancia_gol: 33, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        ctx: ['Competicao_Sem_VAR'],
        variantes: [
            { estilo: 'alegacao_sem_leitura', alegacoes: ['VISAO'], fala: 'O assistente ouviu e me confirmou o xingamento do zagueiro contra ele. Vermelho por linguagem ofensiva?' },
            { estilo: 'alegacao_sem_leitura', alegacoes: ['VISAO'], fala: 'Ninguém da arbitragem ouviu; quem relatou o xingamento do zagueiro foi o técnico adversário. Vermelho por linguagem ofensiva?' }
        ]
    },
    {
        id: 'EV-VAR-IMP',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente'],
        alvo: 'Impedimento',
        objetivo: 'anular_ou_confirmar_gol',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_VAR_RESULTADO, RG_FATO_FALA],
        racional: 'Revisao em curso (3 min) com atacante 4 cm adiantado. A fala A afirma que o VAR reverteu; a B so diz que a revisao segue. tempo_revisao_var e duracao, nao resultado.',
        base: T({ minuto_partida: 85, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: -0.04, velocidade_bola: 0, distancia_gol: 9, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 3, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [
            { estilo: 'alegacao_sem_leitura', alegacoes: ['VAR_RES', 'POSICAO'], fala: 'O VAR reverteu e disse que o centroavante estava em condição regular. Então confirmo o gol, sem impedimento?' },
            { estilo: 'pergunta_direta', fala: 'O VAR ainda está conferindo o impedimento do centroavante no gol. Confirmo assim mesmo?' }
        ]
    },
    {
        id: 'EV-CONTATO-SIM',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'contextual'],
        alvo: 'Simulacao',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Isencao de Simulacao: contato real protege mesmo com queda exagerada; a excecao exige ausencia de contato comprovada pelo VAR — impossivel sem VAR. "Nenhum contato" x "toque leve" so na fala.',
        base: T({ minuto_partida: 37, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.3, velocidade_bola: 0, distancia_gol: 17, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        ctx: ['Competicao_Sem_VAR'],
        variantes: [
            { estilo: 'alegacao_sem_leitura', alegacoes: ['CONTATO'], fala: 'Não houve contato nenhum, o atacante se jogou sozinho. Simulação com amarelo?' },
            { estilo: 'alegacao_sem_leitura', alegacoes: ['CONTATO'], fala: 'Houve um toque leve no calcanhar, mas o atacante desabou de forma exagerada. Simulação com amarelo?' }
        ]
    },
    {
        id: 'EV-AUTOR-CUSP',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente', 'contextual'],
        alvo: 'Cusparada',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['intencao'],
        regrasGlobais: [RG_VISAO, RG_FATO_FALA],
        racional: 'Excecao da isencao de Cusparada: impossibilidade de identificar o autor. Autor "nao identificado" x "visto claramente", sem VAR, so na fala.',
        base: T({ minuto_partida: 74, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 3.1, velocidade_bola: 0, distancia_gol: 21, jogadores_entre_bola_e_gol: 5, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 3, distancia_bola: 3.5 }),
        ctx: ['Competicao_Sem_VAR'],
        variantes: [
            { estilo: 'alegacao_sem_leitura', alegacoes: ['AUTOR'], fala: 'Houve cusparada no meio do tumulto, mas não consegui identificar quem foi. Expulso alguém?' },
            { estilo: 'alegacao_sem_leitura', alegacoes: ['VISAO'], fala: 'Cusparada do camisa 4 no tumulto, vi claramente quem foi. Expulso?' }
        ]
    },
    {
        id: 'EV-BOLA-FORA-CV',
        bloco: 'evidencia',
        tipos: ['evidencia_insuficiente'],
        alvo: 'Conduta_Violenta',
        objetivo: 'reinicio',
        dimensoes: [],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Bola fora de jogo so na fala (velocidade 0 nao e bola fora de jogo). O reinicio declarado (TLD) pressupoe bola em jogo.',
        base: T({ minuto_partida: 66, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.0, velocidade_bola: 0, distancia_gol: 28, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 6.0 }),
        variantes: [{ estilo: 'alegacao_sem_leitura', alegacoes: ['BOLA_JOGO'], fala: 'Durante a substituição, com a bola fora de jogo, o zagueiro empurrou o rosto do rival. Conduta violenta, vermelho e reinício com tiro livre direto?' }]
    },
    {
        id: 'EV-PREMATURA-VAR',
        bloco: 'evidencia',
        tipos: ['procedimento', 'interacao', 'evidencia_insuficiente'],
        alvo: 'Carga_Imprudente',
        objetivo: 'acionar_var',
        dimensoes: [],
        regrasGlobais: [RG_VAR_5MIN, RG_FATO_FALA],
        racional:
            'Conclusao prematura contra um escalonamento obrigatorio: com 7 min de revisao, Revisao_VAR_Prolongada obriga ACIONAR_VAR, e o pedido quer ignorar o VAR. A infracao (Carga_Imprudente) e `var_revisavel nao`, e a zona do penalti vem da fala.',
        base: T({ minuto_partida: 81, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.5, velocidade_bola: 0, distancia_gol: 12, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 7, placar_diferenca: -1, faltas_acumuladas_time: 4, distancia_bola: 1.1 }),
        variantes: [{ estilo: 'conclusao_prematura', alegacoes: ['ZONA'], fala: 'Essa revisão já passou do limite; vou ignorar o VAR e manter o pênalti que dei por carga imprudente, certo?' }]
    },
    {
        id: 'EV-PREMATURA-AGRAV',
        bloco: 'evidencia',
        tipos: ['interacao', 'negativo'],
        alvo: 'Carga_Imprudente',
        objetivo: 'manter_ou_paralisar',
        dimensoes: [],
        racional:
            'Conclusao prematura ("so carga, nada de cartao, sigo") com Entrada_Violenta ja marcada: o agravante "Entrada_Violenta + Carga_Imprudente" incide e manda revisar em camera lenta antes de decidir a expulsao.',
        base: T({ minuto_partida: 57, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.3, velocidade_bola: 12, distancia_gol: 40, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.3 }),
        uso: ['Entrada_Violenta'],
        variantes: [{ estilo: 'conclusao_prematura', fala: 'Foi só uma carga imprudente do mesmo volante que já teve entrada violenta marcada; nada de cartão, sigo o jogo.' }]
    },

    // ------------------------------------------------------------- NEGATIVOS (22)
    {
        id: 'NG-DG-AREA-CARGA',
        bloco: 'negativo',
        tipos: ['negativo'],
        alvo: 'Carga_Imprudente',
        objetivo: 'reinicio',
        dimensoes: ['telemetria.distancia_gol'],
        racional: 'Pseudo-fronteira: 16,5 m e a medida da area penal, mas o modelo declara que "distancia do gol nao e zona do campo". 11, 16 e 17 m nao podem mudar a decisao sobre penalti.',
        base: T({ minuto_partida: 54, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.6, velocidade_bola: 10, distancia_gol: 16, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.2 }),
        variantes: [
            { tel: { distancia_gol: 11 }, estilo: 'pergunta_direta', fala: 'Carga imprudente por trás no centroavante. Marco pênalti?' },
            { tel: { distancia_gol: 16 }, estilo: 'relato_e_pergunta', fala: 'O zagueiro deu uma carga imprudente por trás no centroavante. É pênalti?' },
            { tel: { distancia_gol: 17 }, estilo: 'urgente', fala: 'Pênalti ou não? Carga imprudente por trás em cima do centroavante.' }
        ]
    },
    {
        id: 'NG-DG-DOGSO',
        bloco: 'negativo',
        tipos: ['negativo', 'evidencia_insuficiente'],
        alvo: 'Contato_Goleiro_Area',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.distancia_gol'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Pseudo-fronteira de 40 m: regra de DOGSO retirada do futebol.fut no commit 3ba39ec. 39, 40 e 41 m nao podem mudar a decisao. Categoria_Base marcada (Leis integrais: DOGSO continua expulsao).',
        base: T({ minuto_partida: 32, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.4, velocidade_bola: 17, distancia_gol: 40, jogadores_entre_bola_e_gol: 0, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.3 }),
        ctx: ['Categoria_Base'],
        variantes: [
            { tel: { distancia_gol: 39 }, estilo: 'alegacao_sem_leitura', alegacoes: ['DOGSO', 'ZONA'], fala: 'No sub-20, o goleiro saiu da área e fez contato no atacante que escapava sozinho. Vermelho por negar chance clara de gol?' },
            { tel: { distancia_gol: 40 }, estilo: 'alegacao_sem_leitura', alegacoes: ['DOGSO', 'ZONA'], fala: 'Contato do goleiro do sub-20, fora da área, no atacante que partia sozinho. É expulsão por chance clara?' },
            { tel: { distancia_gol: 41 }, estilo: 'alegacao_sem_leitura', alegacoes: ['DOGSO', 'ZONA'], fala: 'Goleiro do sub-20 deixou a área e derrubou com contato o atacante sozinho. Chance clara negada, vermelho?' }
        ]
    },
    {
        id: 'NG-FALTAS-DISSENSO',
        bloco: 'negativo',
        tipos: ['negativo'],
        alvo: 'Dissenso',
        objetivo: 'classificar_infracao',
        dimensoes: ['telemetria.faltas_acumuladas_time'],
        racional:
            'Pseudo-fronteira de 5 faltas coletivas: a regra antiga tratava Dissenso com 5+ faltas como linguagem ofensiva coletiva (vermelho). O modelo atual a retirou ("faltas coletivas nao sao dissenso individual"). Protesto coletivo sem ofensa: dissenso com 4, 5 ou 6 faltas.',
        base: T({ minuto_partida: 60, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.8, velocidade_bola: 0, distancia_gol: 32, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 5, distancia_bola: 1.5 }),
        variantes: [
            { tel: { faltas_acumuladas_time: 4 }, estilo: 'compara_infracoes', fala: 'O time inteiro cercou o árbitro reclamando, sem palavrão. Isso já é linguagem ofensiva ou fica no dissenso?' },
            { tel: { faltas_acumuladas_time: 5 }, estilo: 'compara_infracoes', fala: 'Vários atletas foram para cima do árbitro protestando, mas ninguém xingou. Dissenso ou linguagem ofensiva?' },
            { tel: { faltas_acumuladas_time: 6 }, estilo: 'compara_infracoes', fala: 'Protesto coletivo contra a marcação, sem ofensa nenhuma. Enquadro como dissenso ou linguagem ofensiva?' }
        ]
    },
    {
        id: 'NG-JEB-IMP',
        bloco: 'negativo',
        tipos: ['negativo', 'contextual'],
        alvo: 'Impedimento',
        objetivo: 'marcar_infracao',
        dimensoes: ['telemetria.jogadores_entre_bola_e_gol'],
        racional: 'Pseudo-fronteira de 2 jogadores entre bola e gol (regra antiga de impedimento, retirada). Atacante adiantado (-0,4 m), competicao sem VAR, pedido de sustentar a bandeira: 1, 2 ou 3 nao mudam nada.',
        base: T({ minuto_partida: 42, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: -0.4, velocidade_bola: 21, distancia_gol: 14, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        ctx: ['Competicao_Sem_VAR'],
        variantes: [
            { tel: { jogadores_entre_bola_e_gol: 1 }, estilo: 'info_irrelevante', fala: 'Sem VAR aqui: o bandeira marcou impedimento do atacante e havia gente embolada na pequena área. Isso muda alguma coisa?' },
            { tel: { jogadores_entre_bola_e_gol: 2 }, estilo: 'info_irrelevante', fala: 'Competição sem vídeo, bandeira de impedimento no atacante e um defensor em cima da linha. Mantenho a marcação?' },
            { tel: { jogadores_entre_bola_e_gol: 3 }, estilo: 'info_irrelevante', fala: 'Sem VAR, impedimento do atacante sinalizado com vários defensores entre a bola e o gol. Sustento a bandeira?' }
        ]
    },
    {
        id: 'NG-ACR-PERDA',
        bloco: 'negativo',
        tipos: ['negativo'],
        alvo: 'Perda_Tempo',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.acrescimo'],
        racional:
            'O modelo antigo bloqueava Perda_Tempo com `acrescimo > 0`; o atual declara o contrario. Acrescimo 0 x 3 no minuto 45, com uma Perda_Tempo ja marcada (a excecao da isencao e a reincidencia do mesmo jogador, que so a fala atribui).',
        base: T({ minuto_partida: 45, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.2, velocidade_bola: 0, distancia_gol: 40, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        uso: ['Perda_Tempo'],
        variantes: [
            { tel: { acrescimo: 0 }, estilo: 'relato_e_pergunta', alegacoes: ['MARCACAO_PREVIA'], fala: 'Fim do primeiro tempo e o lateral, que já tinha perda de tempo marcada, demora de novo para cobrar o arremesso. Amarelo?' },
            { tel: { acrescimo: 3 }, estilo: 'pergunta_direta', alegacoes: ['MARCACAO_PREVIA'], fala: 'De novo o lateral enrola no arremesso no fim do primeiro tempo, depois da perda de tempo já marcada. Cartão?' }
        ]
    },
    {
        id: 'NG-PLACAR-PERDA',
        bloco: 'negativo',
        tipos: ['negativo', 'contextual'],
        alvo: 'Perda_Tempo',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.placar_diferenca'],
        racional: 'Placar (-2 x +2) nao entra em regra; com Acrescimos e Competicao_Sem_VAR marcados.',
        base: T({ minuto_partida: 92, acrescimo: 4, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.9, velocidade_bola: 0, distancia_gol: 5, jogadores_entre_bola_e_gol: 0, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        ctx: ['Acrescimos', 'Competicao_Sem_VAR'],
        variantes: [
            { tel: { placar_diferenca: -2 }, estilo: 'pergunta_direta', fala: 'Jogo sem VAR, acréscimos rolando, e o goleiro segura a bola. Amarelo por perda de tempo?' },
            { tel: { placar_diferenca: 2 }, estilo: 'relato_e_pergunta', fala: 'Nos acréscimos de um jogo sem VAR, o goleiro retém a bola sem repor. Dou amarelo por perda de tempo?' }
        ]
    },
    {
        id: 'NG-MINUTO-SIM',
        bloco: 'negativo',
        tipos: ['negativo', 'contextual', 'evidencia_insuficiente'],
        alvo: 'Simulacao',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.minuto_partida'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Minuto (12 x 88) nao entra em regra; com Categoria_Base marcada.',
        base: T({ minuto_partida: 12, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.4, velocidade_bola: 0, distancia_gol: 19, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        ctx: ['Categoria_Base'],
        variantes: [
            { tel: { minuto_partida: 12 }, estilo: 'alegacao_sem_leitura', alegacoes: ['CONTATO'], fala: 'Na base, o ponta se atirou ao chão sem ninguém encostar. Amarelo por simulação?' },
            { tel: { minuto_partida: 88 }, estilo: 'alegacao_sem_leitura', alegacoes: ['CONTATO'], fala: 'Atleta da base caiu sem ninguém tocar nele. Simulação com amarelo?' }
        ]
    },
    {
        id: 'NG-FAIXA-EV',
        bloco: 'negativo',
        tipos: ['negativo'],
        alvo: 'Entrada_Violenta',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['telemetria.distancia_bola'],
        racional: 'Movimento dentro da faixa [1, 2] m, onde nenhum lance de distancia_bola dispara: 1,2 x 1,9 nao muda nada. Carga_Imprudente ja marcada mantem o agravante constante.',
        base: T({ minuto_partida: 35, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.6, velocidade_bola: 14, distancia_gol: 44, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        uso: ['Carga_Imprudente'],
        variantes: [
            { tel: { distancia_bola: 1.2 }, estilo: 'pergunta_direta', fala: 'Entrada violenta do zagueiro no tornozelo do atacante na dividida? Mostro vermelho?' },
            { tel: { distancia_bola: 1.9 }, estilo: 'relato_e_pergunta', fala: 'O zagueiro pegou o tornozelo do atacante na dividida. Entrada violenta com vermelho?' }
        ]
    },
    {
        id: 'NG-USO-EV',
        bloco: 'negativo',
        tipos: ['negativo'],
        alvo: 'Entrada_Violenta',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['infracoesEmUso'],
        racional: 'Infracao em uso sem agravante declarado com a infracao-alvo (Simulacao): nada muda. Competicao sem VAR.',
        base: T({ minuto_partida: 50, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.1, velocidade_bola: 12, distancia_gol: 39, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 3, distancia_bola: 1.4 }),
        ctx: ['Competicao_Sem_VAR'],
        variantes: [
            { uso: [], estilo: 'pergunta_direta', fala: 'Sem VAR no jogo: entrada violenta com as travas na coxa do adversário. Expulso?' },
            { uso: ['Simulacao'], estilo: 'pergunta_direta', fala: 'Travas na coxa do adversário, e aqui não tem VAR: entrada violenta para vermelho?' }
        ]
    },

    // -------------------------------------------------------------- INTERACAO (12)
    {
        id: 'IT-DB-MAO-CVJ',
        bloco: 'interacao',
        tipos: ['interacao', 'negativo'],
        alvo: 'Mao_Deliberada',
        objetivo: 'marcar_infracao',
        dimensoes: ['telemetria.distancia_bola'],
        racional: 'distancia_bola e lido por dois lances com sentidos diferentes. Num lance de mao a 2,6 m, Conduta_Violenta_Jogo dispara e recomenda Conduta_Violenta/Cusparada — irrelevante para a mao. A politica de Mao_Deliberada nao muda.',
        base: T({ minuto_partida: 27, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.7, velocidade_bola: 20, distancia_gol: 17, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 2 }),
        variantes: [
            { tel: { distancia_bola: 1.6 }, estilo: 'pergunta_direta', fala: 'Lançamento longo bateu no braço aberto do zagueiro. Mão deliberada para tiro livre?' },
            { tel: { distancia_bola: 2.6 }, estilo: 'relato_e_pergunta', fala: 'O braço aberto do zagueiro desviou o lançamento longo. Marco mão deliberada?' }
        ]
    },
    {
        id: 'IT-DB-CV-MAOVETO',
        bloco: 'interacao',
        tipos: ['interacao', 'negativo'],
        alvo: 'Conduta_Violenta',
        objetivo: 'classificar_infracao',
        dimensoes: ['telemetria.distancia_bola'],
        racional: 'O inverso: numa agressao a 0,7 m, Mao_Curta_Distancia dispara e veta Mao_Deliberada — veto irrelevante para a agressao.',
        base: T({ minuto_partida: 75, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.0, velocidade_bola: 13, distancia_gol: 36, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 4, distancia_bola: 1 }),
        variantes: [
            { tel: { distancia_bola: 0.7 }, estilo: 'compara_infracoes', fala: 'Na briga pela bola o volante acertou uma cotovelada no rosto do rival. Conduta violenta ou entrada violenta?' },
            { tel: { distancia_bola: 1.5 }, estilo: 'compara_infracoes', fala: 'Brigando pela bola, o volante deu uma cotovelada no rosto do adversário. Entrada violenta ou conduta violenta?' }
        ]
    },
    {
        id: 'IT-AGRAV-CARGA',
        bloco: 'interacao',
        tipos: ['interacao', 'combinatorio'],
        alvo: 'Carga_Imprudente',
        objetivo: 'classificar_infracao',
        dimensoes: ['infracoesEmUso'],
        racional: 'O agravante "Entrada_Violenta + Carga_Imprudente" vale quando QUALQUER das duas esta em uso; Entrada_Violenta em uso tambem ativa "Contato_Goleiro_Area + Entrada_Violenta". Tres niveis: nenhuma, Carga, Entrada.',
        base: T({ minuto_partida: 40, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.5, velocidade_bola: 15, distancia_gol: 37, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 4, distancia_bola: 1.1 }),
        variantes: [
            { uso: [], estilo: 'compara_infracoes', alegacoes: ['MARCACAO_PREVIA'], fala: 'Outra chegada forte do mesmo volante. Fica na carga imprudente ou já entra no padrão de entrada violenta?' },
            { uso: ['Carga_Imprudente'], estilo: 'compara_infracoes', fala: 'O volante repetiu a chegada forte. Ainda é carga imprudente ou virou entrada violenta?' },
            { uso: ['Entrada_Violenta'], estilo: 'compara_infracoes', fala: 'Chegada forte do volante de novo: carga imprudente ou entrada violenta?' }
        ]
    },
    {
        id: 'IT-AGRAV-DOGSO',
        bloco: 'interacao',
        tipos: ['interacao', 'combinatorio'],
        alvo: 'Contato_Goleiro_Area',
        objetivo: 'sancao_disciplinar',
        dimensoes: ['infracoesEmUso'],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Agravante "Contato_Goleiro_Area + Entrada_Violenta" (revisar pelo VAR antes de expulsar) com nenhuma, Entrada_Violenta ou a propria Contato_Goleiro_Area em uso.',
        base: T({ minuto_partida: 86, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 0.3, velocidade_bola: 9, distancia_gol: 8, jogadores_entre_bola_e_gol: 0, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.2 }),
        variantes: [
            { uso: [], estilo: 'alegacao_sem_leitura', alegacoes: ['FORCA'], fala: 'O goleiro fez contato com força excessiva no atacante dentro da área. Isso agrava a expulsão?' },
            { uso: ['Entrada_Violenta'], estilo: 'pergunta_direta', fala: 'Contato do goleiro na área com força excessiva sobre o atacante: muda o peso da expulsão?' },
            { uso: ['Contato_Goleiro_Area'], estilo: 'alegacao_sem_leitura', alegacoes: ['FORCA'], fala: 'Na área, o contato do goleiro no atacante foi com força excessiva. Agravo a punição?' }
        ]
    },
    {
        id: 'IT-MULTI',
        bloco: 'interacao',
        tipos: ['interacao', 'combinatorio', 'procedimento'],
        alvo: 'Impedimento',
        objetivo: 'procedimento',
        dimensoes: ['telemetria.tempo_revisao_var'],
        regrasGlobais: [RG_VAR_5MIN],
        racional: 'Dois incidentes e tres lances com gatilho ao mesmo tempo (Impedimento_Ataque, Conduta_Violenta_Jogo e, a 6 min, Revisao_VAR_Prolongada com escalonamento).',
        base: T({ minuto_partida: 89, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: -0.2, velocidade_bola: 0, distancia_gol: 12, jogadores_entre_bola_e_gol: 1, tempo_revisao_var: 4, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 3.0 }),
        variantes: [
            { tel: { tempo_revisao_var: 4 }, estilo: 'duvida_operacional', fala: 'Enquanto o VAR revisa o impedimento do gol, o zagueiro cometeu conduta violenta, uma cotovelada no atacante longe da bola. O que eu resolvo primeiro?' },
            { tel: { tempo_revisao_var: 6 }, estilo: 'duvida_operacional', fala: 'Com a checagem do impedimento ainda aberta, houve conduta violenta do zagueiro: cotovelada no atacante longe do lance. Por onde começo?' }
        ]
    },

    // -------------------------------------------------------------- UNITARIOS (21)
    {
        id: 'UN-LING-LADRAO',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Linguagem_Ofensiva',
        objetivo: 'classificar_infracao',
        dimensoes: [],
        racional: 'confusao_comum Dissenso x Linguagem_Ofensiva: insulto direto e outra infracao (vermelho).',
        base: T({ minuto_partida: 56, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.5, velocidade_bola: 0, distancia_gol: 29, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 3, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'compara_infracoes', fala: "O lateral gritou 'ladrão' na cara do árbitro depois do apito. Dissenso com amarelo ou linguagem ofensiva com vermelho?" }]
    },
    {
        id: 'UN-LING-IRONIA',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'negativo'],
        alvo: 'Dissenso',
        objetivo: 'classificar_infracao',
        dimensoes: [],
        racional: 'Mitigacao declarada: reclamacao sem ofensa, ainda que ostensiva, e dissenso — o pedido sugere linguagem ofensiva.',
        base: T({ minuto_partida: 22, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.8, velocidade_bola: 0, distancia_gol: 35, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'pergunta_direta', fala: 'O meia aplaudiu ironicamente a marcação, sem nenhum palavrão. Isso já é linguagem ofensiva?' }]
    },
    {
        id: 'UN-LING-GESTO',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'contextual'],
        alvo: 'Linguagem_Ofensiva',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Lei 12.3 inclui gestos ofensivos em Linguagem_Ofensiva; nos acrescimos, sem efeito de contexto.',
        base: T({ minuto_partida: 92, acrescimo: 3, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.0, velocidade_bola: 0, distancia_gol: 48, jogadores_entre_bola_e_gol: 5, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        ctx: ['Acrescimos'],
        variantes: [{ estilo: 'relato_e_pergunta', fala: 'Gesto obsceno do atacante para a torcida adversária depois do gol da virada. Qual a sanção?' }]
    },
    {
        id: 'UN-DISSENSO-SEMOFENSA',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'negativo'],
        alvo: 'Dissenso',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Dissenso tem sancao-base amarelo; o pedido sugere expulsao.',
        base: T({ minuto_partida: 67, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.6, velocidade_bola: 0, distancia_gol: 26, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'pergunta_direta', fala: 'Reclamação insistente do zagueiro, cara a cara, mas sem ofensa. Dá para expulsar?' }]
    },
    {
        id: 'UN-CV-ATENDIMENTO',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Conduta_Violenta',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'confusao_comum Entrada_Violenta x Conduta_Violenta: longe da disputa, mesma forca e conduta violenta (lance ativo a 8 m).',
        base: T({ minuto_partida: 49, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.2, velocidade_bola: 0, distancia_gol: 31, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 8.0 }),
        variantes: [{ estilo: 'relato_e_pergunta', fala: 'Com o jogo parado para atendimento médico, o zagueiro empurrou o rosto do atacante com força. Qual a punição?' }]
    },
    {
        id: 'UN-EV-TESOURA-BASE',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'contextual'],
        alvo: 'Entrada_Violenta',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Jogo brusco grave disputando a bola, em Categoria_Base (Leis integrais: continua expulsao).',
        base: T({ minuto_partida: 39, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.2, velocidade_bola: 9, distancia_gol: 43, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.1 }),
        ctx: ['Categoria_Base'],
        variantes: [{ estilo: 'pergunta_direta', fala: 'No sub-17, carrinho de tesoura na disputa da bola atingindo os dois tornozelos do adversário. Vermelho?' }]
    },
    {
        id: 'UN-CV-CABECADA',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Conduta_Violenta',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Agressao longe da bola (12 m): Conduta_Violenta_Jogo ativo.',
        base: T({ minuto_partida: 78, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 3.3, velocidade_bola: 18, distancia_gol: 52, jogadores_entre_bola_e_gol: 5, tempo_revisao_var: 0, placar_diferenca: -1, faltas_acumuladas_time: 4, distancia_bola: 12.0 }),
        variantes: [{ estilo: 'pergunta_direta', fala: 'Cabeçada no adversário depois de uma discussão, com a bola do outro lado do campo. Expulsão direta?' }]
    },
    {
        id: 'UN-CARGA-VERBAL',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Carga_Imprudente',
        objetivo: 'reinicio',
        dimensoes: [],
        racional: 'Carga_Imprudente: sancao NENHUM, reinicio TLD (ou penalti). Advertencia verbal nao substitui a marcacao do reinicio.',
        base: T({ minuto_partida: 24, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.9, velocidade_bola: 12, distancia_gol: 46, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.3 }),
        variantes: [{ estilo: 'duvida_operacional', fala: 'Vou só conversar com o zagueiro, uma advertência verbal pela carga imprudente. Preciso marcar o tiro livre também?' }]
    },
    {
        id: 'UN-MAO-SANCAO',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Mao_Deliberada',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        racional: 'Mao_Deliberada tem sancao NENHUM: nao ha amarelo automatico (ataque promissor nao e modelado).',
        base: T({ minuto_partida: 43, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.1, velocidade_bola: 13, distancia_gol: 49, jogadores_entre_bola_e_gol: 5, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.8 }),
        variantes: [{ estilo: 'pergunta_direta', fala: 'Mão deliberada para cortar um passe no meio-campo: o amarelo é automático?' }]
    },
    {
        id: 'UN-IMP-REINICIO',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Impedimento',
        objetivo: 'reinicio',
        dimensoes: [],
        racional: 'Impedimento: sancao NENHUM, reinicio TIRO_LIVRE_INDIRETO.',
        base: T({ minuto_partida: 17, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: -0.6, velocidade_bola: 19, distancia_gol: 24, jogadores_entre_bola_e_gol: 2, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 0, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'pergunta_direta', fala: 'Marquei impedimento do ponta. O reinício é tiro livre direto ou indireto?' }]
    },
    {
        id: 'UN-SIM-REINICIO',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Simulacao',
        objetivo: 'reinicio',
        dimensoes: [],
        racional: 'Simulacao: amarelo e reinicio TIRO_LIVRE_INDIRETO.',
        base: T({ minuto_partida: 71, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.2, velocidade_bola: 0, distancia_gol: 13, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'duvida_operacional', fala: 'Se eu der amarelo por simulação perto da marca do pênalti, o jogo recomeça como?' }]
    },
    {
        id: 'UN-PERDA-REINICIO',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Perda_Tempo',
        objetivo: 'reinicio',
        dimensoes: [],
        racional: 'Perda_Tempo declara amarelo e reinicio TIRO_LIVRE_INDIRETO; a pergunta e sobre o reinicio, nao sobre o cartao.',
        base: T({ minuto_partida: 81, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.7, velocidade_bola: 0, distancia_gol: 5, jogadores_entre_bola_e_gol: 0, tempo_revisao_var: 0, placar_diferenca: 1, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'duvida_operacional', fala: 'Dei amarelo por perda de tempo ao goleiro que prendia a bola nas mãos. O jogo recomeça com tiro livre indireto?' }]
    },
    {
        id: 'UN-PERDA-MONITORAR',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'contextual', 'procedimento'],
        alvo: 'Perda_Tempo',
        objetivo: 'procedimento',
        dimensoes: [],
        racional: '`monitorar` de Perda_Tempo (tempo perdido compoe o acrescimo, a cada 1 min) + `exige` de Acrescimos (ainda sancionavel).',
        base: T({ minuto_partida: 47, acrescimo: 2, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.0, velocidade_bola: 0, distancia_gol: 6, jogadores_entre_bola_e_gol: 0, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        ctx: ['Acrescimos'],
        variantes: [{ estilo: 'procedimento', fala: 'Quanto do tempo que o goleiro gastou vai para o acréscimo, e ainda posso dar cartão por perda de tempo?' }]
    },
    {
        id: 'UN-CUSP-ISENTO',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'evidencia_insuficiente'],
        alvo: 'Cusparada',
        objetivo: 'sancao_disciplinar',
        dimensoes: [],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Isencao de Cusparada: nao dirigida a nenhuma pessoa (fato da fala).',
        base: T({ minuto_partida: 59, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.3, velocidade_bola: 6, distancia_gol: 30, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'alegacao_sem_leitura', alegacoes: ['ALVO'], fala: 'O zagueiro cuspiu no gramado, ao lado do atacante, sem atingir ninguém. Isso é cusparada para vermelho?' }]
    },
    {
        id: 'UN-LING-REINICIO',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Linguagem_Ofensiva',
        objetivo: 'reinicio',
        dimensoes: [],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Linguagem_Ofensiva declara reinicio TIRO_LIVRE_INDIRETO (nao direto, nao penalti). Bola em jogo so na fala.',
        base: T({ minuto_partida: 73, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.0, velocidade_bola: 11, distancia_gol: 25, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'pergunta_direta', alegacoes: ['BOLA_JOGO'], fala: 'Expulsei o volante por linguagem ofensiva contra o assistente com a bola rolando. Como o jogo recomeça?' }]
    },
    {
        id: 'UN-REINC-CARTOES',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'procedimento'],
        alvo: 'Reincidencia_Amarelo',
        objetivo: 'procedimento',
        dimensoes: [],
        regrasGlobais: [RG_DUPLA],
        racional: '`sancao CARTAO_AMARELO reincidencia CARTAO_VERMELHO`, com o primeiro amarelo (Dissenso) em uso.',
        base: T({ minuto_partida: 69, acrescimo: 0, cartoes_amarelos_jogador: 1, distancia_ultimo_defensor: 1.8, velocidade_bola: 0, distancia_gol: 34, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 3, distancia_bola: 1.5 }),
        uso: ['Dissenso'],
        variantes: [{ estilo: 'procedimento', fala: 'Na reincidência de amarelo do volante, mostro os dois cartões ou só o vermelho?' }]
    },
    {
        id: 'UN-VARREV-LING',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'procedimento'],
        alvo: 'Linguagem_Ofensiva',
        objetivo: 'acionar_var',
        dimensoes: [],
        racional: 'Linguagem_Ofensiva e `var_revisavel sim`. Atributo documental: nao entra na politica.',
        base: T({ minuto_partida: 28, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.5, velocidade_bola: 0, distancia_gol: 36, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'pede_revisao', fala: 'Quero que o VAR reveja se o atacante me ofendeu mesmo, antes de expulsar por linguagem ofensiva.' }]
    },
    {
        id: 'UN-VARREV-DISSENSO',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'procedimento'],
        alvo: 'Dissenso',
        objetivo: 'acionar_var',
        dimensoes: [],
        racional: 'Dissenso e `var_revisavel nao`: contraste com UN-VARREV-LING. A politica e identica (o atributo nao a restringe).',
        base: T({ minuto_partida: 38, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 2.5, velocidade_bola: 0, distancia_gol: 36, jogadores_entre_bola_e_gol: 4, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 1, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'pede_revisao', fala: 'Peço ao VAR para rever o dissenso do capitão antes de mostrar o amarelo?' }]
    },
    {
        id: 'UN-IMP-METADE',
        bloco: 'unitario',
        tipos: ['unitario_semantico', 'evidencia_insuficiente'],
        alvo: 'Impedimento',
        objetivo: 'manter_ou_paralisar',
        dimensoes: [],
        regrasGlobais: [RG_FATO_FALA],
        racional: 'Isencao de Impedimento: propria metade do campo. A leitura diz atacante adiantado; a metade so esta na fala (o proprio gatilho de Impedimento_Ataque avisa que a infracao depende da metade).',
        base: T({ minuto_partida: 62, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: -0.5, velocidade_bola: 25, distancia_gol: 55, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.5 }),
        variantes: [{ estilo: 'manter_decisao', alegacoes: ['METADE'], fala: 'O atacante recebeu ainda na própria metade do campo e disparou; o assistente marcou impedimento. Mantenho?' }]
    },
    {
        id: 'UN-SIM-X-MAO',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Simulacao',
        objetivo: 'classificar_infracao',
        dimensoes: [],
        racional: 'confusao_comum Simulacao x Mao_Deliberada: "nao confundir queda por handball defensivo com simulacao".',
        base: T({ minuto_partida: 54, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.4, velocidade_bola: 16, distancia_gol: 14, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.2 }),
        variantes: [{ estilo: 'compara_infracoes', fala: 'A bola bateu no braço do zagueiro e o atacante caiu pedindo pênalti; o zagueiro diz que foi simulação. Quem tem razão?' }]
    },
    {
        id: 'UN-MAO-X-CARGA',
        bloco: 'unitario',
        tipos: ['unitario_semantico'],
        alvo: 'Mao_Deliberada',
        objetivo: 'classificar_infracao',
        dimensoes: [],
        racional: 'confusao_comum Mao_Deliberada x Carga_Imprudente: "confirmar se o contato inicial foi na bola ou no braco".',
        base: T({ minuto_partida: 33, acrescimo: 0, cartoes_amarelos_jogador: 0, distancia_ultimo_defensor: 1.9, velocidade_bola: 15, distancia_gol: 21, jogadores_entre_bola_e_gol: 3, tempo_revisao_var: 0, placar_diferenca: 0, faltas_acumuladas_time: 2, distancia_bola: 1.1 }),
        variantes: [{ estilo: 'compara_infracoes', fala: 'A bola bateu no braço do zagueiro logo depois de ele trombar com o atacante. Mão deliberada ou carga imprudente?' }]
    }
];

// =============================================================================
// 3) Montagem e validacao estrutural
// =============================================================================

interface CenarioNovo {
    familia: Familia;
    variante: Variante;
    indiceNaFamilia: number;
    partida: string;
    intencao: string;
    telemetria: Tel;
    contextos: string[];
    infracoesEmUso: string[];
}

interface CenarioJsonl {
    intencao: string;
    partida: string;
    telemetria: Record<string, number>;
    contextos: string[];
    infracoesEmUso: string[];
}

const CAMINHO_ANTIGOS = ['src/examples/fut/cenarios-0a200-fut.jsonl', 'src/examples/fut/cenarios-200-fut.jsonl'];
const SAIDA = {
    cenarios: path.join('src', 'examples', 'fut', 'cenarios-400-fut.jsonl'),
    meta: path.join('src', 'examples', 'fut', 'cenarios-400-fut.meta.jsonl'),
    contrastes: path.join('src', 'examples', 'fut', 'cenarios-400-fut.contrastes.jsonl'),
    relatorio: path.join('src', 'examples', 'fut', 'cobertura-400-fut.md')
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
        `{"intencao": ${JSON.stringify(c.intencao)}, "partida": ${JSON.stringify(c.partida)}, ` +
        `"telemetria": {${tel}}, "contextos": ${lista(c.contextos)}, "infracoesEmUso": ${lista(c.infracoesEmUso)}}`
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
                partida: `PT-2026-${PRIMEIRO_ID + novos.length}`,
                intencao: variante.fala,
                telemetria: ordenada,
                contextos: [...(variante.ctx ?? familia.ctx ?? [])],
                infracoesEmUso: [...(variante.uso ?? familia.uso ?? [])]
            });
        });
    }
    return novos;
}

function validarCoerencia(c: CenarioNovo, infracoes: Set<string>, contextos: Set<string>): string[] {
    const t = c.telemetria;
    const erros: string[] = [];
    const ctx = new Set(c.contextos);
    for (const x of c.contextos) if (!contextos.has(x)) erros.push(`contexto inexistente ${x}`);
    for (const x of c.infracoesEmUso) if (!infracoes.has(x)) erros.push(`infracao em uso inexistente ${x}`);
    if (c.familia.alvo && !infracoes.has(c.familia.alvo)) erros.push(`alvo inexistente ${c.familia.alvo}`);
    if (t.cartoes_amarelos_jogador !== 0 && t.cartoes_amarelos_jogador !== 1) erros.push('cartoes_amarelos_jogador fora de {0,1}');
    for (const p of ['acrescimo', 'velocidade_bola', 'distancia_gol', 'jogadores_entre_bola_e_gol', 'tempo_revisao_var', 'faltas_acumuladas_time', 'distancia_bola'] as const) {
        if (t[p] < 0) erros.push(`${p} negativo`);
    }
    if (ctx.has('Competicao_Sem_VAR') && t.tempo_revisao_var !== 0) erros.push('revisao do VAR em competicao sem VAR');
    if (ctx.has('Disputa_Penaltis') && (t.minuto_partida < 120 || t.acrescimo !== 0 || t.distancia_gol !== 11)) erros.push('disputa de penaltis com leitura de jogo corrido');
    if (ctx.has('Acrescimos')) {
        const janela = [45, 90, 105, 120].some(fim => t.minuto_partida > fim && t.minuto_partida <= fim + t.acrescimo);
        const anunciado = t.acrescimo > 0 && [45, 90].includes(t.minuto_partida);
        if (!(janela || anunciado)) erros.push('Acrescimos fora da janela de acrescimo');
    }
    // Minuto alem de 90 sem acrescimo so e coerente na prorrogacao (ate 120) ou depois dela (disputa).
    if (t.acrescimo > 0 && !([45, 90].some(fim => t.minuto_partida >= fim && t.minuto_partida <= fim + t.acrescimo))) erros.push('acrescimo fora do fim de um tempo');
    return erros;
}

/** Dimensoes em que dois cenarios diferem. */
function diferencas(a: CenarioNovo, b: CenarioNovo): Dimensao[] {
    const d: Dimensao[] = [];
    for (const p of PARAMETROS) if (a.telemetria[p] !== b.telemetria[p]) d.push(`telemetria.${p}`);
    if (JSON.stringify([...a.contextos].sort()) !== JSON.stringify([...b.contextos].sort())) d.push('contextos');
    if (JSON.stringify([...a.infracoesEmUso].sort()) !== JSON.stringify([...b.infracoesEmUso].sort())) d.push('infracoesEmUso');
    if (a.intencao !== b.intencao) d.push('intencao');
    return d;
}

// =============================================================================
// 4) Camada deterministica, foco offline e assinaturas
// =============================================================================

const SEM_SINAL: SinalVetorial = { itens: [], contextos: [] };
const SEM_SESSAO = undefined as unknown as Session;

interface Analise {
    r: RetrievedFutConstraints;
    lexInfracoes: string[];
    lexLances: string[];
    focoInfracoes: string[];
    focoLances: string[];
    politicaAlvo: string[] | null;
    politicaAlvoPosFoco: string[] | null;
    statusAlvo: string;
    exige: string[];
    etapas: string[];
}

function exigeDosContextos(model: FutModel, contextos: string[]): string[] {
    const out: string[] = [];
    for (const def of model.elements.filter(isContextDef)) {
        if (!contextos.includes(def.name)) continue;
        for (const r of def.restrictions) if (isContextRequire(r)) out.push(`${def.name}: ${r.requirement}`);
    }
    return out;
}

function etapasDosLances(model: FutModel, lances: string[]): string[] {
    const out: string[] = [];
    for (const s of model.elements.filter(isSituationDef)) {
        if (!lances.includes(s.name)) continue;
        for (const a of s.attributes) if (isStepAttr(a)) out.push(`${s.name}#${a.order}`);
    }
    return out;
}

function statusDe(r: RetrievedFutConstraints, alvo: string | null): string {
    if (!alvo) return 'SEM_INFRACAO_ALVO';
    const lance = r.vetados.some(v => v.infracao === alvo && v.lance);
    const ctx = r.vetados.some(v => v.infracao === alvo && !v.lance);
    if (lance && ctx) return 'EXCLUIDA_VETO_E_PROIBICAO';
    if (lance) return 'EXCLUIDA_VETO';
    if (ctx) return 'EXCLUIDA_PROIBICAO';
    return 'APLICAVEL';
}

async function analisar(model: FutModel, nomes: { infracoes: string[]; lances: string[] }, c: CenarioJsonl, alvo: string | null): Promise<Analise> {
    const contexto: FutContext = { partida: c.partida, telemetria: c.telemetria, contextos: c.contextos, infracoesEmUso: c.infracoesEmUso, intencao: c.intencao };
    const r = retrieveFutConstraints(model, contexto);
    const foco = await retrieverFocoFut(SEM_SESSAO, c.intencao, model, SEM_SINAL);
    const focado = filtrarPorFocoFut(r, foco, model, contexto);
    // Etapa so conta para lance em foco, ou ativo e ligado a uma infracao em foco
    // (recomenda, veta) ou escalonando. Sem isto, a etapa de Jogador_Sem_Advertencia
    // entraria em todo cenario com 0 amarelos, perguntasse o que perguntasse.
    const ativosRelevantes = [
        ...r.recomendados.filter(x => foco.infracoes.has(x.infracao)).map(x => x.lance),
        ...r.vetados.filter(v => v.lance && foco.infracoes.has(v.infracao)).map(v => v.lance as string),
        ...r.escalonamentos.map(e => e.lance)
    ];
    const lancesRelevantes = [...new Set([...ativosRelevantes, ...foco.lances])];
    return {
        r,
        lexInfracoes: [...casamentoLexical(c.intencao, nomes.infracoes)].sort(),
        lexLances: [...casamentoLexical(c.intencao, nomes.lances)].sort(),
        focoInfracoes: [...foco.infracoes].sort(),
        focoLances: [...foco.lances].sort(),
        politicaAlvo: alvo ? (r.politicas.get(alvo)?.decisoes ?? null) : null,
        politicaAlvoPosFoco: alvo ? (focado.politicas.get(alvo)?.decisoes ?? null) : null,
        statusAlvo: statusDe(r, alvo),
        exige: exigeDosContextos(model, c.contextos),
        etapas: etapasDosLances(model, lancesRelevantes)
    };
}

/** Objetivo do pedido, derivado do texto do mesmo jeito para antigos e novos. */
function objetivosDoTexto(fala: string): string[] {
    const t = normalizar(fala);
    const o = new Set<string>();
    if (/\bpenalti\b|\bcal\b|marca do penalti/.test(t)) o.add('penalti');
    if (/vermelh|expuls/.test(t)) o.add('vermelho');
    if (/amarel|cartao|advert/.test(t)) o.add('amarelo');
    if (/\banul|\bvalid|confirm\w* o gol|gol vale|deixo valer|mantenho o gol|o gol (vale|esta|foi)/.test(t)) o.add('gol');
    if (/\bvar\b|revis|monitor|video|cabine|checag/.test(t)) o.add('var');
    if (/vantagem|sigo o jogo|deixo seguir|segue o jogo|mantenho o jogo|\bparo\b|\bparar\b|apitei|interromp|apito\b/.test(t)) o.add('seguir_ou_parar');
    if (/tiro livre|qual (o )?reinicio|reinicio (e|com)|recomec|bola ao chao|repit|repet/.test(t)) o.add('reinicio');
    if (/procedimento|sequencia|como (isso )?(deve )?ficar registrad|registro na sumula|o que (eu )?(tenho que|preciso) (comunicar|conferir|fazer)|o que confiro|prazo|quanto (do )?tempo|comunicar|anunciar|avisar alguem/.test(t)) o.add('procedimento');
    if (/ ou (ja )?(e |virou |entra |fica )?(no )?(como )?(entrada|conduta|carga|linguagem|dissenso|simulacao|mao)/.test(t)) o.add('classificar');
    if (/por outra coisa|outro motivo|ao menos|pelo menos|ja que nao|se nao (da|vale|posso)|entao (expulso|dou|marco|repito)/.test(t)) o.add('alternativa');
    return [...o].sort();
}

/**
 * Canal da evidencia decisiva: a fala CITA o fato que a leitura decide (distancia,
 * posicao na linha, cartao anterior, duracao da revisao) ou so a leitura o traz.
 * Um cenario em que a fala diz "0,5 m a frente" nao distingue se o sistema leu a
 * telemetria ou o texto; um em que a fala cala distingue. E por isso um caminho
 * de decisao diferente, e entra na assinatura.
 */
function canalDoTexto(fala: string): 'fala_cita_fato_decisivo' | 'so_a_leitura' {
    const t = normalizar(fala);
    const cita =
        /\d+( \d+)? ?(m|cm|metros?|centimetros?)\b|\bna linha\b|a frente do|\batras do|adiantad|habilitado|posicao legal|condicao regular|longe da bola|longe do lance|fora da disputa|do outro lado do campo|queima roupa|muito perto|curta distancia|muito em cima|ja (tinha|tem|levou|havia|leva)( levado)?( uma| um)? (cartao|amarelo|advertencia)|levou amarelo|com (um )?(cartao )?amarelo|advertido|sem (cartao|amarelo|advertencia)|primeiro amarelo|amarelo (do jogo|no tempo normal|no primeiro tempo|anterior)|tinha amarelo|\d+ minutos|cinco minutos|passou do (limite|tempo)/;
    return cita.test(t) ? 'fala_cita_fato_decisivo' : 'so_a_leitura';
}

/** Fatos so da fala, derivados do texto (mesmo criterio para antigos e novos). */
function alegacoesDoTexto(fala: string): string[] {
    const t = normalizar(fala);
    const a = new Set<string>();
    if (/dentro da (propria |nossa )?area|fora da (propria |nossa )?area|na area\b|entrada da area/.test(t)) a.add('ZONA');
    if (/var (ja )?(me )?(confirm|revert|fech|falou|disse)|ficou provado|confirmado pelo var/.test(t)) a.add('VAR_RES');
    if (/nao vi|vi claramente|visao|ninguem .*ouviu|assistente (ouviu|viu|confirm)/.test(t)) a.add('VISAO');
    if (/braco.{0,30}(acima|colado|aberto|junto)|ombro|ampliando|corpo maior/.test(t)) a.add('BRACO');
    if (/sem contato|nenhum contato|contato nenhum|toque leve|sem ninguem (encostar|tocar)|sem toque/.test(t)) a.add('CONTATO');
    if (/goleiro batido|gol vazio|chance clara|sozinho/.test(t)) a.add('DOGSO');
    if (/vantagem clara/.test(t)) a.add('VANT');
    if (/forca excessiva|de sola|com forca/.test(t)) a.add('FORCA');
    if (/identificar|quem foi|autor/.test(t)) a.add('AUTOR');
    if (/bola fora de jogo|jogo parado|bola rolando/.test(t)) a.add('BOLA_JOGO');
    if (/tentou (jogar|tirar|disputar) a bola|nem foi na bola/.test(t)) a.add('TENTATIVA');
    if (/se recuperando|recuperando de|atraso natural|sem intencao/.test(t)) a.add('ISENCAO');
    if (/propria metade|metade do campo/.test(t)) a.add('METADE');
    if (/sem atingir|nao (foi )?dirigid|no gramado/.test(t)) a.add('ALVO');
    if (/curta distancia|muito em cima|muito perto|queima roupa/.test(t)) a.add('DISTANCIA');
    if (/posicao legal|habilitado|condicao regular/.test(t)) a.add('POSICAO');
    if (/apito final/.test(t)) a.add('APITO');
    if (/sub ?1[57]|sub ?20|\bbase\b/.test(t)) a.add('CONTEXTO_BASE');
    if (/sem var|sem video|sem arbitro de video/.test(t)) a.add('CONTEXTO_SEM_VAR');
    if (/disputa de penaltis/.test(t)) a.add('CONTEXTO_DP');
    return [...a].sort();
}

type Faixa = 'abaixo_longe' | 'abaixo_epsilon' | 'no_limiar' | 'acima_epsilon' | 'acima_longe';
function faixa(v: number, limiar: number, eps: number): Faixa {
    // Folga de ponto flutuante: 1.05 - 1 = 0.050000000000000044.
    const perto = (d: number) => d <= eps + 1e-9;
    if (v === limiar) return 'no_limiar';
    if (v < limiar) return perto(limiar - v) ? 'abaixo_epsilon' : 'abaixo_longe';
    return perto(v - limiar) ? 'acima_epsilon' : 'acima_longe';
}

/** Limiares estruturados do futebol.fut (os unicos parametros que decidem). */
const LIMIARES = [
    { regra: 'Impedimento_Ataque/Posicao_Legal_No_Passe', parametro: 'distancia_ultimo_defensor', limiar: 0, eps: 0.05, infracoes: ['Impedimento'] },
    { regra: 'Mao_Curta_Distancia', parametro: 'distancia_bola', limiar: 1, eps: 0.05, infracoes: ['Mao_Deliberada'] },
    { regra: 'Conduta_Violenta_Jogo', parametro: 'distancia_bola', limiar: 2, eps: 0.05, infracoes: ['Conduta_Violenta', 'Cusparada', 'Entrada_Violenta'] },
    { regra: 'Jogador_Sem_Advertencia', parametro: 'cartoes_amarelos_jogador', limiar: 1, eps: 0, infracoes: ['Reincidencia_Amarelo'] },
    { regra: 'Revisao_VAR_Prolongada', parametro: 'tempo_revisao_var', limiar: 5, eps: 0.1, infracoes: ['*'] }
] as const;

/**
 * Assinatura LOGICA de um cenario, relativa ao que o pedido pergunta: infracoes
 * citadas, objetivo, fatos alegados, contextos, infracoes em uso, estado
 * deterministico que toca essas infracoes e a faixa de cada limiar relevante.
 * Dois cenarios com a mesma assinatura sao o mesmo caminho de decisao, mesmo
 * com outras palavras, outro minuto ou outro placar.
 */
function assinatura(c: CenarioJsonl, a: Analise, comCanal = true): string {
    const citadas = a.lexInfracoes;
    const toca = (inf: string) => citadas.length === 0 || citadas.includes(inf);
    const estado = {
        vetos: a.r.vetados.filter(v => toca(v.infracao)).map(v => `${v.infracao}<${v.origem}`).sort(),
        recomenda: a.r.recomendados.filter(x => toca(x.infracao)).map(x => `${x.lance}>${x.infracao}`).sort(),
        escalona: a.r.escalonamentos.length > 0,
        agravantes: a.r.agravantes.filter(g => g.entre.split(' + ').some(toca)).map(g => g.entre).sort()
    };
    const faixas = LIMIARES.filter(l => l.infracoes.some(i => i === '*' || toca(i))).map(
        l => `${l.parametro}@${l.limiar}:${faixa(c.telemetria[l.parametro], l.limiar, l.eps)}`
    );
    return JSON.stringify({
        citadas,
        objetivo: objetivosDoTexto(c.intencao),
        canal: comCanal ? canalDoTexto(c.intencao) : null,
        alegacoes: alegacoesDoTexto(c.intencao),
        contextos: [...c.contextos].sort(),
        emUso: [...c.infracoesEmUso].sort(),
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
    partidasUnicas: number;
    aberturasDistintas: number;
    maiorRepeticaoAbertura: number;
    infracoesCitadas: Contagem;
    infracoesEmFocoOffline: Contagem;
    lancesAtivos: Contagem;
    lancesEmFocoOffline: Contagem;
    contextos: Contagem;
    multiContexto: number;
    emUso: Contagem;
    comEmUso: number;
    agravantes: Contagem;
    vetosLance: Contagem;
    proibicoes: Contagem;
    escalonamentos: number;
    faixas: Contagem;
    valoresDistintos: Contagem;
    noLimiarOuEpsilon: number;
    var: { comRevisao: number; semVar: number; falaVar: number; escalonamento: number; algum: number };
    comProibicao: number;
    alegacoes: Contagem;
    comAlegacao: number;
    procedimentos: { comEtapas: number; comExige: number; objetivoProcedimento: number };
    combinatorios: number;
    estruturas: Contagem;
    canal: Contagem;
}

function estatisticas(linhas: Linha[], model: FutModel): Estatisticas {
    const e: Estatisticas = {
        n: linhas.length,
        intencoesUnicas: new Set(linhas.map(l => l.c.intencao)).size,
        partidasUnicas: new Set(linhas.map(l => l.c.partida)).size,
        aberturasDistintas: 0,
        maiorRepeticaoAbertura: 0,
        infracoesCitadas: new Map(),
        infracoesEmFocoOffline: new Map(),
        lancesAtivos: new Map(),
        lancesEmFocoOffline: new Map(),
        contextos: new Map(),
        multiContexto: 0,
        emUso: new Map(),
        comEmUso: 0,
        agravantes: new Map(),
        vetosLance: new Map(),
        proibicoes: new Map(),
        escalonamentos: 0,
        faixas: new Map(),
        valoresDistintos: new Map(),
        noLimiarOuEpsilon: 0,
        var: { comRevisao: 0, semVar: 0, falaVar: 0, escalonamento: 0, algum: 0 },
        comProibicao: 0,
        alegacoes: new Map(),
        comAlegacao: 0,
        procedimentos: { comEtapas: 0, comExige: 0, objetivoProcedimento: 0 },
        combinatorios: 0,
        estruturas: new Map(),
        canal: new Map()
    };
    const aberturas: Contagem = new Map();
    const valores = new Map<string, Set<number>>();
    for (const { c, a } of linhas) {
        inc(aberturas, normalizar(c.intencao).split(' ').slice(0, 2).join(' '));
        inc(e.canal, canalDoTexto(c.intencao));
        for (const x of a.lexInfracoes) inc(e.infracoesCitadas, x);
        for (const x of a.focoInfracoes) inc(e.infracoesEmFocoOffline, x);
        for (const l of a.r.lancesAtivos) inc(e.lancesAtivos, l.nome);
        for (const l of a.focoLances) inc(e.lancesEmFocoOffline, l);
        for (const x of c.contextos) inc(e.contextos, x);
        if (c.contextos.length > 1) e.multiContexto++;
        for (const x of c.infracoesEmUso) inc(e.emUso, x);
        if (c.infracoesEmUso.length > 0) e.comEmUso++;
        for (const g of a.r.agravantes) inc(e.agravantes, g.entre);
        for (const v of a.r.vetados) inc(v.lance ? e.vetosLance : e.proibicoes, `${v.infracao} <- ${v.lance ?? v.origem.replace('contexto ', '')}`);
        if (a.r.escalonamentos.length > 0) e.escalonamentos++;
        for (const [k, v] of Object.entries(c.telemetria)) {
            if (!valores.has(k)) valores.set(k, new Set());
            valores.get(k)!.add(v);
        }
        let perto = false;
        for (const l of LIMIARES) {
            const f = faixa(c.telemetria[l.parametro], l.limiar, l.eps);
            inc(e.faixas, `${l.regra} (${l.parametro} vs ${l.limiar}): ${f}`);
            if (l.parametro !== 'cartoes_amarelos_jogador' && (f === 'no_limiar' || f === 'abaixo_epsilon' || f === 'acima_epsilon')) perto = true;
        }
        if (perto) e.noLimiarOuEpsilon++;
        if (c.telemetria.tempo_revisao_var > 0) e.var.comRevisao++;
        if (c.contextos.includes('Competicao_Sem_VAR')) e.var.semVar++;
        if (objetivosDoTexto(c.intencao).includes('var')) e.var.falaVar++;
        if (a.r.escalonamentos.length > 0) e.var.escalonamento++;
        // tempo_revisao_var > 0 sozinho nao conta: nos antigos ele e sorteado (1 a 4) sem que a fala fale de VAR.
        if (a.r.escalonamentos.length > 0 || c.contextos.includes('Competicao_Sem_VAR') || objetivosDoTexto(c.intencao).includes('var')) e.var.algum++;
        if (a.r.vetados.some(v => !v.lance)) e.comProibicao++;
        const al = alegacoesDoTexto(c.intencao).filter(x => !x.startsWith('CONTEXTO'));
        for (const x of al) inc(e.alegacoes, x);
        if (al.length > 0) e.comAlegacao++;
        if (a.etapas.length > 0) e.procedimentos.comEtapas++;
        if (a.exige.length > 0) e.procedimentos.comExige++;
        if (objetivosDoTexto(c.intencao).includes('procedimento')) e.procedimentos.objetivoProcedimento++;
        // Combinatorio: dois ou mais mecanismos estruturados que tocam as infracoes citadas.
        const toca = (inf: string) => a.lexInfracoes.length === 0 || a.lexInfracoes.includes(inf);
        const mecanismos = new Set<string>();
        for (const v of a.r.vetados) if (toca(v.infracao)) mecanismos.add(v.lance ? 'veto' : 'proibicao');
        for (const x of a.r.recomendados) if (toca(x.infracao)) mecanismos.add('recomendacao');
        if (a.r.escalonamentos.length > 0) mecanismos.add('escalonamento');
        if (a.r.agravantes.some(g => g.entre.split(' + ').some(toca))) mecanismos.add('agravante');
        if (a.exige.length > 0) mecanismos.add('exige');
        if (mecanismos.size >= 2) e.combinatorios++;
        for (const s of estruturasExercitadas(c, a, model)) inc(e.estruturas, s);
    }
    e.aberturasDistintas = aberturas.size;
    e.maiorRepeticaoAbertura = Math.max(...aberturas.values());
    for (const [k, s] of valores) e.valoresDistintos.set(k, s.size);
    return e;
}

/** Estruturas do futebol.fut que o cenario efetivamente FORCA (nao basta citar o nome). */
function estruturasExercitadas(c: CenarioJsonl, a: Analise, model: FutModel): string[] {
    const s = new Set<string>();
    for (const l of a.r.lancesAtivos) s.add(`gatilho ${l.nome}`);
    for (const v of a.r.vetados) s.add(v.lance ? `veta ${v.lance} -> ${v.infracao}` : `proibe ${v.origem.replace('contexto ', '')} -> ${v.infracao}`);
    for (const e of a.r.escalonamentos) s.add(`escalonar ${e.lance}`);
    for (const g of a.r.agravantes) s.add(`agravante ${g.entre}`);
    for (const x of c.contextos) s.add(`exige ${x}`);
    // Recomendacao e etapa so contam quando a infracao recomendada esta no foco do pedido.
    for (const x of a.r.recomendados) if (a.focoInfracoes.includes(x.infracao)) s.add(`recomenda ${x.lance} -> ${x.infracao}`);
    for (const l of a.focoLances) {
        const def = model.elements.filter(isSituationDef).find(d => d.name === l);
        if (def && !def.attributes.some(at => at.$type === 'TriggerAttr')) s.add(`foco ${l} (sem gatilho)`);
    }
    for (const et of a.etapas) s.add(`etapa ${et.split('#')[0]}`);
    return [...s];
}

// =============================================================================
// 6) Principal
// =============================================================================

async function main(): Promise<void> {
    const model = await loadFutModel(path.join('src', 'examples', 'fut', 'futebol.fut'));
    const nomes = nomesFut(model);
    const infracoes = new Set(model.elements.filter(isInfractionDef).map(i => i.name));
    const nomesContextos = new Set(model.elements.filter(isContextDef).map(c => c.name));

    const caminhoAntigos = CAMINHO_ANTIGOS.find(p => fs.existsSync(p));
    if (!caminhoAntigos) throw new Error(`nenhum dos arquivos antigos existe: ${CAMINHO_ANTIGOS.join(', ')}`);
    const brutasAntigas = fs.readFileSync(caminhoAntigos, 'utf-8').split(/\r?\n/).filter(l => l.trim().length > 0);
    const antigos = brutasAntigas.map(l => JSON.parse(l) as CenarioJsonl);

    const problemas: string[] = [];
    const avisos: string[] = [];

    // --- o serializador reproduz os antigos byte a byte
    let serializacaoIgual = 0;
    for (const [i, l] of brutasAntigas.entries()) {
        if (serializar(antigos[i]) === l) serializacaoIgual++;
        else problemas.push(`serializacao difere do antigo na linha ${i + 1}`);
    }

    const novos = montarNovos();
    if (novos.length !== 200) problemas.push(`esperados 200 novos, montados ${novos.length}`);

    // --- formato e coerencia
    const idsAntigos = new Set(antigos.map(c => c.partida));
    for (const c of novos) {
        for (const e of validarCoerencia(c, infracoes, nomesContextos)) problemas.push(`${c.partida} (${c.familia.id}): ${e}`);
        if (idsAntigos.has(c.partida)) problemas.push(`${c.partida}: colide com os antigos`);
    }

    // --- controle dentro de cada familia
    for (const f of FAMILIAS) {
        const membros = novos.filter(c => c.familia === f);
        if (f.dimensoes.length === 0 && membros.length !== 1) problemas.push(`${f.id}: familia sem dimensao precisa ter 1 cenario`);
        for (let i = 0; i < membros.length; i++) {
            for (let j = i + 1; j < membros.length; j++) {
                const d = diferencas(membros[i], membros[j]).filter(x => x !== 'intencao' || f.dimensoes.includes('intencao'));
                const fora = d.filter(x => !f.dimensoes.includes(x));
                if (fora.length > 0) problemas.push(`${f.id}: ${membros[i].partida} x ${membros[j].partida} variam fora do desenho: ${fora.join(', ')}`);
                if (d.length === 0) problemas.push(`${f.id}: ${membros[i].partida} e ${membros[j].partida} sao identicos na dimensao controlada`);
            }
        }
    }

    // --- analise de todos os 400
    const linhasAntigas: Linha[] = [];
    for (const c of antigos) linhasAntigas.push({ c, a: await analisar(model, nomes, c, null) });
    const linhasNovas: (Linha & { n: CenarioNovo })[] = [];
    for (const n of novos) {
        const c: CenarioJsonl = { intencao: n.intencao, partida: n.partida, telemetria: n.telemetria, contextos: n.contextos, infracoesEmUso: n.infracoesEmUso };
        linhasNovas.push({ c, a: await analisar(model, nomes, c, n.familia.alvo), n });
    }

    // --- foco lexical identico dentro das familias que nao variam a fala
    for (const f of FAMILIAS) {
        if (f.dimensoes.length === 0 || f.dimensoes.includes('intencao')) continue;
        const membros = linhasNovas.filter(l => l.n.familia === f);
        const sigs = new Set(membros.map(l => JSON.stringify([l.a.lexInfracoes, l.a.lexLances])));
        if (sigs.size > 1) problemas.push(`${f.id}: foco lexical difere entre membros (${[...sigs].join(' | ')})`);
    }

    // --- duplicidade logica e textual contra os antigos e entre os novos
    const sigAntigas = new Map<string, string>();
    for (const l of linhasAntigas) sigAntigas.set(assinatura(l.c, l.a), l.c.partida);
    const sigAntigasSemCanal = new Map<string, string>();
    for (const l of linhasAntigas) sigAntigasSemCanal.set(assinatura(l.c, l.a, false), l.c.partida);
    const soPeloCanal: string[] = [];
    for (const l of linhasNovas) {
        const igual = sigAntigasSemCanal.get(assinatura(l.c, l.a, false));
        if (igual && !sigAntigas.has(assinatura(l.c, l.a))) soPeloCanal.push(`${l.c.partida} (${l.n.familia.id}) ~ ${igual}`);
    }
    const triAntigos = linhasAntigas.map(l => ({ p: l.c.partida, t: trigramas(l.c.intencao) }));
    const sigNovas = new Map<string, { partida: string; familia: string }>();
    const duplicadosAntigos: string[] = [];
    const duplicadosNovos: string[] = [];
    let maiorSimilaridade = { valor: 0, novo: '', antigo: '' };
    for (const l of linhasNovas) {
        const s = assinatura(l.c, l.a);
        const igualAntigo = sigAntigas.get(s);
        if (igualAntigo) duplicadosAntigos.push(`${l.c.partida} (${l.n.familia.id}) = ${igualAntigo}`);
        const ja = sigNovas.get(s);
        const invarianciaPermitida = ja && ja.familia === l.n.familia.id;
        if (ja && !invarianciaPermitida) duplicadosNovos.push(`${l.c.partida} (${l.n.familia.id}) = ${ja.partida} (${ja.familia})`);
        if (!ja) sigNovas.set(s, { partida: l.c.partida, familia: l.n.familia.id });
        const t = trigramas(l.c.intencao);
        for (const x of triAntigos) {
            const j = jaccard(t, x.t);
            if (j > maiorSimilaridade.valor) maiorSimilaridade = { valor: j, novo: l.c.partida, antigo: x.p };
        }
    }
    for (const d of duplicadosAntigos) problemas.push(`duplicado logico de antigo: ${d}`);
    for (const d of duplicadosNovos) problemas.push(`duplicado logico entre familias: ${d}`);
    const LIMITE_TEXTO = 0.6;
    if (maiorSimilaridade.valor >= LIMITE_TEXTO) problemas.push(`fala quase identica a um antigo: ${JSON.stringify(maiorSimilaridade)}`);
    let maiorSimNovos = { valor: 0, a: '', b: '' };
    const triNovos = linhasNovas.map(l => ({ p: l.c.partida, t: trigramas(l.c.intencao) }));
    for (let i = 0; i < triNovos.length; i++)
        for (let j = i + 1; j < triNovos.length; j++) {
            const v = jaccard(triNovos[i].t, triNovos[j].t);
            if (v > maiorSimNovos.valor) maiorSimNovos = { valor: v, a: triNovos[i].p, b: triNovos[j].p };
        }

    // --- foco offline: alvo fora do foco, ou politica do alvo diferente do modelo
    const focoDivergente: string[] = [];
    const alvoForaDoFoco: string[] = [];
    for (const l of linhasNovas) {
        const alvo = l.n.familia.alvo;
        if (!alvo) continue;
        if (!l.a.focoInfracoes.includes(alvo)) alvoForaDoFoco.push(`${l.c.partida} (${l.n.familia.id}): ${alvo}`);
        else if (JSON.stringify(l.a.politicaAlvoPosFoco) !== JSON.stringify(l.a.politicaAlvo)) {
            focoDivergente.push(`${l.c.partida} (${l.n.familia.id}): ${alvo} — modelo ${l.a.politicaAlvo?.length} decisoes, depois do foco ${l.a.politicaAlvoPosFoco?.length} (lances em foco: ${l.a.focoLances.join(', ')})`);
        }
    }
    const anomaliaLexAntigos = linhasAntigas.filter(l => {
        const ativos = new Set(l.a.r.lancesAtivos.map(x => x.nome));
        return l.a.lexLances.some(x => ['Posicao_Legal_No_Passe', 'Mao_Curta_Distancia', 'Jogador_Sem_Advertencia'].includes(x) && !ativos.has(x));
    }).map(l => l.c.partida);

    if (problemas.length > 0) {
        console.error(`\n${problemas.length} problema(s) — nada foi gravado:\n  - ${problemas.join('\n  - ')}`);
        process.exit(1);
    }

    // --- meta e contrastes
    const metas = linhasNovas.map((l, i) => {
        const f = l.n.familia;
        const alegacoes = l.n.variante.alegacoes ?? [];
        const excluida = l.a.statusAlvo.startsWith('EXCLUIDA');
        const classe = !f.alvo
            ? 'SEM_INFRACAO_ALVO'
            : excluida
              ? 'SEM_SANCAO_PARA_O_ALVO'
              : alegacoes.length > 0
                ? 'APLICAVEL_COM_EVIDENCIA_INSUFICIENTE'
                : 'APLICAVEL';
        return {
            linha: antigos.length + i + 1,
            partida: l.c.partida,
            familia: f.id,
            bloco: f.bloco,
            tipos: f.tipos,
            dimensoes: f.dimensoes,
            valor: Object.fromEntries(f.dimensoes.filter(d => d !== 'intencao').map(d => {
                if (d.startsWith('telemetria.')) return [d, l.c.telemetria[d.slice('telemetria.'.length)]];
                return [d, d === 'contextos' ? l.c.contextos : l.c.infracoesEmUso];
            })),
            infracao_alvo: f.alvo,
            objetivo: f.objetivo,
            estilo: l.n.variante.estilo,
            alegacoes_sem_leitura: alegacoes,
            regras_globais: f.regrasGlobais ?? [],
            racional: f.racional,
            nota: l.n.variante.nota,
            estruturas_exercitadas: estruturasExercitadas(l.c, l.a, model).sort(),
            camada_deterministica: {
                lances_ativos: l.a.r.lancesAtivos.map(x => x.nome),
                vetos: l.a.r.vetados.map(v => ({ infracao: v.infracao, origem: v.origem })),
                escalonamentos: l.a.r.escalonamentos.map(e => `${e.lance} -> ${e.destino}`),
                agravantes: l.a.r.agravantes.map(g => g.entre),
                exige: l.a.exige,
                status_alvo: l.a.statusAlvo,
                decisoes_admissiveis_alvo: l.a.politicaAlvo
            },
            foco_offline: {
                infracoes: l.a.focoInfracoes,
                lances: l.a.focoLances,
                alvo_em_foco: f.alvo ? l.a.focoInfracoes.includes(f.alvo) : null,
                decisoes_alvo_depois_do_foco: l.a.politicaAlvoPosFoco,
                diverge_do_modelo: f.alvo ? JSON.stringify(l.a.politicaAlvoPosFoco) !== JSON.stringify(l.a.politicaAlvo) : false
            },
            esperado: {
                classe,
                acionar_var_obrigatorio: l.a.r.escalonamentos.length > 0,
                sem_confirmacao_pelo_var: alegacoes.includes('VAR_RES'),
                procedimento: { etapas: l.a.etapas, exige: l.a.exige.length > 0 }
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
                    lances: [...m.camada_deterministica.lances_ativos].sort(),
                    vetos: m.camada_deterministica.vetos.map(v => `${v.infracao}<${v.origem}`).sort(),
                    esc: m.camada_deterministica.escalonamentos,
                    agr: [...m.camada_deterministica.agravantes].sort(),
                    exige: m.camada_deterministica.exige
                });
                const politicaMuda = JSON.stringify(ma.camada_deterministica.decisoes_admissiveis_alvo) !== JSON.stringify(mb.camada_deterministica.decisoes_admissiveis_alvo);
                const escalaMuda = ma.esperado.acionar_var_obrigatorio !== mb.esperado.acionar_var_obrigatorio;
                const estadoMuda = estado(ma) !== estado(mb);
                const tipo = politicaMuda || escalaMuda ? 'sensibilidade' : estadoMuda ? 'procedimento' : 'invariancia';
                const valorDe = (l: typeof a) => d[0] === 'intencao' ? l.c.intencao : d[0].startsWith('telemetria.') ? l.c.telemetria[d[0].slice(11)] : d[0] === 'contextos' ? l.c.contextos : l.c.infracoesEmUso;
                contrastes.push({
                    familia: f.id,
                    a: a.c.partida,
                    b: b.c.partida,
                    dimensao: d[0],
                    de: valorDe(a),
                    para: valorDe(b),
                    estado_deterministico_muda: estadoMuda,
                    politica_alvo_muda: politicaMuda,
                    escalonamento_muda: escalaMuda,
                    classe_esperada_muda: ma.esperado.classe !== mb.esperado.classe,
                    tipo,
                    leitura: tipo === 'sensibilidade'
                        ? 'a regra muda: a decisao sobre o alvo DEVE mudar'
                        : tipo === 'procedimento'
                          ? 'muda lance/recomendacao/exige, nao a politica: a justificativa e o procedimento devem refletir; a decisao pode ficar'
                          : 'nenhuma regra muda: a decisao NAO deve mudar'
                });
            }
        }
    }

    // --- gravacao
    const linhasNovasTexto = novos.map(n => serializar({ intencao: n.intencao, partida: n.partida, telemetria: n.telemetria, contextos: n.contextos, infracoesEmUso: n.infracoesEmUso }));
    fs.writeFileSync(SAIDA.cenarios, [...brutasAntigas, ...linhasNovasTexto].join('\n') + '\n', 'utf-8');
    fs.writeFileSync(SAIDA.meta, metas.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
    fs.writeFileSync(SAIDA.contrastes, contrastes.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf-8');

    // --- releitura do arquivo gravado
    const relidas = fs.readFileSync(SAIDA.cenarios, 'utf-8').split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as CenarioJsonl);
    const chavesOk = relidas.every(c => JSON.stringify(Object.keys(c)) === JSON.stringify(['intencao', 'partida', 'telemetria', 'contextos', 'infracoesEmUso']) && JSON.stringify(Object.keys(c.telemetria)) === JSON.stringify(PARAMETROS));
    const validacao = {
        arquivoAntigo: caminhoAntigos,
        serializacaoReproduzAntigos: `${serializacaoIgual}/${brutasAntigas.length}`,
        totalRelido: relidas.length,
        novos: relidas.length - antigos.length,
        partidasUnicas: new Set(relidas.map(c => c.partida)).size,
        chavesEOrdemIdenticas: chavesOk,
        antigosIntactos: relidas.slice(0, antigos.length).every((c, i) => JSON.stringify(c) === JSON.stringify(antigos[i])),
        maiorSimilaridadeComAntigo: maiorSimilaridade,
        maiorSimilaridadeEntreNovos: maiorSimNovos,
        duplicadosLogicosAntigos: duplicadosAntigos.length,
        duplicadosLogicosEntreFamilias: duplicadosNovos.length,
        diferemDeUmAntigoSoPeloCanal: soPeloCanal
    };
    if (relidas.length !== 400 || validacao.partidasUnicas !== 400 || !chavesOk || !validacao.antigosIntactos) {
        console.error('releitura reprovou', validacao);
        process.exit(1);
    }

    const eAnt = estatisticas(linhasAntigas, model);
    const eNov = estatisticas(linhasNovas, model);
    const eTot = estatisticas([...linhasAntigas, ...linhasNovas], model);
    fs.writeFileSync(
        SAIDA.relatorio,
        relatorio({ eAnt, eNov, eTot, metas, contrastes, validacao, focoDivergente, alvoForaDoFoco, anomaliaLexAntigos, avisos, model }),
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
    metas: { familia: string; bloco: string; tipos: Tipo[]; infracao_alvo: string | null; esperado: { classe: string; acionar_var_obrigatorio: boolean }; alegacoes_sem_leitura: string[]; estilo: string; objetivo: string; camada_deterministica: { status_alvo: string } }[];
    contrastes: Record<string, unknown>[];
    validacao: Record<string, unknown>;
    focoDivergente: string[];
    alvoForaDoFoco: string[];
    anomaliaLexAntigos: string[];
    avisos: string[];
    model: FutModel;
}

function tabelaContagem(titulo: string, chaves: string[], eAnt: Contagem, eNov: Contagem, eTot: Contagem): string {
    const linhas = chaves.map(k => `| ${k} | ${eAnt.get(k) ?? 0} | ${eNov.get(k) ?? 0} | ${eTot.get(k) ?? 0} |`);
    return `| ${titulo} | antigos | novos | total |\n|---|---|---|---|\n${linhas.join('\n')}`;
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
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function relatorio(d: DadosRelatorio): string {
    const { eAnt, eNov, eTot, model } = d;
    const infr = model.elements.filter(isInfractionDef).map(i => i.name);
    const lances = model.elements.filter(isSituationDef).map(s => s.name);
    const ctxs = model.elements.filter(isContextDef).map(c => c.name);
    const todasChaves = (ms: Contagem[]) => [...new Set(ms.flatMap(m => [...m.keys()]))].sort();
    const porAlvo = contar(d.metas, m => m.infracao_alvo ?? '(sem infracao: so procedimento)');
    const porBloco = contar(d.metas, m => m.bloco);
    const porTipo = contar(d.metas, m => m.tipos);
    const porClasse = contar(d.metas, m => m.esperado.classe);
    const porStatus = contar(d.metas, m => m.camada_deterministica.status_alvo);
    const porEstilo = contar(d.metas, m => m.estilo);
    const porObjetivo = contar(d.metas, m => m.objetivo);
    const porTipoContraste = contar(d.contrastes, c => String(c.tipo));
    const porDimContraste = contar(d.contrastes, c => String(c.dimensao));
    const familias = FAMILIAS.map(f => {
        const n = f.variantes.length;
        const vals = f.dimensoes.filter(x => x.startsWith('telemetria.')).map(x => {
            const p = x.slice(11) as Parametro;
            return `${p}: ${f.variantes.map(v => v.tel?.[p] ?? f.base[p]).join(' / ')}`;
        });
        const dims = f.dimensoes.length === 0 ? '—' : f.dimensoes.map(x => x.replace('telemetria.', '')).join(' × ');
        return `| ${f.id} | ${f.bloco} | ${f.alvo ?? '—'} | ${dims}${vals.length ? ` (${vals.join('; ')})` : ''} | ${n} |`;
    });
    const linhasFamilia = familias.join('\n');
    const faixasChaves = todasChaves([eAnt.faixas, eNov.faixas]);
    const contagemOk = (k: string, m: Contagem) => m.get(k) ?? 0;
    const estruturaChaves = todasChaves([eAnt.estruturas, eNov.estruturas]);

    return `# Cobertura dos 400 cenários de futebol (\`cenarios-400-fut.jsonl\`)

Gerado por [gerar-cenarios-400-fut.ts](../../scripts/gerar-cenarios-400-fut.ts). Para reproduzir: \`npx tsx src/scripts/gerar-cenarios-400-fut.ts\`.

Toda contagem abaixo é calculada pelo **mesmo código** para os 200 antigos, os 200 novos e os 400: camada determinística por \`retrieveFutConstraints\`, foco offline por \`retrieverFocoFut\` (nome escrito + arestas, sem índice vetorial) e \`filtrarPorFocoFut\`, objetivo e alegações por expressões sobre a fala. Nenhuma regra da DSL é reimplementada.

## 1. Arquivos

| arquivo | conteúdo |
|---|---|
| \`cenarios-400-fut.jsonl\` | os 200 antigos (copiados byte a byte de \`${d.validacao.arquivoAntigo}\`) + 200 novos, no mesmo formato (\`intencao\`, \`partida\`, \`telemetria\` com os 11 campos na mesma ordem, \`contextos\`, \`infracoesEmUso\`), sem campo novo |
| \`cenarios-400-fut.meta.jsonl\` | um registro por cenário novo: família, bloco, tipos, dimensão controlada, objetivo, estilo, alegações sem leitura, estruturas exercitadas, camada determinística esperada, foco offline e classe esperada |
| \`cenarios-400-fut.contrastes.jsonl\` | ${d.contrastes.length} pares da mesma família que diferem em **uma** dimensão, com o que muda na camada determinística e a leitura esperada |
| \`cobertura-400-fut.md\` | este relatório |

Os metadados ficam fora do JSONL de cenários de propósito. A ligação é por \`partida\`, que o lote preserva em \`sorteio.partida\` e a avaliação em \`sujeito\`.

## 2. Resumo

| item | valor |
|---|---|
| novos cenários | ${eNov.n} |
| total após a união | ${eTot.n} |
| intenções únicas (antigos / novos / total) | ${eAnt.intencoesUnicas} / ${eNov.intencoesUnicas} / ${eTot.intencoesUnicas} |
| partidas únicas no total | ${eTot.partidasUnicas} (novas: PT-2026-4201 a PT-2026-4400) |
| famílias | ${FAMILIAS.length}: ${FAMILIAS.filter(f => f.dimensoes.length > 0).length} controladas (2 a 5 cenários, uma ou duas dimensões) e ${FAMILIAS.filter(f => f.dimensoes.length === 0).length} cenários isolados |
| cenários em fronteira, pela leitura (no limiar ou a ±ε de um limiar contínuo) | ${eAnt.noLimiarOuEpsilon} → ${eNov.noLimiarOuEpsilon} (total ${eTot.noLimiarOuEpsilon}) |
| cenários de famílias de fronteira, pelo desenho (inclui âncoras longe do limiar e os pares 0/1 de cartões) | ${d.metas.filter(m => m.tipos.includes('fronteira')).length} |
| cenários com alegação sem leitura (fato só na fala; expressão sobre o texto) | ${eAnt.comAlegacao} → ${eNov.comAlegacao} |
| cenários com veto por lance ou proibição por contexto sobre a infração-alvo (novos) | ${(porStatus.get('EXCLUIDA_VETO') ?? 0) + (porStatus.get('EXCLUIDA_PROIBICAO') ?? 0) + (porStatus.get('EXCLUIDA_VETO_E_PROIBICAO') ?? 0)} (veto ${porStatus.get('EXCLUIDA_VETO') ?? 0}, proibição ${porStatus.get('EXCLUIDA_PROIBICAO') ?? 0}, os dois ${porStatus.get('EXCLUIDA_VETO_E_PROIBICAO') ?? 0}) |
| cenários com alguma proibição por contexto incidente | ${eAnt.comProibicao} → ${eNov.comProibicao} |
| cenários de VAR (escalonamento, competição sem VAR ou VAR/revisão/monitor/vídeo na fala) | ${eAnt.var.algum} → ${eNov.var.algum}; escalonamento obrigatório ${eAnt.var.escalonamento} → ${eNov.var.escalonamento} |
| cenários combinatórios (≥ 2 mecanismos estruturados sobre as infrações citadas) | ${eAnt.combinatorios} → ${eNov.combinatorios} |
| contrastes controlados | ${d.contrastes.length}: ${ordenar(porTipoContraste).map(([k, v]) => `${v} de ${k}`).join(', ')} |

## 3. Antigos × novos × total

### 3.1 Diversidade da fala

| medida | antigos | novos | total |
|---|---|---|---|
| intenções únicas | ${eAnt.intencoesUnicas} | ${eNov.intencoesUnicas} | ${eTot.intencoesUnicas} |
| aberturas distintas (2 primeiras palavras) | ${eAnt.aberturasDistintas} | ${eNov.aberturasDistintas} | ${eTot.aberturasDistintas} |
| maior repetição de uma abertura | ${eAnt.maiorRepeticaoAbertura} | ${eNov.maiorRepeticaoAbertura} | ${eTot.maiorRepeticaoAbertura} |
| fala cita o fato decisivo (distância, linha, cartão anterior, duração) | ${eAnt.canal.get('fala_cita_fato_decisivo') ?? 0} | ${eNov.canal.get('fala_cita_fato_decisivo') ?? 0} | ${eTot.canal.get('fala_cita_fato_decisivo') ?? 0} |
| só a leitura traz o fato decisivo | ${eAnt.canal.get('so_a_leitura') ?? 0} | ${eNov.canal.get('so_a_leitura') ?? 0} | ${eTot.canal.get('so_a_leitura') ?? 0} |

Quando a fala diz "0,5 m à frente" ou "já advertido", não dá para saber se o sistema decidiu pela leitura ou pelo texto. Nos novos, as famílias de fronteira **não** dizem o valor, de propósito.

Maior similaridade de trigramas entre uma fala nova e uma antiga: ${(d.validacao.maiorSimilaridadeComAntigo as { valor: number }).valor.toFixed(2)} (limite de rejeição 0,60). Entre duas novas: ${(d.validacao.maiorSimilaridadeEntreNovos as { valor: number }).valor.toFixed(2)} — os pares de uma família mudam o estilo, não as entidades.

Estilos das falas novas: ${ordenar(porEstilo).map(([k, v]) => `${k} ${v}`).join(', ')}.

Objetivo declarado das falas novas: ${ordenar(porObjetivo).map(([k, v]) => `${k} ${v}`).join(', ')}.

### 3.2 Infrações

Citação = nome inteiro escrito na fala (critério do foco lexical). "Em foco offline" inclui as arestas do grafo.

${tabelaContagem('infração citada', infr, eAnt.infracoesCitadas, eNov.infracoesCitadas, eTot.infracoesCitadas)}

${tabelaContagem('infração em foco offline', infr, eAnt.infracoesEmFocoOffline, eNov.infracoesEmFocoOffline, eTot.infracoesEmFocoOffline)}

Infração-alvo declarada nos novos: ${ordenar(porAlvo).map(([k, v]) => `${k} ${v}`).join(', ')}. Carga_Imprudente + Entrada_Violenta + Dissenso somam ${(porAlvo.get('Carga_Imprudente') ?? 0) + (porAlvo.get('Entrada_Violenta') ?? 0) + (porAlvo.get('Dissenso') ?? 0)} de 200.

### 3.3 Lances

${tabelaContagem('lance com gatilho ativo', lances, eAnt.lancesAtivos, eNov.lancesAtivos, eTot.lancesAtivos)}

${tabelaContagem('lance em foco offline', lances, eAnt.lancesEmFocoOffline, eNov.lancesEmFocoOffline, eTot.lancesEmFocoOffline)}

### 3.4 Contextos e infrações em uso

${tabelaContagem('contexto', ctxs, eAnt.contextos, eNov.contextos, eTot.contextos)}
| (dois contextos no mesmo cenário) | ${eAnt.multiContexto} | ${eNov.multiContexto} | ${eTot.multiContexto} |

${tabelaContagem('infração em uso', todasChaves([eAnt.emUso, eNov.emUso]), eAnt.emUso, eNov.emUso, eTot.emUso)}
| (cenários com alguma em uso) | ${eAnt.comEmUso} | ${eNov.comEmUso} | ${eTot.comEmUso} |

${tabelaContagem('agravante incidente', todasChaves([eAnt.agravantes, eNov.agravantes]), eAnt.agravantes, eNov.agravantes, eTot.agravantes)}

### 3.5 Vetos, proibições e escalonamento

${tabelaContagem('veto por lance', todasChaves([eAnt.vetosLance, eNov.vetosLance]), eAnt.vetosLance, eNov.vetosLance, eTot.vetosLance)}

${tabelaContagem('proibição por contexto', todasChaves([eAnt.proibicoes, eNov.proibicoes]), eAnt.proibicoes, eNov.proibicoes, eTot.proibicoes)}

| escalonamento para o VAR | ${eAnt.escalonamentos} | ${eNov.escalonamentos} | ${eTot.escalonamentos} |
|---|---|---|---|

Os vetos de Posicao_Legal_No_Passe e Jogador_Sem_Advertencia aparecem em quase todo cenário porque \`distancia_ultimo_defensor\` e \`cartoes_amarelos_jogador\` estão sempre na leitura e um dos dois lados do limiar sempre incide. O que importa é a infração-alvo: nos novos, ${porStatus.get('APLICAVEL') ?? 0} cenários têm o alvo aplicável, ${(porStatus.get('EXCLUIDA_VETO') ?? 0) + (porStatus.get('EXCLUIDA_PROIBICAO') ?? 0) + (porStatus.get('EXCLUIDA_VETO_E_PROIBICAO') ?? 0)} excluído e ${porStatus.get('SEM_INFRACAO_ALVO') ?? 0} não têm infração (só procedimento).

### 3.6 VAR

| medida | antigos | novos | total |
|---|---|---|---|
| revisão em curso (\`tempo_revisao_var\` > 0) | ${eAnt.var.comRevisao} | ${eNov.var.comRevisao} | ${eTot.var.comRevisao} |
| escalonamento (\`> 5\`) | ${eAnt.var.escalonamento} | ${eNov.var.escalonamento} | ${eTot.var.escalonamento} |
| Competicao_Sem_VAR | ${eAnt.var.semVar} | ${eNov.var.semVar} | ${eTot.var.semVar} |
| VAR, revisão, monitor ou vídeo na fala | ${eAnt.var.falaVar} | ${eNov.var.falaVar} | ${eTot.var.falaVar} |
| resultado do VAR alegado na fala (VAR_RES) | ${eAnt.alegacoes.get('VAR_RES') ?? 0} | ${eNov.alegacoes.get('VAR_RES') ?? 0} | ${eTot.alegacoes.get('VAR_RES') ?? 0} |

### 3.7 Parâmetros e fronteiras

Só quatro parâmetros entram em regra, em cinco limiares; os outros sete o próprio \`futebol.fut\` declara sem poder decisório.

| parâmetro | papel no modelo | valores distintos (antigos → novos) |
|---|---|---|
${PARAMETROS.map(p => `| ${p} | ${PAPEL[p]} | ${eAnt.valoresDistintos.get(p) ?? 0} → ${eNov.valoresDistintos.get(p) ?? 0} |`).join('\n')}

| limiar e faixa | antigos | novos | total |
|---|---|---|---|
${faixasChaves.map(k => `| ${k} | ${contagemOk(k, eAnt.faixas)} | ${contagemOk(k, eNov.faixas)} | ${contagemOk(k, eTot.faixas)} |`).join('\n')}

ε = 0,05 para distâncias, 0,1 min para a revisão. \`cartoes_amarelos_jogador\` é inteiro e só 0 ou 1 são coerentes (2 amarelos = jogador já expulso): a fronteira dele é o par 0/1, sem ±ε. Os operadores declarados são \`<\`, \`>=\` e \`>\`; \`<=\`, \`==\` e \`!=\` não aparecem em nenhuma regra do modelo.

### 3.8 Evidência insuficiente

| fato só na fala | antigos | novos | total |
|---|---|---|---|
${todasChaves([eAnt.alegacoes, eNov.alegacoes]).map(k => `| ${k} | ${eAnt.alegacoes.get(k) ?? 0} | ${eNov.alegacoes.get(k) ?? 0} | ${eTot.alegacoes.get(k) ?? 0} |`).join('\n')}
| (cenários com algum) | ${eAnt.comAlegacao} | ${eNov.comAlegacao} | ${eTot.comAlegacao} |

Contagem por expressão sobre a fala, igual para os dois conjuntos. Nos novos, o desenho declara as alegações em \`alegacoes_sem_leitura\` (${d.metas.filter(m => m.alegacoes_sem_leitura.length > 0).length} cenários), inclusive as que nenhuma expressão captura (posição legal, curta distância, metade do campo, cartão prévio).

Os antigos já tinham muitas lacunas de dados (143 de 200 em \`cobertura-200-fut.md\`), quase sempre uma pergunta que a leitura não decide. Os novos usam a evidência insuficiente de outro jeito: em pares em que **só a fala muda** e a camada determinística é a mesma, para medir se o sistema decide pela leitura ou pela alegação.

### 3.9 Procedimento e combinação

| medida | antigos | novos | total |
|---|---|---|---|
| lance com \`etapa\` ativo ou em foco | ${eAnt.procedimentos.comEtapas} | ${eNov.procedimentos.comEtapas} | ${eTot.procedimentos.comEtapas} |
| contexto com \`exige\` | ${eAnt.procedimentos.comExige} | ${eNov.procedimentos.comExige} | ${eTot.procedimentos.comExige} |
| pedido de procedimento na fala | ${eAnt.procedimentos.objetivoProcedimento} | ${eNov.procedimentos.objetivoProcedimento} | ${eTot.procedimentos.objetivoProcedimento} |
| combinatório (≥ 2 mecanismos sobre as infrações citadas) | ${eAnt.combinatorios} | ${eNov.combinatorios} | ${eTot.combinatorios} |

### 3.10 Estruturas do \`futebol.fut\` efetivamente exercitadas

Conta um cenário só quando a estrutura **incide** (gatilho dispara, veto ou proibição recai, escalonamento dispara, agravante entra, contexto está marcado), ou quando um lance sem gatilho entra pelo foco do pedido. Recomendação conta quando a infração recomendada está no foco. Citar o nome não conta.

| estrutura | antigos | novos | total |
|---|---|---|---|
${estruturaChaves.map(k => `| ${k} | ${eAnt.estruturas.get(k) ?? 0} | ${eNov.estruturas.get(k) ?? 0} | ${eTot.estruturas.get(k) ?? 0} |`).join('\n')}

## 4. Desenho dos 200 novos

Cada cenário existe por uma razão experimental. Dentro de uma família só muda a dimensão declarada; o script **reprova a geração** se dois membros diferirem em qualquer outro campo. Nas famílias em que a dimensão é a leitura, a fala muda de estilo mas mantém as mesmas entidades e o mesmo objetivo, **nunca diz o valor que varia**, e o foco lexical é conferido igual entre os membros. Assim, uma mudança de decisão só pode vir da leitura.

| bloco | cenários |
|---|---|
${ordenar(porBloco).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

| tipo (um cenário pode ter vários) | cenários |
|---|---|
${ordenar(porTipo).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

| família | bloco | alvo | dimensão controlada | n |
|---|---|---|---|---|
${linhasFamilia}

O racional de cada família está em \`racional\`, no meta.

### 4.1 Classe esperada

Derivada da camada determinística (não é gabarito de plano):

- \`SEM_SANCAO_PARA_O_ALVO\`: o alvo está vetado ou proibido. Só restam MANTER_JOGO, BLOQUEAR_DECISAO e ACIONAR_VAR para ele, e a exclusão não autoriza inventar outra sanção.
- \`APLICAVEL\`: o alvo vale por padrão. A decisão concreta segue a sanção e os reinícios declarados.
- \`APLICAVEL_COM_EVIDENCIA_INSUFICIENTE\`: o alvo vale, mas o pedido depende de um fato só da fala. A justificativa deve declarar evidência insuficiente e não apresentar o fato como leitura.
- \`SEM_INFRACAO_ALVO\`: pedido só de procedimento.

| classe | cenários |
|---|---|
${ordenar(porClasse).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

\`acionar_var_obrigatorio\` (escalonamento disparado): ${d.metas.filter(m => m.esperado.acionar_var_obrigatorio).length} cenários.

### 4.2 Contrastes

| tipo | pares | leitura |
|---|---|---|
| sensibilidade | ${porTipoContraste.get('sensibilidade') ?? 0} | a regra muda a política do alvo ou o escalonamento: a decisão **deve** mudar |
| procedimento | ${porTipoContraste.get('procedimento') ?? 0} | muda o lance ativo, a recomendação, o agravante ou o \`exige\`, não a política: a justificativa e o procedimento devem refletir a mudança |
| invariância | ${porTipoContraste.get('invariancia') ?? 0} | nenhuma regra muda (parâmetro sem poder decisório, fala sem leitura, contexto sem efeito): a decisão **não** deve mudar |

Por dimensão: ${ordenar(porDimContraste).map(([k, v]) => `${k} ${v}`).join(', ')}.

A análise posterior junta \`contrastes.jsonl\` aos resultados do lote por \`partida\` e mede duas taxas: com que frequência a decisão sobre o alvo muda nos pares de sensibilidade (deveria ser 1) e nos de invariância (deveria ser 0).

## 5. Achados da auditoria

**5.1 O foco aplica o veto de um lance cujo gatilho não disparou.** \`filtrarPorFocoFut\` traz as arestas de **todo** lance em foco que não esteja ativo (\`arestasDoLance\`), inclusive o \`veta\`, sem olhar se o lance tem gatilho. O \`futebol.fut\` declara outra coisa: "Um lance fica ativo quando QUALQUER gatilho dele incide sobre a leitura. Lance sem gatilho só entra quando o pedido o identifica (foco)". Na prática, uma fala que escreve os tokens distintivos de Posicao_Legal_No_Passe, Mao_Curta_Distancia ou Jogador_Sem_Advertencia veta Impedimento, Mao_Deliberada ou Reincidencia_Amarelo mesmo com a leitura do outro lado do limiar. Exemplo conferido: com 1 amarelo na súmula, "O jogador já tinha uma advertência..." deixa Reincidencia_Amarelo só com MANTER_JOGO/ACIONAR_VAR/BLOQUEAR_DECISAO. Pelo nome escrito (foco offline), isso já ocorre em ${d.anomaliaLexAntigos.length} cenários antigos (${d.anomaliaLexAntigos.join(', ') || '—'}). As famílias VP-LEX-* medem o efeito com pares em que só a fala muda.

Com o índice vetorial no ar, o efeito é maior e sistemático (§6, foco real). Nenhum lance \`recomenda\` Reincidencia_Amarelo, então nenhuma aresta alcança um lance. O índice escolhe o mais próximo, que é Jogador_Sem_Advertencia, e o veto dele cai sobre o pedido de segundo amarelo **mesmo com 1 amarelo na súmula**. Consequência: na arquitetura, a fronteira de \`cartoes_amarelos_jogador\` fica invisível, e todos os pares 0/1 (FR-REINC-*, PR-SUMULA-REINC, VP-LEX-ADVERTENCIA) devem sair sem mudança de decisão. É exatamente o tipo de falha que os pares de sensibilidade existem para detectar. Código de produção não foi alterado.

**5.2 Foco offline dos novos.** Infração-alvo fora do foco offline (depende do índice vetorial para ser exprimível): ${d.alvoForaDoFoco.length}. Política do alvo diferente da do modelo depois do foco offline: ${d.focoDivergente.length}.
${d.focoDivergente.map(x => `- ${x}`).join('\n')}
${d.alvoForaDoFoco.length ? `\nAlvo fora do foco offline:\n${d.alvoForaDoFoco.map(x => `- ${x}`).join('\n')}` : ''}

**5.3 Testes apontam para o nome antigo.** \`test:foco-politica\`, \`test:restricoes\` e \`test:recuperacao-conhecimento\` leem \`src/examples/fut/cenarios-200-fut.jsonl\`. O arquivo está renomeado (staged) para \`cenarios-0a200-fut.jsonl\` e, enquanto isso, essas suítes falham ao abrir o arquivo. Este script lê qualquer um dos dois nomes. Os testes não foram alterados.

**5.4 Ground truth de fut.** O mecanismo oficial, \`gerar-ground-truth-fut.ts\`, é um gabarito fechado de 25 cenários escritos à mão, cada um com o seu resolvedor. Ele não aceita cenários externos e grava por cima de \`cenarios-25-fut.jsonl\` e \`ground_truth_fut.jsonl\`. Os textos de \`description\` dele citam regras que o \`futebol.fut\` atual não tem mais (limiar de 5 faltas em Dissenso, Perda_Tempo bloqueada nos acréscimos, Categoria_Base e Competicao_Sem_VAR proibindo infrações). A avaliação em uso (\`/api/avaliar\`, \`avaliar-grafo.ts\`) não usa gabarito: é a cascata sintaxe → semântica → oráculo → juiz, refeita a partir do \`sorteio\` de cada registro. Por isso não há gabarito novo. O \`meta.jsonl\` traz a camada determinística esperada, calculada por \`retrieveFutConstraints\`, e a classe esperada derivada dela, sem uma segunda semântica.

## 6. Validações

${VALIDACOES_EXTERNAS}

Validações internas (este script, a cada execução):

- formato: ${d.validacao.totalRelido} registros relidos, ${d.validacao.novos} novos, ${d.validacao.partidasUnicas} partidas únicas, chaves e ordem idênticas aos antigos: ${d.validacao.chavesEOrdemIdenticas ? 'sim' : 'não'}, antigos intactos: ${d.validacao.antigosIntactos ? 'sim' : 'não'}, serializador reproduz os antigos byte a byte: ${d.validacao.serializacaoReproduzAntigos};
- coerência da leitura: cartões em {0,1}; nenhuma distância, revisão ou contagem negativa; revisão 0 em Competicao_Sem_VAR; disputa de pênaltis com minuto ≥ 120, sem acréscimo e bola a 11 m; acréscimo > 0 só no fim de um tempo; Acrescimos dentro da janela de acréscimo; contextos e infrações existentes no modelo;
- controle: nenhum par de uma família varia fora da dimensão declarada; foco lexical idêntico entre membros das famílias que não variam a fala;
- novidade: duplicados lógicos contra os antigos: ${d.validacao.duplicadosLogicosAntigos}; entre famílias novas: ${d.validacao.duplicadosLogicosEntreFamilias}. A assinatura lógica cobre infrações citadas, objetivo, canal da evidência, alegações, contextos, infrações em uso, estado determinístico que toca as infrações citadas e faixa de cada limiar relevante. Repetir a mesma assinatura só é permitido dentro de uma família de invariância.
- transparência do canal: ${(d.validacao.diferemDeUmAntigoSoPeloCanal as string[]).length} cenários novos têm a mesma assinatura de um antigo, exceto pelo canal (o antigo diz o valor na fala; o novo deixa só a leitura). São âncoras (valor longe do limiar, ou exatamente no limiar) ou células de um par/fatorial, mantidas porque a família precisa delas para o contraste. Sozinhas, repetiriam um caminho antigo — ${(d.validacao.diferemDeUmAntigoSoPeloCanal as string[]).join('; ') || '—'}.

## 7. Estruturas analisadas e limites

${LIMITES}
`;
}

const PAPEL: Record<Parametro, string> = {
    minuto_partida: 'sem poder decisório (só o minuto admissível da marcação)',
    acrescimo: 'sem poder decisório (antes bloqueava Perda_Tempo; retirado)',
    cartoes_amarelos_jogador: '**decisório**: `< 1` → Jogador_Sem_Advertencia veta Reincidencia_Amarelo',
    distancia_ultimo_defensor: '**decisório**: `< 0` → Impedimento_Ataque; `>= 0` → Posicao_Legal_No_Passe veta Impedimento',
    velocidade_bola: 'sem poder decisório ("velocidade da bola não é vantagem")',
    distancia_gol: 'sem poder decisório ("distância do gol não é zona do campo")',
    jogadores_entre_bola_e_gol: 'sem poder decisório (antes decidia impedimento; retirado)',
    tempo_revisao_var: '**decisório**: `> 5` → Revisao_VAR_Prolongada + escalonar VAR (duração, não resultado)',
    placar_diferenca: 'sem poder decisório',
    faltas_acumuladas_time: 'sem poder decisório ("faltas coletivas não são dissenso individual")',
    distancia_bola: '**decisório**: `< 1` → Mao_Curta_Distancia veta Mao_Deliberada; `> 2` → Conduta_Violenta_Jogo recomenda Conduta_Violenta e Cusparada'
};

/** Amostra ponta a ponta pela API (POST /api/comando com o mesmo contexto do lote). */
const AMOSTRA_E2E = `| amostra ponta a ponta pela API (\`POST /api/comando\` com o contexto do lote; 4 cenários, 2 contrastes de sensibilidade; 12 a 14 min por cenário) | 4/4 aceitos e \`valido=true\`, sem erro de motor. **FR-MAO-BRACO, 0,99 → 1,01 m**: Mao_Deliberada ACIONAR_VAR (vetada, decisão de retirada) → PENALTI. A decisão muda exatamente na fronteira. Mas o PENALTI veio sem zona na leitura e com o alerta "revisão do VAR confirmou toque deliberado" sem revisão registrada: as duas regras globais de evidência foram violadas, coisa para o oráculo e o juiz julgarem. **FR-REINC-SIMULACAO, 0 → 1 amarelo**: com 0, Reincidencia_Amarelo ACIONAR_VAR (vetada, correto). Com 1, nenhuma cláusula de Reincidencia_Amarelo ("1 cláusula descartada"). O Prompt Semântico listou Jogador_Sem_Advertencia "sem gatilho ativo — lance identificado no pedido" e Reincidencia_Amarelo como vetada "sem advertência prévia registrada", o que é falso para a leitura. Sensibilidade falhou, como o foco real previa (§5.1) |`;

/**
 * Resultado das execucoes externas feitas na geracao de 2026-10-06 (dependem de
 * servicos no ar e do estado do Neo4j; nao sao refeitas por este script).
 */
const VALIDACOES_EXTERNAS = `Validações externas (2026-10-06, Neo4j, motor fut com bge-m3 e API no ar):

| validação | resultado |
|---|---|
| \`npm run typecheck\` (inclui este script) | OK |
| \`futebol.fut\` carregado por \`loadFutModel\` com validação | OK, sem erro léxico, sintático ou de referência (\`npm run validate\` só cobre o \`uti.dsl\`) |
| parser de upload do lote (\`web-chat/src/lote.ts::parseArquivoLote\`) sobre \`cenarios-400-fut.jsonl\` | 400 cenários; contexto com \`partida\`, \`telemetria\` (11 campos), \`contextos\`, \`infracoesEmUso\` |
| \`test:foco-politica\`, \`test:restricoes\`, \`test:recuperacao-conhecimento\` como estão | falham com ENOENT ao abrir \`cenarios-200-fut.jsonl\` (arquivo renomeado; §5.3), antes de olhar qualquer cenário |
| as mesmas três, em cópias temporárias apontadas para \`cenarios-400-fut.jsonl\` (removidas depois) | todas passam. foco-politica caso 4 (fut): 9200 comparações, 0 ampliações. restricoes: fut sobre as 400 linhas (2000 comparações × 3 RAGs + regras adversariais), 732 itens restritos examinados nos três domínios, 0 achados. recuperacao-conhecimento: 5 configurações × 130 cenários fut, saída idêntica ao bloco antigo do servidor |
| foco real (\`retrieverFocoFut\` com Neo4j e \`/embed\`) + \`filtrarPorFocoFut\` nos 400 | veto aplicado por lance com gatilho que NÃO disparou em 16 antigos e 15 novos (29 deles Jogador_Sem_Advertencia → Reincidencia_Amarelo, semeado pelo índice; 1 Posicao_Legal_No_Passe e 1 Mao_Curta_Distancia, pelo nome escrito em VP-LEX-*). Política do alvo reduzida de 13 para 3 decisões em 11 novos: FR-REINC-SIMULACAO, FR-REINC-PERDA, FR-REINC-DISSENSO, FR-REINC-EMUSO (todos com 1 amarelo), VP-LEX-ADVERTENCIA (A **e** B: o índice semeia o lance mesmo sem o nome escrito), VP-LEX-POSICAO A, VP-LEX-CURTA A, PR-SUMULA-REINC (1 amarelo), PR-SUMULA-EXPULSAO, UN-REINC-CARTOES. Alvo fora do foco real: 3 (UN-LING-IRONIA e UN-DISSENSO-SEMOFENSA → Dissenso; UN-LING-GESTO → Linguagem_Ofensiva): falas naturais sem o nome da infração, que nem o índice alcança |
${AMOSTRA_E2E}
| gabarito oficial (\`gerar-ground-truth-fut.ts\`) | não executado: gabarito fechado de 25 cenários, sem entrada externa, e grava por cima de \`cenarios-25-fut.jsonl\` e \`ground_truth_fut.jsonl\` (§5.4) |
| lote completo dos 200 novos | não executado nesta sessão: ~3,5 min por cenário com o motor livre (~12 h). Rodar pelo upload do web-chat com \`cenarios-400-fut.jsonl\` e avaliar em "Avaliar resultados" |`;

const LIMITES = `- **Penalti_Na_Area** e **Disputa_Bola_Dividida**: analisados. Não têm gatilho: não são exercitáveis como condição estruturada, só pelo foco do pedido (o nome escrito ou o índice vetorial). Os novos os trazem pelo nome em PR-ETAPAS-PENALTI-* e PR-DIVIDIDA-VANT.
- **\`zona_penal\`** (todas as infrações que a declaram): analisada. Não exercitável como condição estruturada: a zona do contato não é leitura da partida, e \`distancia_gol\` não a substitui (declarado no modelo). Exercitada só como consequência pedida, sempre com evidência insuficiente (EV-ZONA-CV, NG-DG-AREA-CARGA, PR-COMUNICA-CUSP).
- **\`isento\` / exceção, \`confusao_comum\`, \`monitorar\`**: analisados. São texto, não condição. Exercitados por pedidos que dependem deles (UN-*, EV-CONTATO-SIM, EV-AUTOR-CUSP, UN-CUSP-ISENTO, UN-PERDA-*), sem telemetria inventada.
- **\`var_revisavel\`**: analisado. Vai ao grafo e aos documentos do índice vetorial, nunca à política. Não exercitável como condição; o par UN-VARREV-LING / UN-VARREV-DISSENSO mede se o atributo documental muda algo.
- **\`desfecho\` / \`reavaliar_em\`**: analisados. São texto do lance, sem efeito em política, contrato ou validação. Não exercitáveis como condição estruturada.
- **\`etapa\` / \`prazo\`**: texto. Exercitados por pedidos de procedimento com o lance ativo de um lado do limiar e inativo do outro (PR-ETAPAS-IMP, PR-SUMULA-REINC, PR-CVJ-VANTAGEM).
- **\`exige\`** dos contextos: texto que chega ao grafo. Exercitado por pares com e sem o contexto (CT-*). Não muda o universo de decisões.
- **Competicao_Sem_VAR × escalonamento**: o conflito (revisão > 5 min numa competição sem VAR) só é alcançável com leitura incoerente (revisão em curso sem VAR). Analisado; não gerado. O modelo também não consegue retirar ACIONAR_VAR por contexto (lacuna SEM_VAR de \`cobertura-200-fut.md\`).
- **"Repetir a cobrança" (Lei 14)**: não existe no enum de decisões (lacuna RETAKE). VP-EXCL-IMP-DP, CT-DP-PARADINHA e PR-DP-VAR pedem isso de propósito, para medir se o sistema inventa uma decisão.
- **Operadores**: só \`<\`, \`>=\` e \`>\` aparecem no modelo. Não há regra com \`<=\`, \`==\` ou \`!=\` para exercitar.
- **Parâmetros sem poder decisório**: entram como dimensão controlada só em famílias de invariância (NG-*), atravessando limiares que versões anteriores do modelo usavam (16,5 m, 40 m, 5 faltas, 2 jogadores, acréscimo > 0). Nenhum foi tratado como regra.
- **Evidência ausente pela leitura** (parâmetro fora da telemetria): o código trata parâmetro ausente como regra que não incide, mas o formato dos antigos sempre traz os 11 campos e foi mantido. A ausência foi exercitada pela fala (fato alegado sem leitura) e pelos contextos (contexto citado na fala e não marcado).
- **\`tempo_revisao_var\` e \`distancia_gol\`**: \`tempo_revisao_var\` é inteiro nos antigos e recebe decimais (4.99, 5.01) nas famílias de fronteira, porque o ±ε em minutos exige. \`distancia_gol\` continua inteiro.
- **Cartões**: inteiros 0/1. O ±ε não se aplica e 2 amarelos seria leitura incoerente.`;

main().catch(err => {
    console.error('Falha ao gerar os cenarios 400 de fut:', err?.message ?? err);
    process.exit(1);
});
