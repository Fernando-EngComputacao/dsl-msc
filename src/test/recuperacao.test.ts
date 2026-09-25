/**
 * Verificacao do Contexto de Recuperacao (`knowledge/recuperacao.ts`).
 *
 * O que estes testes protegem e a REGRA que sustenta a camada: a consulta
 * semantica nao substitui a telemetria estruturada. As duas representacoes saem
 * da mesma entrada, e cada uma preserva o que o seu consumidor precisa:
 *
 *   - a consulta semantica cita "PAM 52" em prosa, para o embedding;
 *   - o contexto estruturado guarda o numero 52, para a comparacao com limiar.
 *
 * Por isso os casos PAM 52 x PAM 82: se um dia a projecao passar a descrever o
 * valor ("hipotensao") em vez de preserva-lo, o teste falha aqui e nao tres
 * camadas adiante, quando um bloqueio deixar de disparar.
 *
 * Nada depende de Neo4j, do motor Python nem de GPU: e uma funcao pura sobre o
 * contexto que o pipeline ja monta.
 */

import assert from 'node:assert/strict';

import {
    construirContextoRecuperacao,
    montarConsultaSemantica,
    type ContextoRecuperacao
} from '../knowledge/recuperacao.js';
import type { ClinicalContext } from '../knowledge/graphrag.js';
import type { AgroContext } from '../knowledge/graphrag-agro.js';
import type { FutContext } from '../knowledge/graphrag-fut.js';

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

/** O cenario do enunciado da etapa: hipotensao persistente sob noradrenalina. */
const MED: ClinicalContext = {
    intencao: 'avaliar hipotensao persistente',
    paciente: 'PT-2026-0031',
    telemetria: { PAM: 52, FC: 128, SpO2: 94 },
    populacoes: ['Renal_Cronico'],
    farmacosEmUso: ['Noradrenalina']
};

const AGRO: AgroContext = {
    intencao: 'a folha ta fervendo no talhao da cana',
    talhao: 'T-04',
    telemetria: { vento: 12, umidade: 58, temperatura: 31 },
    areas: ['Faixa_Manancial'],
    produtosEmUso: ['Imidacloprido']
};

const FUT: FutContext = {
    intencao: 'entrada dura pelas costas no meio de campo',
    partida: 'PARTIDA-2026-07',
    telemetria: { minuto: 78, cartoes_amarelos: 3 },
    contextos: ['Acrescimos'],
    infracoesEmUso: ['Falta_Tatica']
};

async function main(): Promise<void> {
    console.log('\n[construcao a partir do contexto do pipeline]');

    await teste('1. input simples: so a fala, sem contexto algum', () => {
        const rc = construirContextoRecuperacao('med', {
            intencao: 'reduzir a sedacao',
            telemetria: {}
        });
        assert.equal(rc.intencao, 'reduzir a sedacao');
        assert.equal(rc.sujeito, undefined);
        assert.deepEqual(rc.telemetria, {});
        assert.deepEqual(rc.contextoEstruturado.enquadramentos, []);
        assert.deepEqual(rc.contextoEstruturado.emCurso, []);
        // Sem nada a acrescentar, a consulta e a fala mais a ancora de dominio —
        // e nenhum rotulo vazio pendurado.
        assert.equal(
            rc.consultaSemantica,
            'reduzir a sedacao. Ambiente clinico de terapia intensiva'
        );
    });

    await teste('2. input + telemetria: os sinais entram em prosa na consulta', () => {
        const rc = construirContextoRecuperacao('med', {
            intencao: 'avaliar hipotensao persistente',
            telemetria: { PAM: 52, FC: 128, SpO2: 94 }
        });
        assert.match(rc.consultaSemantica, /Sinais do paciente: PAM 52, FC 128, SpO2 94/);
        // ... e continuam numeros do outro lado.
        assert.equal(rc.contextoEstruturado.telemetria.PAM, 52);
        assert.equal(typeof rc.contextoEstruturado.telemetria.PAM, 'number');
    });

    await teste('3. input + sujeito: preservado na estrutura, FORA da consulta', () => {
        const rc = construirContextoRecuperacao('med', MED);
        assert.equal(rc.sujeito, 'PT-2026-0031');
        assert.equal(rc.contextoEstruturado.sujeito, 'PT-2026-0031');
        assert.ok(
            !rc.consultaSemantica.includes('PT-2026-0031'),
            `o ID do sujeito vazou para o embedding: ${rc.consultaSemantica}`
        );
    });

    await teste('4. input + dominio: cada dominio le os proprios campos', () => {
        const med = construirContextoRecuperacao('med', MED);
        const agro = construirContextoRecuperacao('agro', AGRO);
        const fut = construirContextoRecuperacao('fut', FUT);

        assert.equal(med.sujeito, 'PT-2026-0031');
        assert.equal(agro.sujeito, 'T-04');
        assert.equal(fut.sujeito, 'PARTIDA-2026-07');

        assert.deepEqual(agro.contextoEstruturado.enquadramentos, ['Faixa_Manancial']);
        assert.deepEqual(fut.contextoEstruturado.emCurso, ['Falta_Tatica']);

        assert.match(med.consultaSemantica, /Ambiente clinico de terapia intensiva/);
        assert.match(agro.consultaSemantica, /Pulverizacao aerea por drone/);
        assert.match(fut.consultaSemantica, /Arbitragem de futebol/);

        // O rotulo e o do dominio, nao um generico: e o que mantem a consulta no
        // mesmo registro do documento indexado.
        assert.match(agro.consultaSemantica, /Areas especiais: Faixa_Manancial \(Faixa Manancial\)/);
        assert.match(fut.consultaSemantica, /Contextos da partida: Acrescimos/);
    });

    await teste('5. input + estado de curso: entra na consulta e na estrutura', () => {
        const rc = construirContextoRecuperacao('med', MED);
        assert.deepEqual(rc.contextoEstruturado.emCurso, ['Noradrenalina']);
        assert.match(rc.consultaSemantica, /Em infusao neste momento: Noradrenalina/);

        const agro = construirContextoRecuperacao('agro', AGRO);
        assert.match(agro.consultaSemantica, /No tanque neste momento: Imidacloprido/);
    });

    console.log('\n[preservacao: o lado deterministico nao pode perder nada]');

    await teste('6. telemetria preservada: todos os parametros, valores identicos', () => {
        const rc = construirContextoRecuperacao('med', MED);
        assert.deepEqual(rc.contextoEstruturado.telemetria, MED.telemetria);
        assert.deepEqual(Object.keys(rc.telemetria), Object.keys(MED.telemetria));
        // O atalho e o MESMO objeto: uma telemetria so, dois caminhos.
        assert.equal(rc.telemetria, rc.contextoEstruturado.telemetria);
    });

    await teste('6b. numero nao e arredondado nem virado texto', () => {
        const rc = construirContextoRecuperacao('med', {
            intencao: 'lactato subindo',
            telemetria: { lactato: 4.85, TFG: 28.125 }
        });
        assert.equal(rc.contextoEstruturado.telemetria.lactato, 4.85);
        assert.equal(rc.contextoEstruturado.telemetria.TFG, 28.125);
        // Na prosa o numero aparece como foi medido — sem casa forcada (4.850)
        // e sem corte (4.8). Ver `numero()` em recuperacao.ts.
        assert.match(rc.consultaSemantica, /lactato 4\.85, TFG 28\.125/);
    });

    await teste('7. contexto estruturado preservado por inteiro', () => {
        const rc = construirContextoRecuperacao('med', MED);
        assert.deepEqual(rc.contextoEstruturado, {
            sujeito: 'PT-2026-0031',
            telemetria: { PAM: 52, FC: 128, SpO2: 94 },
            enquadramentos: ['Renal_Cronico'],
            emCurso: ['Noradrenalina']
        });
    });

    await teste('7b. o contexto de entrada nao e modificado', () => {
        const entrada: ClinicalContext = {
            intencao: 'x',
            paciente: 'PT-1',
            telemetria: { PAM: 52 },
            populacoes: ['Renal_Cronico'],
            farmacosEmUso: ['Noradrenalina']
        };
        const copia = structuredClone(entrada);
        const rc = construirContextoRecuperacao('med', entrada);
        rc.contextoEstruturado.telemetria.PAM = 999;
        rc.contextoEstruturado.enquadramentos.push('Inventada');
        assert.deepEqual(entrada, copia, 'a projecao vazou mutacao para a origem');
    });

    console.log('\n[a regra: semantica nao substitui estrutura]');

    await teste('PAM 52 x PAM 82: o valor exato sobrevive dos dois lados', () => {
        const baixa = construirContextoRecuperacao('med', { ...MED, telemetria: { PAM: 52, FC: 128, SpO2: 94 } });
        const normal = construirContextoRecuperacao('med', { ...MED, telemetria: { PAM: 82, FC: 128, SpO2: 94 } });

        // O que a comparacao com limiar le: o numero, nada alem dele.
        assert.equal(baixa.contextoEstruturado.telemetria.PAM, 52);
        assert.equal(normal.contextoEstruturado.telemetria.PAM, 82);
        assert.equal(baixa.contextoEstruturado.telemetria.FC, 128);
        assert.equal(normal.contextoEstruturado.telemetria.FC, 128);

        // O que o embedding le: a diferenca aparece, mas como prosa.
        assert.match(baixa.consultaSemantica, /PAM 52/);
        assert.match(normal.consultaSemantica, /PAM 82/);
        assert.notEqual(baixa.consultaSemantica, normal.consultaSemantica);

        // E o valor nunca foi substituido por uma descricao.
        assert.ok(!/hipotens|normotens|baixa|alta/i.test(baixa.consultaSemantica.split('Sinais')[1] ?? ''),
            'o bloco de sinais descreveu o valor em vez de cita-lo');
    });

    console.log('\n[consulta semantica]');

    await teste('8. determinismo: mesma entrada, mesma string', () => {
        const a = montarConsultaSemantica('med', MED);
        const b = montarConsultaSemantica('med', MED);
        assert.equal(a, b);

        // Objetos distintos com o mesmo conteudo produzem a mesma consulta.
        const gemeo: ClinicalContext = {
            intencao: 'avaliar hipotensao persistente',
            paciente: 'PT-2026-0031',
            telemetria: { PAM: 52, FC: 128, SpO2: 94 },
            populacoes: ['Renal_Cronico'],
            farmacosEmUso: ['Noradrenalina']
        };
        assert.equal(montarConsultaSemantica('med', gemeo), a);

        assert.equal(
            a,
            'avaliar hipotensao persistente. Ambiente clinico de terapia intensiva. ' +
                'Populacoes especiais: Renal_Cronico (Renal Cronico). ' +
                'Em infusao neste momento: Noradrenalina. ' +
                'Sinais do paciente: PAM 52, FC 128, SpO2 94'
        );
    });

    await teste('9. sem lixo tecnico: nem ID, nem serializacao, nem nome de campo', () => {
        const consulta = construirContextoRecuperacao('med', MED).consultaSemantica;
        for (const proibido of ['PT-2026-0031', '{', '}', '[', ']', '"', 'undefined', 'null']) {
            assert.ok(
                !consulta.includes(proibido),
                `"${proibido}" apareceu na consulta semantica: ${consulta}`
            );
        }
        for (const campo of ['telemetria', 'intencao', 'farmacosEmUso', 'populacoes', 'dominio']) {
            assert.ok(
                !consulta.includes(campo),
                `o nome de campo "${campo}" vazou para a consulta: ${consulta}`
            );
        }
    });

    await teste('9b. rotulo vazio nao entra: sem estado de curso, sem a frase', () => {
        const consulta = montarConsultaSemantica('med', {
            intencao: 'iniciar sedacao',
            telemetria: { PAM: 70 },
            populacoes: [],
            farmacosEmUso: []
        });
        assert.ok(!consulta.includes('Em infusao'), consulta);
        assert.ok(!consulta.includes('Populacoes especiais'), consulta);
        assert.match(consulta, /Sinais do paciente: PAM 70/);
    });

    await teste('9c. parametrosRelevantes filtra a prosa, nunca a estrutura', () => {
        const rc = construirContextoRecuperacao('med', MED, { parametrosRelevantes: ['PAM'] });
        assert.match(rc.consultaSemantica, /Sinais do paciente: PAM 52$/);
        assert.ok(!rc.consultaSemantica.includes('SpO2'), rc.consultaSemantica);
        // O lado deterministico continua com a telemetria inteira.
        assert.deepEqual(rc.contextoEstruturado.telemetria, { PAM: 52, FC: 128, SpO2: 94 });
    });

    console.log('\n[projecao]');

    await teste('10. campos criticos nao se perdem: a origem continua acessivel', () => {
        const rc: ContextoRecuperacao = construirContextoRecuperacao('med', MED);
        assert.equal(rc.origem, MED, 'a origem precisa ser o proprio contexto do pipeline');
        assert.equal(rc.dominio, 'med');
        assert.equal(rc.intencao, MED.intencao);
        // Tudo que o pipeline usa hoje continua alcancavel por `origem`, sem
        // conversao: e o que torna esta camada uma projecao, e nao uma migracao.
        const origem = rc.origem as ClinicalContext;
        assert.deepEqual(origem.populacoes, ['Renal_Cronico']);
        assert.deepEqual(origem.farmacosEmUso, ['Noradrenalina']);
        assert.equal(origem.paciente, 'PT-2026-0031');
    });

    await teste('10b. fala ausente nao quebra a construcao', () => {
        const rc = construirContextoRecuperacao('fut', { telemetria: { minuto: 12 } });
        assert.equal(rc.intencao, '');
        assert.equal(rc.consultaSemantica, 'Arbitragem de futebol. Leitura da partida: minuto 12');
    });

    console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Falha ao executar os testes:', err);
    process.exit(1);
});
