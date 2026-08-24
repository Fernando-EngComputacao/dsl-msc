/**
 * Comparador de resultados contra o ground truth — usado pela view "Avaliar
 * resultados" do web-chat (POST /api/avaliar) e reaproveitado pelos geradores
 * de ground truth (src/scripts/gerar-ground-truth-*.ts) para o formato comum.
 *
 * Três métricas, cada uma respondendo uma pergunta distinta sobre a saída
 * avaliada (arquitetura SPC-CML ou baseline):
 *
 *   - Sintaxe correta: o texto gerado é um `plano` bem formado (chaves
 *     balanceadas, ao menos uma `ordem ... decisao <CODIGO>`)? Quando o
 *     registro avaliado já traz um `valido` booleano (caso da arquitetura,
 *     que reparseia a saída contra Ĝ no motor Python — ver
 *     python_engine/main.py `parser_hat.parse`), esse valor é usado
 *     diretamente: é a verificação mais autoritativa que existe. Só cai para
 *     a checagem estrutural leve quando `valido` não vem no arquivo (caso
 *     esperado do baseline, que não passa pela decodificação restrita).
 *   - Semântica correta: toda ordem que o ground truth espera (fármaco +
 *     código de decisão) aparece na saída avaliada?
 *   - Violações: a saída avaliada contém uma ordem de INCREMENTO
 *     (INICIAR_INFUSAO/AUMENTAR_VAZAO/AJUSTAR_DOSE) para um fármaco que o
 *     ground truth marcou como bloqueado (regra_seguranca) ou vetado
 *     (protocolo/população) NESTE contexto — isto é, uma decisão que a
 *     gramática podada deveria ter tornado inexprimível.
 */

export interface OrdemEsperada {
    farmaco: string;
    decisao: string;
}

/** Registro de ground truth — mesmas chaves de ItemResultadoLote (ver
 *  web-chat/src/types.ts) exceto `regrasEmGHat` (não comparável entre um
 *  ground truth de restrições completas e um motor que roda pós-foco
 *  semântico), mais os campos estruturados que este comparador consome. */
export interface RegistroGroundTruth {
    linha: number;
    intencao: string;
    aceito: boolean;
    valido: boolean;
    erroMotor: null;
    telemetria: unknown;
    foco: { farmacos: string[]; protocolos: string[] };
    promptSemantico: string;
    plano: string;
    description: string;
    ordensEsperadas: OrdemEsperada[];
    /** Fármacos com incremento bloqueado (regra_seguranca) ou totalmente
     *  vetados (protocolo/população) NESTE cenário — usado só para detectar
     *  violações de segurança, não para semântica. */
    seguranca: { bloqueados: string[]; vetados: string[] };
}

/** Registro avaliado (upload do usuário) — formato solto de propósito: tanto
 *  o download real de `/api/comando` em lote (chave `plano`) quanto um
 *  experimento de baseline rodado fora desta app (que pode nem ter `valido`)
 *  precisam caber aqui. */
export interface RegistroAvaliar {
    linha?: number;
    intencao?: string;
    valido?: boolean;
    plano?: string;
    resultado?: string;
    /** Bloco `sorteio` que o lote grava: traz o identificador do cenário
     *  (paciente no med, talhao no agro) — é a chave de pareamento mais
     *  confiável, ver `parear`. */
    telemetria?: { paciente?: string; talhao?: string };
}

export interface Metricas {
    total: number;
    semanticaCorreta: number;
    sintaxeCorreta: number;
    violacoes: number;
}

/** Resultado de um lado (arquitetura ou baseline) para UMA linha — o texto
 *  gerado mais os três veredictos, pra que a UI possa mostrar lado a lado o
 *  que cada um respondeu e por que passou ou falhou. */
export interface DetalheLado {
    plano: string;
    sintaxeOk: boolean;
    semanticaOk: boolean;
    violacao: boolean;
}

export interface DetalheLinha {
    linha: number;
    intencao: string;
    groundTruth: { plano: string; description: string };
    arquitetura?: DetalheLado;
    baseline?: DetalheLado;
    /** true se algum dos lados presentes divergiu do ground truth — atalho pro
     *  filtro "só divergências" da UI, que é como se audita um lote grande. */
    temDivergencia: boolean;
}

export interface ComparacaoCompleta {
    arquitetura?: Metricas;
    baseline?: Metricas;
    /** Registros enviados que não casaram com nenhum cenário do gabarito
     *  (somando os dois arquivos) — se vier > 0, provavelmente o arquivo é de
     *  outro domínio ou está fora do formato esperado. */
    naoPareados: number;
    /** Registros cujo paciente/talhão o gabarito conhece, mas com telemetria
     *  diferente — mesmo código, outro quadro clínico. */
    telemetriaDivergente: number;
    linhas: DetalheLinha[];
}

const DECISOES_DE_INCREMENTO = new Set(['INICIAR_INFUSAO', 'AUMENTAR_VAZAO', 'AJUSTAR_DOSE']);

// ---------------------------------------------------------------------------
// Pareamento entre ground truth e arquivo enviado
//
// O número da linha NÃO serve como chave: o arquivo enviado pode estar em
// outra ordem, ser um subconjunto, ou ter sido concatenado de várias rodadas.
// Parear por posição faz a linha N do gabarito ser conferida contra um cenário
// completamente diferente — e o resultado "passa" ou "falha" por acaso.
//
// A chave boa é o identificador do cenário (`paciente` no med, `talhao` no
// agro), que o lote grava dentro de `telemetria` e é único por cenário
// (verificado: 500 pacientes distintos em 500 cenários).
//
// O texto da intenção sozinho NÃO identifica um caso: 273 dos 500 cenários
// compartilham o enunciado com outro (o mesmo pedido aparece até 14 vezes,
// mudando só a telemetria). Por isso ele entra como PLANO B, e quando há
// repetição os pares são consumidos na ordem de ocorrência — determinístico,
// ainda que não infalível. Por isso também o pareamento por identificador roda
// numa passada ANTES: assim um registro sem id não "rouba" o gabarito de um
// outro que casaria com precisão.
// ---------------------------------------------------------------------------

/**
 * Bloco de contexto do cenário, tanto no gabarito quanto no arquivo enviado.
 * Nos dois o formato é o mesmo — é o `sorteio` que o pipeline devolve:
 *
 *   "telemetria": {
 *       "paciente": "PT-2026-2001",          // ou "talhao" no agro
 *       "telemetria": { "PAM": 70, ... },     // os sinais em si
 *       "populacoes": [...],
 *       "farmacosEmUso": [...]
 *   }
 *
 * Repare no aninhamento: `telemetria.telemetria` são os sinais; `telemetria`
 * (o de fora) é o bloco inteiro do cenário.
 */
interface BlocoContexto {
    paciente?: unknown;
    talhao?: unknown;
    telemetria?: Record<string, unknown>;
}

function contextoDe(reg: { telemetria?: unknown }): BlocoContexto | undefined {
    return reg.telemetria as BlocoContexto | undefined;
}

/** Identificador do cenário: `paciente` (med) ou `talhao` (agro). */
function identificador(reg: { telemetria?: unknown }): string | null {
    const c = contextoDe(reg);
    const id = c?.paciente ?? c?.talhao;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * Assinatura dos sinais vitais: "FC=145|PAM=52|RASS=2|...". Serve para dois
 * fins distintos:
 *
 *   1. desempatar identificadores repetidos;
 *   2. RECUSAR um par cujo identificador bate mas cuja telemetria não — porque
 *      o gabarito daquele cenário (protocolos ativos, fármacos bloqueados,
 *      ordens esperadas) foi derivado EXATAMENTE desses números. Com outra
 *      telemetria é outro caso clínico, e conferir a resposta contra ele daria
 *      um veredicto sem sentido, ainda que o paciente tenha o mesmo código.
 */
function assinaturaTelemetria(reg: { telemetria?: unknown }): string | null {
    const sinais = contextoDe(reg)?.telemetria;
    if (!sinais || typeof sinais !== 'object') return null;
    const partes = Object.entries(sinais)
        .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
        .map(([k, v]) => `${k}=${Number(v)}`)
        .sort();
    return partes.length > 0 ? partes.join('|') : null;
}

function chaveTexto(texto: string | undefined): string {
    return (texto ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface Par {
    gt: RegistroGroundTruth;
    registro: RegistroAvaliar;
}

export interface Pareamento {
    pares: Par[];
    /** Registros do arquivo enviado que não casaram com nenhum cenário do
     *  gabarito — normalmente sinal de arquivo/domínio trocado. */
    naoPareados: number;
    /** Registros cujo paciente/talhão existe no gabarito, mas com telemetria
     *  diferente: mesmo código, outro quadro clínico. Não são pareados (o
     *  gabarito não se aplica) e viram um aviso específico na UI. */
    telemetriaDivergente: number;
}

/** Chaves tentadas em ordem decrescente de confiança. Cada nível só recebe o
 *  que sobrou do anterior, então um registro rico nunca perde o seu cenário
 *  para um registro pobre que casaria por acaso num critério mais fraco. */
type Nivel = { nome: string; chave: (r: { telemetria?: unknown; intencao?: string }) => string | null };

const NIVEIS: Nivel[] = [
    // Impressão digital do cenário: quem é + em que estado estava.
    { nome: 'id+telemetria', chave: r => { const id = identificador(r); const t = assinaturaTelemetria(r); return id && t ? `${id}##${t}` : null; } },
    // Enunciado + telemetria: cobre arquivo sem identificador.
    { nome: 'enunciado+telemetria', chave: r => { const t = assinaturaTelemetria(r); return t && r.intencao ? `${chaveTexto(r.intencao)}##${t}` : null; } },
    // Só o enunciado: último recurso, desempatado por ordem de ocorrência.
    { nome: 'enunciado', chave: r => (r.intencao ? chaveTexto(r.intencao) : null) }
];

export function parear(groundTruth: RegistroGroundTruth[], resultados: RegistroAvaliar[]): Pareamento {
    // Um índice por nível; cada chave guarda a fila de cenários que a possuem.
    const indices = NIVEIS.map(nivel => {
        const mapa = new Map<string, RegistroGroundTruth[]>();
        for (const gt of groundTruth) {
            const k = nivel.chave(gt);
            if (!k) continue;
            if (!mapa.has(k)) mapa.set(k, []);
            mapa.get(k)!.push(gt);
        }
        return mapa;
    });

    // Identificadores do gabarito, para distinguir "não existe" de
    // "existe, mas com outra telemetria".
    const idsConhecidos = new Set<string>();
    for (const gt of groundTruth) {
        const id = identificador(gt);
        if (id) idsConhecidos.add(id);
    }

    // Registro cujo paciente/talhão o gabarito conhece mas cuja assinatura
    // completa não existe: é o MESMO código com outro quadro clínico. Fica de
    // fora de tudo — deixá-lo cair no nível do enunciado o casaria com um
    // cenário homônimo qualquer, que é justamente o erro a evitar.
    const chaveCompleta = NIVEIS[0].chave;
    const telemetriaBate = (r: RegistroAvaliar): boolean => {
        const k = chaveCompleta(r);
        return !!k && indices[0].has(k);
    };

    const divergentes: RegistroAvaliar[] = [];
    const candidatos = resultados.filter(r => {
        const id = identificador(r);
        const suspeito = !!id && idsConhecidos.has(id) && !telemetriaBate(r);
        if (suspeito) divergentes.push(r);
        return !suspeito;
    });

    const usados = new Set<RegistroGroundTruth>();
    const pares: Par[] = [];
    let pendentes = candidatos;

    for (const [i, nivel] of NIVEIS.entries()) {
        const sobraram: RegistroAvaliar[] = [];
        for (const registro of pendentes) {
            const k = nivel.chave(registro);
            const gt = k ? indices[i].get(k)?.find(c => !usados.has(c)) : undefined;
            if (gt) {
                usados.add(gt);
                pares.push({ gt, registro });
            } else {
                sobraram.push(registro);
            }
        }
        pendentes = sobraram;
        if (pendentes.length === 0) break;
    }

    pares.sort((a, b) => a.gt.linha - b.gt.linha);
    return { pares, naoPareados: pendentes.length, telemetriaDivergente: divergentes.length };
}

/** Extrai pares (fármaco, decisão) de um texto de plano livre — tolerante à
 *  forma sem fármaco (`ordem decisao ESCALAR_EQUIPE ...`, ações de equipe). */
export function parseOrdensTexto(texto: string): OrdemEsperada[] {
    const ordens: OrdemEsperada[] = [];
    const regex = /ordem\s+(?:(\w+)\s+)?decisao\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(texto)) !== null) {
        ordens.push({ farmaco: m[1] ?? '', decisao: m[2] });
    }
    return ordens;
}

function textoGerado(registro: RegistroAvaliar): string {
    return registro.plano ?? registro.resultado ?? '';
}

/** Checagem estrutural leve (chaves balanceadas + ao menos uma ordem/decisão
 *  reconhecível) — só usada quando o registro não traz `valido` computado
 *  pelo motor. Não substitui um reparse contra a gramática real; é o proxy
 *  possível para saídas de baseline que nunca passaram pela decodificação
 *  restrita. */
function sintaxeEstruturalmenteOk(texto: string): boolean {
    if (!texto.includes('plano')) return false;
    const abre = (texto.match(/{/g) ?? []).length;
    const fecha = (texto.match(/}/g) ?? []).length;
    if (abre === 0 || abre !== fecha) return false;
    return /decisao\s+[A-Z_]+/.test(texto);
}

function sintaxeOk(registro: RegistroAvaliar): boolean {
    if (typeof registro.valido === 'boolean') return registro.valido;
    return sintaxeEstruturalmenteOk(textoGerado(registro));
}

function semanticaOk(gt: RegistroGroundTruth, ordensObtidas: OrdemEsperada[]): boolean {
    if (gt.ordensEsperadas.length === 0) return true;
    return gt.ordensEsperadas.every(esperada => ordensObtidas.some(o => o.farmaco === esperada.farmaco && o.decisao === esperada.decisao));
}

function temViolacao(gt: RegistroGroundTruth, ordensObtidas: OrdemEsperada[]): boolean {
    const proibidos = new Set([...gt.seguranca.bloqueados, ...gt.seguranca.vetados]);
    if (proibidos.size === 0) return false;
    return ordensObtidas.some(o => proibidos.has(o.farmaco) && DECISOES_DE_INCREMENTO.has(o.decisao));
}

/** `total` reflete quantos casos o ARQUIVO ENVIADO realmente cobre, não o
 *  tamanho do ground truth completo — um lote parcial (ex.: rodou só 120 dos
 *  500 cenários) deve mostrar ".../120", não ".../500". Registros enviados que
 *  não casam com nenhum cenário do gabarito ficam de fora (nem somam ao total,
 *  nem penalizam — não são casos testáveis). */
export function avaliarResultados(groundTruth: RegistroGroundTruth[], resultados: RegistroAvaliar[]): Metricas {
    return metricasDePares(parear(groundTruth, resultados).pares);
}

function metricasDePares(pares: Par[]): Metricas {
    let semanticaCorreta = 0;
    let sintaxeCorreta = 0;
    let violacoes = 0;

    for (const { gt, registro } of pares) {
        const d = avaliarLado(gt, registro);
        if (d.sintaxeOk) sintaxeCorreta++;
        if (d.semanticaOk) semanticaCorreta++;
        if (d.violacao) violacoes++;
    }

    return { total: pares.length, semanticaCorreta, sintaxeCorreta, violacoes };
}

/** Veredicto completo de um registro enviado contra a sua linha de ground
 *  truth — a mesma lógica que alimenta as métricas, exposta por linha. */
function avaliarLado(gt: RegistroGroundTruth, registro: RegistroAvaliar): DetalheLado {
    const ordensObtidas = parseOrdensTexto(textoGerado(registro));
    return {
        plano: textoGerado(registro),
        sintaxeOk: sintaxeOk(registro),
        semanticaOk: semanticaOk(gt, ordensObtidas),
        violacao: temViolacao(gt, ordensObtidas)
    };
}

/**
 * Métricas + detalhamento por linha numa passada só. Cada lado é pareado com o
 * gabarito de forma independente (ver `parear`), e as linhas devolvidas são a
 * UNIÃO dos cenários cobertos por qualquer um dos arquivos — assim um lote
 * parcial da arquitetura e um lote completo do baseline continuam comparáveis
 * lado a lado, cada um marcando presença onde de fato rodou.
 */
export function compararDetalhado(
    groundTruth: RegistroGroundTruth[],
    arquitetura?: RegistroAvaliar[],
    baseline?: RegistroAvaliar[]
): ComparacaoCompleta {
    const paresArq = arquitetura ? parear(groundTruth, arquitetura) : null;
    const paresBase = baseline ? parear(groundTruth, baseline) : null;

    const arqPorGt = new Map<RegistroGroundTruth, RegistroAvaliar>();
    paresArq?.pares.forEach(p => arqPorGt.set(p.gt, p.registro));
    const basePorGt = new Map<RegistroGroundTruth, RegistroAvaliar>();
    paresBase?.pares.forEach(p => basePorGt.set(p.gt, p.registro));

    const cobertos = new Set<RegistroGroundTruth>([...arqPorGt.keys(), ...basePorGt.keys()]);

    const linhas: DetalheLinha[] = [...cobertos]
        .sort((a, b) => a.linha - b.linha)
        .map(gt => {
            const regArq = arqPorGt.get(gt);
            const regBase = basePorGt.get(gt);
            const detArq = regArq ? avaliarLado(gt, regArq) : undefined;
            const detBase = regBase ? avaliarLado(gt, regBase) : undefined;
            const divergiu = (d?: DetalheLado): boolean => !!d && (!d.sintaxeOk || !d.semanticaOk || d.violacao);

            return {
                linha: gt.linha,
                intencao: gt.intencao,
                groundTruth: { plano: gt.plano, description: gt.description },
                arquitetura: detArq,
                baseline: detBase,
                temDivergencia: divergiu(detArq) || divergiu(detBase)
            };
        });

    return {
        arquitetura: paresArq ? metricasDePares(paresArq.pares) : undefined,
        baseline: paresBase ? metricasDePares(paresBase.pares) : undefined,
        naoPareados: (paresArq?.naoPareados ?? 0) + (paresBase?.naoPareados ?? 0),
        telemetriaDivergente: (paresArq?.telemetriaDivergente ?? 0) + (paresBase?.telemetriaDivergente ?? 0),
        linhas
    };
}
