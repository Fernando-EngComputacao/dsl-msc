/**
 * Parsing de arquivos de upload em lote (.jsonl/.csv), no mesmo formato de
 * src/examples/agro/cenarios-agro.jsonl (agro) ou src/examples/med/cenarios.jsonl
 * (med): cada cenário é uma "intencao" (fala) mais o contexto que o backend usaria
 * no lugar do sorteio aleatório (telemetria + talhao/paciente + áreas/populações +
 * produtos/fármacos em uso).
 */

export interface CenarioLote {
    intencao: string;
    contexto: Record<string, unknown>;
}

function linhasNaoVazias(conteudo: string): string[] {
    return conteudo.split(/\r?\n/).filter(l => l.trim().length > 0);
}

export function parseJsonl(conteudo: string): CenarioLote[] {
    return linhasNaoVazias(conteudo).map((linha, i) => {
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(linha) as Record<string, unknown>;
        } catch {
            throw new Error(`linha ${i + 1}: JSON inválido`);
        }
        const { intencao, ...contexto } = obj;
        if (typeof intencao !== 'string' || !intencao.trim()) {
            throw new Error(`linha ${i + 1}: campo "intencao" ausente ou vazio`);
        }
        return { intencao, contexto };
    });
}

/**
 * Parser CSV pequeno e autocontido (aspas duplas, "" como escape, vírgula/quebra
 * de linha dentro de campo entre aspas) — necessário porque "intencao" é texto
 * livre em português e frequentemente contém vírgulas.
 */
function parseLinhasCsv(conteudo: string): string[][] {
    const texto = conteudo.replace(/\r\n/g, '\n');
    const linhas: string[][] = [];
    let linha: string[] = [];
    let campo = '';
    let dentroAspas = false;
    let i = 0;

    while (i < texto.length) {
        const c = texto[i];
        if (dentroAspas) {
            if (c === '"') {
                if (texto[i + 1] === '"') {
                    campo += '"';
                    i += 2;
                    continue;
                }
                dentroAspas = false;
                i++;
                continue;
            }
            campo += c;
            i++;
            continue;
        }
        if (c === '"') {
            dentroAspas = true;
            i++;
            continue;
        }
        if (c === ',') {
            linha.push(campo);
            campo = '';
            i++;
            continue;
        }
        if (c === '\n') {
            linha.push(campo);
            linhas.push(linha);
            linha = [];
            campo = '';
            i++;
            continue;
        }
        campo += c;
        i++;
    }
    if (campo.length > 0 || linha.length > 0) {
        linha.push(campo);
        linhas.push(linha);
    }
    return linhas.filter(l => l.length > 1 || (l[0]?.trim().length ?? 0) > 0);
}

const COLUNA_ID: Record<'med' | 'agro' | 'fut', string> = { med: 'paciente', agro: 'talhao', fut: 'partida' };
const COLUNA_LISTA1: Record<'med' | 'agro' | 'fut', string> = { med: 'populacoes', agro: 'areas', fut: 'contextos' };
const COLUNA_LISTA2: Record<'med' | 'agro' | 'fut', string> = { med: 'farmacosEmUso', agro: 'produtosEmUso', fut: 'infracoesEmUso' };

/**
 * Colunas reservadas: intencao, a coluna de identificação (talhao/paciente) e as
 * duas colunas de lista (separadas por ";" dentro do campo). Qualquer outra
 * coluna vira um campo numérico de telemetria — não há um esquema fixo de
 * telemetria porque ele depende do modelo DSL carregado.
 */
export function parseCsv(conteudo: string, dominio: 'med' | 'agro' | 'fut'): CenarioLote[] {
    const linhas = parseLinhasCsv(conteudo);
    if (linhas.length < 2) throw new Error('CSV vazio ou sem linhas de dados');

    const cabecalho = linhas[0].map(c => c.trim());
    const idxIntencao = cabecalho.indexOf('intencao');
    if (idxIntencao === -1) throw new Error('CSV precisa de uma coluna "intencao"');

    const colunaId = COLUNA_ID[dominio];
    const colunaLista1 = COLUNA_LISTA1[dominio];
    const colunaLista2 = COLUNA_LISTA2[dominio];

    return linhas.slice(1).map((valores, i) => {
        const intencao = (valores[idxIntencao] ?? '').trim();
        if (!intencao) throw new Error(`linha ${i + 2}: campo "intencao" vazio`);

        const contexto: Record<string, unknown> = {};
        const telemetria: Record<string, number> = {};

        cabecalho.forEach((coluna, idx) => {
            if (coluna === 'intencao') return;
            const valor = (valores[idx] ?? '').trim();
            if (!valor) return;

            if (coluna === colunaId) {
                contexto[colunaId] = valor;
            } else if (coluna === colunaLista1 || coluna === colunaLista2) {
                contexto[coluna] = valor.split(';').map(v => v.trim()).filter(Boolean);
            } else {
                const numero = Number(valor);
                if (!Number.isNaN(numero)) telemetria[coluna] = numero;
            }
        });

        contexto.telemetria = telemetria;
        return { intencao, contexto };
    });
}

export function parseArquivoLote(nome: string, conteudo: string, dominio: 'med' | 'agro' | 'fut'): CenarioLote[] {
    const nomeMin = nome.toLowerCase();
    let cenarios: CenarioLote[];
    if (nomeMin.endsWith('.jsonl')) cenarios = parseJsonl(conteudo);
    else if (nomeMin.endsWith('.csv')) cenarios = parseCsv(conteudo, dominio);
    else throw new Error('Formato não suportado — envie um arquivo .jsonl ou .csv');

    if (cenarios.length === 0) throw new Error('Nenhum cenário encontrado no arquivo');
    return cenarios;
}
