/**
 * Refinamento da Consulta Semantica (`montarConsultaSemantica` em
 * `knowledge/recuperacao.ts`).
 *
 * Dois eixos de sensibilidade, e uma fronteira que nenhum deles pode cruzar.
 *
 * SENSIBILIDADE A INTENCAO: com a mesma telemetria, "avaliar hipotensao" e
 * "avaliar taquicardia" tem de produzir consultas diferentes — senao o
 * embedding recupera o mesmo subgrafo para dois pedidos distintos, e o foco
 * deixa de acompanhar o que foi pedido.
 *
 * SENSIBILIDADE A TELEMETRIA: com a mesma fala, PAM 52 e PAM 82 PODEM produzir
 * consultas diferentes (os dois numeros aparecem no texto). Mas o que nao e
 * opcional e o contexto estruturado mudar — e ele que o Cypher compara com o
 * limiar.
 *
 * A FRONTEIRA: a consulta cita o numero, nunca o interpreta. Em nenhuma
 * circunstancia este modulo pode escrever "hipotensao" porque PAM e 52. Julgar
 * valor contra limiar e trabalho do Cypher, sobre a DSL. Varios testes abaixo
 * existem so para impedir que essa linha seja cruzada por conveniencia.
 */

import assert from 'node:assert/strict';

import {
    construirContextoRecuperacao,
    montarConsultaSemantica
} from '../knowledge/recuperacao.js';
import type { ClinicalContext } from '../knowledge/graphrag.js';

let falhas = 0;
function teste(nome: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok   ${nome}`))
        .catch((erro: Error) => {
            falhas++;
            console.log(`  FALHA ${nome}\n       ${erro.message}`);
        });
}

/** Cenario clinico com intencao e telemetria variaveis; o resto fixo. */
function med(intencao: string, telemetria: Record<string, number>): ClinicalContext {
    return {
        intencao,
        paciente: 'PT-2026-0031',
        telemetria,
        populacoes: ['Renal_Cronico'],
        farmacosEmUso: ['Noradrenalina']
    };
}

const TELEMETRIA = { PAM: 52, FC: 128, SpO2: 94 };

async function main(): Promise<void> {
    console.log('\n[determinismo]');

    await teste('mesma entrada -> mesma query, sempre', () => {
        const c = med('avaliar hipotensao persistente', TELEMETRIA);
        const a = montarConsultaSemantica('med', c);
        for (let i = 0; i < 5; i++) {
            assert.equal(montarConsultaSemantica('med', c), a);
        }
        // Objetos distintos com o mesmo conteudo tambem.
        assert.equal(montarConsultaSemantica('med', med('avaliar hipotensao persistente', { ...TELEMETRIA })), a);
    });

    await teste('a composicao e a esperada, ponta a ponta', () => {
        const q = montarConsultaSemantica('med', med('avaliar hipotensao persistente', TELEMETRIA));
        assert.equal(
            q,
            'avaliar hipotensao persistente. Ambiente clinico de terapia intensiva. ' +
                'Populacoes especiais: Renal_Cronico (Renal Cronico). ' +
                'Em infusao neste momento: Noradrenalina. ' +
                'Sinais do paciente: PAM 52, FC 128, SpO2 94'
        );
    });

    console.log('\n[sensibilidade a intencao]');

    await teste('mesma telemetria, intencoes diferentes -> queries diferentes', () => {
        const hipotensao = montarConsultaSemantica('med', med('avaliar hipotensao', { PAM: 52, FC: 128 }));
        const taquicardia = montarConsultaSemantica('med', med('avaliar taquicardia', { PAM: 52, FC: 128 }));

        assert.notEqual(hipotensao, taquicardia);
        assert.match(hipotensao, /^avaliar hipotensao\./);
        assert.match(taquicardia, /^avaliar taquicardia\./);
        // Os sinais sao os mesmos nos dois — o que muda e o pedido.
        assert.match(hipotensao, /Sinais do paciente: PAM 52, FC 128/);
        assert.match(taquicardia, /Sinais do paciente: PAM 52, FC 128/);
    });

    await teste('a fala entra como foi digitada, com acento e pontuacao', () => {
        const q = montarConsultaSemantica('med', med('A pressão despencou! Sobe a nora?', { PAM: 52 }));
        assert.ok(q.startsWith('A pressão despencou! Sobe a nora?'), q);
    });

    console.log('\n[sensibilidade a telemetria]');

    await teste('mesma intencao, PAM 52 x PAM 82 -> query muda, estrutura muda', () => {
        const baixa = construirContextoRecuperacao('med', med('avaliar hipotensao', { PAM: 52, FC: 128 }));
        const alta = construirContextoRecuperacao('med', med('avaliar hipotensao', { PAM: 82, FC: 128 }));

        // A query PODE mudar — e aqui muda, porque o numero e citado.
        assert.notEqual(baixa.consultaSemantica, alta.consultaSemantica);
        assert.match(baixa.consultaSemantica, /PAM 52/);
        assert.match(alta.consultaSemantica, /PAM 82/);

        // O que NAO e opcional: o contexto estruturado muda, e e o valor exato.
        assert.equal(baixa.contextoEstruturado.telemetria.PAM, 52);
        assert.equal(alta.contextoEstruturado.telemetria.PAM, 82);
        assert.equal(typeof alta.contextoEstruturado.telemetria.PAM, 'number');
    });

    await teste('o valor e CITADO, nunca interpretado', () => {
        // A fronteira: 52 e 82 recebem exatamente o mesmo tratamento textual.
        // Se um dia alguem fizer o builder escrever "hipotensao" quando PAM < 60,
        // este teste cai — e e para cair.
        const baixa = montarConsultaSemantica('med', med('avaliar', { PAM: 52 }));
        const alta = montarConsultaSemantica('med', med('avaliar', { PAM: 82 }));

        assert.equal(baixa.replace('PAM 52', 'PAM X'), alta.replace('PAM 82', 'PAM X'),
            'as duas consultas so podem diferir no numero');
        for (const juizo of ['hipotens', 'normotens', 'baixo', 'alto', 'critico', 'grave', 'normal']) {
            assert.ok(!baixa.toLowerCase().includes(juizo), `"${juizo}" e juizo clinico: ${baixa}`);
        }
    });

    console.log('\n[relevancia: o que entra no texto]');

    await teste('parametro citado na fala vem primeiro', () => {
        const q = montarConsultaSemantica('med', med('PAM 52 e lactato 4.2: subo a nora?', {
            FC: 104, PAM: 52, glicemia: 158, lactato: 4.2
        }));
        const sinais = q.split('Sinais do paciente: ')[1];
        // PAM e lactato foram escritos pelo usuario; FC e glicemia, nao.
        assert.equal(sinais, 'PAM 52, lactato 4.2, FC 104, glicemia 158');
    });

    await teste('sem parametro citado, a ordem e a do cenario', () => {
        const q = montarConsultaSemantica('med', med('avaliar o quadro', {
            FC: 104, PAM: 52, glicemia: 158
        }));
        assert.match(q, /Sinais do paciente: FC 104, PAM 52, glicemia 158$/);
    });

    await teste('telemetria enorme nao polui a query: teto de sinais', () => {
        const grande: Record<string, number> = {};
        for (let i = 0; i < 40; i++) grande[`p${i}`] = i;
        const q = montarConsultaSemantica('med', med('avaliar o quadro', grande));
        const sinais = q.split('Sinais do paciente: ')[1].split(', ');

        assert.equal(sinais.length, 8, 'o teto padrao e 8 sinais no TEXTO');
        // ... mas a estrutura continua inteira: o teto e so de diluicao.
        const rc = construirContextoRecuperacao('med', med('avaliar o quadro', grande));
        assert.equal(Object.keys(rc.contextoEstruturado.telemetria).length, 40);
    });

    await teste('valor nao finito fica fora do texto e intacto na estrutura', () => {
        const rc = construirContextoRecuperacao('med', med('avaliar', { PAM: 52, FC: Number.NaN }));
        assert.match(rc.consultaSemantica, /Sinais do paciente: PAM 52$/);
        assert.ok(!rc.consultaSemantica.includes('NaN'), rc.consultaSemantica);
        assert.ok(Number.isNaN(rc.contextoEstruturado.telemetria.FC), 'a estrutura preserva o que veio');
    });

    await teste('parametrosRelevantes declarados tem precedencia', () => {
        const rc = construirContextoRecuperacao('med', med('PAM caindo', TELEMETRIA), {
            parametrosRelevantes: ['FC']
        });
        // Mesmo com PAM citado na fala, a declaracao explicita manda.
        assert.match(rc.consultaSemantica, /Sinais do paciente: FC 128$/);
        assert.deepEqual(rc.contextoEstruturado.telemetria, TELEMETRIA, 'estrutura nunca e filtrada');
    });

    await teste('sem telemetria, nenhum rotulo de sinais pendurado', () => {
        const q = montarConsultaSemantica('med', med('reduzir a sedacao', {}));
        assert.equal(q, 'reduzir a sedacao. Ambiente clinico de terapia intensiva. ' +
            'Populacoes especiais: Renal_Cronico (Renal Cronico). ' +
            'Em infusao neste momento: Noradrenalina');
        assert.ok(!q.includes('Sinais'), q);
    });

    console.log('\n[o que a query preserva e o que ela recusa]');

    await teste('dominio preservado: cada um com o proprio registro', () => {
        const m = montarConsultaSemantica('med', med('avaliar', { PAM: 52 }));
        const a = montarConsultaSemantica('agro', {
            intencao: 'avaliar', talhao: 'T-04', telemetria: { vento: 12 }, areas: [], produtosEmUso: []
        });
        const f = montarConsultaSemantica('fut', {
            intencao: 'avaliar', partida: 'P-07', telemetria: { minuto: 78 }, contextos: [], infracoesEmUso: []
        });

        assert.match(m, /Ambiente clinico de terapia intensiva.*Sinais do paciente: PAM 52/);
        assert.match(a, /Pulverizacao aerea por drone.*Leitura do talhao: vento 12/);
        assert.match(f, /Arbitragem de futebol.*Leitura da partida: minuto 78/);
    });

    await teste('sujeito preservado como PAPEL, nunca como identificador', () => {
        const rc = construirContextoRecuperacao('med', med('avaliar', { PAM: 52 }));
        // O papel aparece...
        assert.match(rc.consultaSemantica, /Sinais do paciente/);
        // ...o ID nao.
        assert.ok(!rc.consultaSemantica.includes('PT-2026-0031'), rc.consultaSemantica);
        // E continua exato no lado estruturado.
        assert.equal(rc.contextoEstruturado.sujeito, 'PT-2026-0031');
    });

    await teste('structuredContext preservado sob todas as variacoes de query', () => {
        for (const intencao of ['avaliar hipotensao', 'avaliar taquicardia', '']) {
            for (const PAM of [52, 82]) {
                const rc = construirContextoRecuperacao('med', med(intencao, { PAM, FC: 128, SpO2: 94 }));
                assert.deepEqual(rc.contextoEstruturado, {
                    sujeito: 'PT-2026-0031',
                    telemetria: { PAM, FC: 128, SpO2: 94 },
                    enquadramentos: ['Renal_Cronico'],
                    emCurso: ['Noradrenalina']
                });
            }
        }
    });

    await teste('a query nunca carrega lixo tecnico', () => {
        const q = montarConsultaSemantica('med', med('PAM 52 e lactato 4.2', TELEMETRIA));
        for (const proibido of ['{', '}', '[', ']', '"', 'undefined', 'null', 'NaN', 'telemetria', 'intencao']) {
            assert.ok(!q.includes(proibido), `"${proibido}" apareceu: ${q}`);
        }
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
