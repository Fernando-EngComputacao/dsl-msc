/**
 * Plano em DSL → JSON só com chave e valor, exatamente o que está no texto.
 * Não usa o AST: lê as palavras do próprio plano, então também funciona com
 * sintaxe inválida. Nenhuma chave é inventada — cada chave é uma palavra-chave
 * que aparece no plano (`partida`, `decisao`, `minuto`…).
 *
 * Vale para os três domínios, que têm a mesma forma de comando:
 *   <plano|missao|arbitragem> Nome para Alvo { esquema_referencia … <partida|paciente|talhao> …
 *   sequencia [ … ] (<ordem|aplicacao|marcacao> … )* (alerta … )* auditoria '…' }
 */

/** Chaves que sempre pertencem ao plano em si, nunca a uma ordem/marcação/alerta. */
const CHAVES_DO_PLANO = new Set(['para', 'esquema_referencia', 'partida', 'paciente', 'talhao', 'sequencia', 'auditoria']);

/** Chaves que abrem um item repetível; cada ocorrência vira um objeto numa lista. */
const CHAVES_DE_ITEM = new Set(['ordem', 'aplicacao', 'marcacao', 'alerta']);

type Valor = string | string[];
type Token = { tipo: 'texto' | 'numero' | 'palavra' | 'abre' | 'fecha' | 'virgula'; valor: string };

const TOKEN = /"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w]*)|([[])|(\])|(,)/gy;
const UNIDADE = /\s*([A-Za-z%][\w%/.]*|%)/y;

function tokenizar(texto: string): Token[] {
    const saida: Token[] = [];
    TOKEN.lastIndex = 0;
    let i = 0;
    while (i < texto.length) {
        TOKEN.lastIndex = i;
        const m = TOKEN.exec(texto);
        if (!m) {
            i++; // `{`, `}`, `(`, `->`, `:` e afins não carregam dado
            continue;
        }
        i = TOKEN.lastIndex;
        if (m[1] !== undefined) saida.push({ tipo: 'texto', valor: m[1] });
        else if (m[2] !== undefined) saida.push({ tipo: 'texto', valor: m[2] });
        else if (m[3] !== undefined) {
            // número é sempre seguido da unidade ("92.0 min"): sai junto, como no texto
            UNIDADE.lastIndex = i;
            const u = UNIDADE.exec(texto);
            if (u) i = UNIDADE.lastIndex;
            saida.push({ tipo: 'numero', valor: u ? `${m[3]} ${u[1]}` : m[3] });
        } else if (m[4] !== undefined) saida.push({ tipo: 'palavra', valor: m[4] });
        else if (m[5] !== undefined) saida.push({ tipo: 'abre', valor: '[' });
        else if (m[6] !== undefined) saida.push({ tipo: 'fecha', valor: ']' });
        else saida.push({ tipo: 'virgula', valor: ',' });
    }
    return saida;
}

/** Palavra-chave = minúscula (com `_`); valores são MAIÚSCULAS, Nomes_Com_Inicial_Maiúscula ou "sim"/"nao". */
function ehChave(t: Token): boolean {
    return t.tipo === 'palavra' && /^[a-z]/.test(t.valor) && t.valor !== 'sim' && t.valor !== 'nao';
}

function guardar(alvo: Record<string, Valor>, chave: string, valores: string[]): void {
    alvo[chave] = valores.length === 1 ? valores[0] : valores;
}

export function planoParaJson(texto: string): string {
    const tokens = tokenizar(texto);
    const plano: Record<string, Valor | Array<Record<string, Valor>>> = {};
    const itens: Record<string, Array<Record<string, Valor>>> = {};
    let atual: Record<string, Valor> | null = null;

    let i = 0;
    while (i < tokens.length) {
        const chave = tokens[i];
        i++;
        if (!ehChave(chave)) continue; // valor solto sem chave: ignorado

        const valores: string[] = [];
        let lista = false;
        while (i < tokens.length && !ehChave(tokens[i])) {
            const t = tokens[i++];
            if (t.tipo === 'abre') lista = true;
            else if (t.tipo !== 'fecha' && t.tipo !== 'virgula') valores.push(t.valor);
        }

        const nome = chave.valor;
        if (CHAVES_DE_ITEM.has(nome)) {
            atual = {};
            guardar(atual, nome, valores);
            (itens[nome] ??= []).push(atual);
        } else if (CHAVES_DO_PLANO.has(nome) || !atual) {
            atual = null;
            plano[nome] = lista ? valores : valores.length === 1 ? valores[0] : valores;
        } else {
            guardar(atual, nome, valores);
        }
    }

    // Itens entram depois do `sequencia` e antes da `auditoria`, a ordem do plano.
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(plano)) {
        if (k === 'auditoria') for (const [n, lista] of Object.entries(itens)) saida[n] = lista;
        saida[k] = v;
    }
    if (!('auditoria' in plano)) for (const [n, lista] of Object.entries(itens)) saida[n] = lista;
    return JSON.stringify(saida, null, 2);
}
