/**
 * Verificacao do pareamento entre o ground truth e o arquivo de resultados
 * enviado na tela "Avaliar resultados".
 * Executar: npx tsx src/test/avaliar.test.ts
 *
 * O criterio de sucesso: cada cenario do gabarito e conferido contra a resposta
 * DAQUELE cenario, independente da ordem, da numeracao ou da completude do
 * arquivo enviado. Parear por posicao/numero de linha (como era feito antes)
 * comparava a linha N do gabarito com um cenario qualquer do arquivo, e o
 * veredicto saia certo ou errado por acaso — ver o caso [6] abaixo.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { compararDetalhado, parear, type RegistroGroundTruth, type RegistroAvaliar } from '../inference/avaliar.js';

const GROUND_TRUTH = path.join('src', 'examples', 'med', 'ground_truth_med.jsonl');

function carregar(): RegistroGroundTruth[] {
    return fs
        .readFileSync(GROUND_TRUTH, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l) as RegistroGroundTruth);
}

/** O gabarito convertido no "resultado perfeito" que alguem subiria. */
function comoUpload(r: RegistroGroundTruth): RegistroAvaliar {
    return {
        linha: r.linha,
        intencao: r.intencao,
        valido: r.valido,
        plano: r.plano,
        telemetria: r.telemetria as RegistroAvaliar['telemetria']
    };
}

function pacienteDe(reg: { telemetria?: unknown }): string | undefined {
    return (reg.telemetria as { paciente?: string } | undefined)?.paciente;
}

function main(): number {
    const gt = carregar();
    let falhas = 0;

    /** Um upload perfeito tem que pontuar 100% — se pontuar menos, o pareamento
     *  encostou a resposta certa no cenario errado. */
    const perfeito = (nome: string, upload: RegistroAvaliar[], esperado: number): void => {
        const r = compararDetalhado(gt, upload, undefined);
        const m = r.arquitetura!;
        const ok = m.total === esperado && m.semanticaCorreta === esperado && m.sintaxeCorreta === esperado && m.violacoes === 0 && r.naoPareados === 0;
        console.log(
            `      ${ok ? 'OK   ' : 'FALHA'} ${nome.padEnd(44)} total=${m.total} sem=${m.semanticaCorreta} sin=${m.sintaxeCorreta} viol=${m.violacoes} naoPareados=${r.naoPareados}`
        );
        if (!ok) falhas++;
    };

    console.log(`[1] Gabarito carregado: ${gt.length} cenarios`);
    const enunciados = new Set(gt.map(r => r.intencao));
    const pacientes = new Set(gt.map(pacienteDe));
    console.log(`      enunciados distintos: ${enunciados.size} (${gt.length - enunciados.size} registros com enunciado repetido)`);
    console.log(`      pacientes distintos:  ${pacientes.size}${pacientes.size === gt.length ? ' (unico por cenario)' : ' — ATENCAO: nao e unico'}`);

    console.log('[2] Upload perfeito, na ordem original:');
    perfeito('ordem original', gt.map(comoUpload), gt.length);

    console.log('[3] Upload perfeito, fora de ordem:');
    const embaralhado = [...gt].map(comoUpload).sort(() => Math.random() - 0.5);
    perfeito('embaralhado', embaralhado, gt.length);

    console.log('[4] Sem o campo `linha` (so enunciado + identificador):');
    perfeito('embaralhado, sem `linha`', embaralhado.map(({ linha, ...resto }) => resto), gt.length);

    console.log('[5] Lote parcial (subconjunto fora de ordem):');
    perfeito('subconjunto de 80', embaralhado.slice(0, 80), 80);

    console.log('[6] Lote real: `linha` renumerado 1..N pela ordem do proprio lote');
    console.log('    (e o que rodarLote grava; por isso `linha` nao serve de chave)');
    const loteReal = embaralhado.slice(0, 60).map((r, i) => ({ ...r, linha: i + 1 }));
    const desalinhados = loteReal.filter((r, i) => gt[i] && pacienteDe(gt[i]) !== pacienteDe(r)).length;
    console.log(`      pareando por \`linha\`, ${desalinhados}/60 cairiam no cenario errado`);
    perfeito('lote renumerado 1..60', loteReal, 60);

    console.log('[7] So o enunciado (sem identificador e sem `linha`):');
    console.log('    exercita o desempate por ordem de ocorrencia nos repetidos');
    perfeito('so enunciado', gt.map(r => ({ intencao: r.intencao, valido: r.valido, plano: r.plano })), gt.length);

    console.log('[8] Arquivo de outro dominio: nada deve casar');
    const alheio: RegistroAvaliar[] = [
        { intencao: 'Vento forte, manda o glifosato na soja.', plano: 'missao X { }' },
        { intencao: 'NDVI despencou no talhao.', plano: 'missao Y { }' }
    ];
    const rAlheio = compararDetalhado(gt, alheio, undefined);
    const okAlheio = rAlheio.arquitetura!.total === 0 && rAlheio.naoPareados === 2;
    console.log(`      ${okAlheio ? 'OK   ' : 'FALHA'} ${'nenhum par, 2 nao pareados'.padEnd(44)} total=${rAlheio.arquitetura!.total} naoPareados=${rAlheio.naoPareados}`);
    if (!okAlheio) falhas++;

    console.log('[9] Telemetria faz parte da chave: mesmo paciente, outro quadro');
    console.log('    (o gabarito e derivado da telemetria; com outros sinais nao se aplica)');
    const alterado = [comoUpload(gt[0])].map(r => ({
        ...r,
        telemetria: { ...r.telemetria!, telemetria: { ...(r.telemetria as { telemetria: Record<string, number> }).telemetria, PAM: 200, glicemia: 999 } }
    }));
    const rAlterado = compararDetalhado(gt, alterado, undefined);
    const okAlterado = rAlterado.arquitetura!.total === 0 && rAlterado.telemetriaDivergente === 1 && rAlterado.naoPareados === 0;
    console.log(
        `      ${okAlterado ? 'OK   ' : 'FALHA'} ${'nao pareia, sinaliza divergencia'.padEnd(44)} total=${rAlterado.arquitetura!.total} telemetriaDivergente=${rAlterado.telemetriaDivergente}`
    );
    if (!okAlterado) falhas++;

    console.log('[10] Registro fora do conjunto de cenarios (ex.: demo do llm-client)');
    const foraDoConjunto: RegistroAvaliar[] = [
        {
            linha: 1,
            intencao: 'A pressao ta despencando (PAM=52), sobe a nora urgente e aprofunda o propofol!',
            valido: true,
            telemetria: {
                paciente: 'PT-2026-0031',
                telemetria: { PAM: 52, FC: 145, lactato: 4.8, RASS: 2, TFG: 28, plaquetas: 45, glicemia: 210, SpO2: 94 }
            } as RegistroAvaliar['telemetria'],
            plano: 'plano X para Choque_Septico { ordem Noradrenalina decisao INICIAR_INFUSAO dose 0.25 mcg/kg/min via ACESSO_CENTRAL justificativa "x" }'
        }
    ];
    const rFora = compararDetalhado(gt, foraDoConjunto, undefined);
    const okFora = rFora.arquitetura!.total === 0 && rFora.naoPareados === 1;
    console.log(`      ${okFora ? 'OK   ' : 'FALHA'} ${'PT-2026-0031 nao esta nos 500 cenarios'.padEnd(44)} total=${rFora.arquitetura!.total} naoPareados=${rFora.naoPareados}`);
    if (!okFora) falhas++;

    console.log('[11] Propriedade central: todo par aponta pro cenario correto');
    const { pares } = parear(gt, embaralhado);
    const errados = pares.filter(p => pacienteDe(p.gt) !== pacienteDe(p.registro));
    console.log(`      ${errados.length === 0 ? 'OK   ' : 'FALHA'} ${pares.length} pares, ${errados.length} apontando pro paciente errado`);
    if (errados.length > 0) falhas++;

    console.log(`\nRESULTADO: ${falhas === 0 ? 'OK' : `${falhas} falha(s)`}`);
    return falhas === 0 ? 0 : 1;
}

process.exit(main());
