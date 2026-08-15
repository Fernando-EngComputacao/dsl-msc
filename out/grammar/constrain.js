/**
 * Especializacao da gramatica pelo subgrafo recuperado: G -> Ĝ.
 *
 * Wang et al. (2023) obtem Ĝ ⊆ G pedindo ao proprio LLM que preveja a gramatica
 * especializada antes de gerar o programa. Aqui Ĝ e obtida de forma DETERMINISTICA,
 * a partir das restricoes que o Grafo de Conhecimento julgou ativas para a
 * telemetria corrente. A diferenca importa: a etapa que decide o que e seguro
 * deixa de depender de inferencia neural.
 *
 * O ganho central e a especializacao POR FARMACO. Na gramatica base, decisao e via
 * sao vocabularios globais, de modo que "Propofol + AUMENTAR_VAZAO" continua sendo
 * uma cadeia gramatical mesmo com o Propofol bloqueado — o erro seria semantico, a
 * ser detectado depois. Ao emitir uma producao `ordem_propofol` com o seu proprio
 * conjunto de decisoes, vias e unidades, o erro semantico e convertido em erro
 * sintatico, e portanto eliminado na origem pela decodificacao restrita.
 */
/** Converte um nome de farmaco em sufixo valido de nao-terminal. */
function sufixo(nome) {
    return nome.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}
function literal(value) {
    return JSON.stringify(value);
}
/**
 * Reescreve a regra `ordem` em uma alternativa por farmaco e remove os
 * vocabularios globais que se tornaram inalcancaveis.
 */
export function constrainByPolicies(base, policies, options = {}) {
    const start = options.start ?? 'plano';
    const rules = new Map();
    const order = [];
    const put = (rule) => {
        if (!rules.has(rule.name))
            order.push(rule.name);
        rules.set(rule.name, rule);
    };
    for (const rule of base.rules)
        put({ ...rule, alts: rule.alts.map(a => [...a]) });
    const ordemBase = rules.get('ordem');
    if (!ordemBase || ordemBase.alts.length === 0) {
        throw new Error('Gramatica base sem regra `ordem`: nada a especializar.');
    }
    // Molde da ordem: ... "ordem" farmaco "decisao" decisao "dose" quantidade ...
    const molde = ordemBase.alts[0];
    const alternativasDeOrdem = [];
    const resumo = [];
    for (const policy of policies.values()) {
        if (policy.decisoes.length === 0)
            continue;
        if (policy.vias.length === 0 || policy.unidades.length === 0)
            continue;
        const sfx = sufixo(policy.farmaco);
        const nomeOrdem = `ordem_${sfx}`;
        // Substitui, no molde, cada vocabulario global pela versao do farmaco.
        const alt = molde.map(sym => {
            switch (sym) {
                case 'farmaco':
                    return literal(policy.farmaco);
                case 'decisao':
                    return `decisao_${sfx}`;
                case 'via':
                    return `via_${sfx}`;
                case 'quantidade':
                    return `quantidade_${sfx}`;
                default:
                    return sym;
            }
        });
        put({ name: nomeOrdem, alts: [alt] });
        put({ name: `decisao_${sfx}`, alts: policy.decisoes.map(d => [literal(d)]) });
        put({ name: `via_${sfx}`, alts: policy.vias.map(v => [literal(v)]) });
        put({ name: `quantidade_${sfx}`, alts: [['numero', `unidade_${sfx}`]] });
        put({ name: `unidade_${sfx}`, alts: policy.unidades.map(u => [literal(u)]) });
        alternativasDeOrdem.push([nomeOrdem]);
        resumo.push({
            farmaco: policy.farmaco,
            decisoes: policy.decisoes,
            bloqueado: policy.bloqueado
        });
    }
    if (alternativasDeOrdem.length === 0) {
        throw new Error('Nenhum farmaco sobreviveu a poda: o contexto clinico nao admite ordem alguma.');
    }
    put({ name: 'ordem', alts: alternativasDeOrdem });
    // ---------------------------------------------------- varredura de alcance
    const alcancaveis = new Set();
    const fila = [start];
    while (fila.length > 0) {
        const nome = fila.pop();
        if (alcancaveis.has(nome) || !rules.has(nome))
            continue;
        alcancaveis.add(nome);
        const rule = rules.get(nome);
        for (const alt of rule.alts) {
            for (const sym of alt) {
                if (sym.startsWith('"'))
                    continue;
                fila.push(sym.replace(/[*+?]$/, ''));
            }
        }
    }
    const finais = order.filter(n => alcancaveis.has(n)).map(n => rules.get(n));
    return {
        rules: finais,
        resumo,
        serialize(header) {
            const lines = [];
            if (header) {
                for (const line of header.split('\n'))
                    lines.push(`# ${line}`);
                lines.push('');
            }
            for (const rule of finais) {
                if (rule.regex !== undefined) {
                    lines.push(`${rule.name} ::= /${rule.regex}/`);
                }
                else {
                    lines.push(`${rule.name} ::= ` + rule.alts.map(a => a.join(' ')).join(' | '));
                }
            }
            return lines.join('\n') + '\n';
        }
    };
}
