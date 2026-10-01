<script setup lang="ts">
import { computed, ref, watch, type ComponentPublicInstance } from 'vue';
import type { MetricasAvaliacao } from '../api';

/**
 * Os números do MetricasCard em gráficos: a distribuição dos vereditos de cada
 * camada da cascata (sintaxe, semântica, oráculo, LLM Judge), a matriz oráculo
 * × juiz (concordâncias e discordâncias) e as violações de segurança.
 *
 * Cores: os vereditos são ESTADO, então usam a paleta de status documentada
 * (válido = good, inválido = critical), sempre com ícone + rótulo na legenda.
 * Indeterminado fica em azul, ENTRE os dois — verde e vermelho lado a lado se
 * confundem sob deuteranopia (ΔE 4,1); com o azul no meio, o pior par adjacente
 * sob daltonismo é 23,8 (claro) / 25,7 (escuro), validado com o
 * validate_palette. "Sem veredito" é o cinza de de-ênfase (ΔE 9,1 do vermelho).
 */
const props = defineProps<{
    arquitetura?: MetricasAvaliacao;
    baseline?: MetricasAvaliacao;
}>();

type Faixa = 'VALID' | 'UNRESOLVED' | 'INVALID' | 'SEM_VEREDITO';

/** A ordem é a do empilhamento, e é parte da segurança de cor: nunca verde encostado no vermelho. */
const FAIXAS: Array<{ chave: Faixa; rotulo: string; icone: string }> = [
    { chave: 'VALID', rotulo: 'Válido', icone: '✓' },
    { chave: 'UNRESOLVED', rotulo: 'Indeterminado', icone: '?' },
    { chave: 'INVALID', rotulo: 'Inválido', icone: '✕' },
    { chave: 'SEM_VEREDITO', rotulo: 'Sem veredito', icone: '–' }
];
const rotuloDe = (f: Faixa): string => FAIXAS.find(x => x.chave === f)!.rotulo;

interface Segmento { faixa: Faixa; valor: number; detalhe?: string }
interface Barra { chave: string; camada: string; lado: string; total: number; segmentos: Segmento[] }

const lados = computed(() =>
    [
        props.arquitetura ? { nome: 'Arquitetura SPC-CML', curto: 'SPC-CML', m: props.arquitetura } : undefined,
        props.baseline ? { nome: 'Baseline', curto: 'Baseline', m: props.baseline } : undefined
    ].filter((x): x is { nome: string; curto: string; m: MetricasAvaliacao } => !!x)
);
const doisLados = computed(() => lados.value.length === 2);

/** As quatro camadas, na ordem da cascata. Cada uma leva ao que o MetricasCard mostra. */
const CAMADAS: Array<{ nome: string; segmentos: (m: MetricasAvaliacao) => Segmento[] }> = [
    {
        nome: 'Sintaxe',
        segmentos: m => [{ faixa: 'VALID', valor: m.sintaxe.VALID }, { faixa: 'INVALID', valor: m.sintaxe.INVALID }]
    },
    {
        nome: 'Semântica',
        segmentos: m => [
            { faixa: 'VALID', valor: m.semantica.VALID },
            { faixa: 'UNRESOLVED', valor: m.semantica.UNRESOLVED },
            { faixa: 'INVALID', valor: m.semantica.INVALID },
            { faixa: 'SEM_VEREDITO', valor: m.semantica.NOT_EVALUATED, detalhe: 'não avaliada (sem AST)' }
        ]
    },
    {
        nome: 'Oráculo (normativo)',
        segmentos: m => [
            { faixa: 'VALID', valor: m.oraculo.VALID },
            { faixa: 'UNRESOLVED', valor: m.oraculo.UNRESOLVED },
            { faixa: 'INVALID', valor: m.oraculo.INVALID }
        ]
    },
    {
        nome: 'LLM Judge (experimental)',
        segmentos: m => [
            { faixa: 'VALID', valor: m.juiz.VALID },
            { faixa: 'UNRESOLVED', valor: m.juiz.UNRESOLVED },
            { faixa: 'INVALID', valor: m.juiz.INVALID },
            { faixa: 'SEM_VEREDITO', valor: m.juiz.NOT_CALLED + m.juiz.NO_RESPONSE, detalhe: `não chamado ${m.juiz.NOT_CALLED} · sem resposta ${m.juiz.NO_RESPONSE}` }
        ]
    }
];

const grupos = computed(() =>
    CAMADAS.map(c => ({
        camada: c.nome,
        barras: lados.value.map<Barra>(l => ({
            chave: `${c.nome}-${l.curto}`,
            camada: c.nome,
            lado: l.nome,
            total: l.m.total,
            segmentos: c.segmentos(l.m)
        }))
    }))
);

const temDados = computed(() => lados.value.some(l => l.m.total > 0));

const pct = (valor: number, total: number): number => (total > 0 ? Math.round((valor / total) * 100) : 0);
const visiveis = (b: Barra): Segmento[] => b.segmentos.filter(s => s.valor > 0);

// ---------------------------------------------------------------------------
// Rótulo dentro do segmento só quando cabe (medido, nunca cortado): a largura
// real do trilho vem de um ResizeObserver.
// ---------------------------------------------------------------------------

const trilho = ref<HTMLElement | null>(null);
const larguraTrilho = ref(0);

/** Todas as barras têm a mesma largura (mesma grade), então basta medir a primeira. */
function definirTrilho(el: Element | ComponentPublicInstance | null): void {
    trilho.value = el instanceof HTMLElement ? el : null;
}

watch(trilho, (el, _antes, aoLimpar) => {
    if (!el) return;
    larguraTrilho.value = el.clientWidth;
    const observador = new ResizeObserver(entradas => (larguraTrilho.value = entradas[0].contentRect.width));
    observador.observe(el);
    aoLimpar(() => observador.disconnect());
});

function cabeRotulo(s: Segmento, b: Barra): boolean {
    const n = visiveis(b).length;
    const soma = visiveis(b).reduce((acc, x) => acc + x.valor, 0);
    const largura = ((larguraTrilho.value - 2 * (n - 1)) * s.valor) / Math.max(1, soma);
    return largura >= 14 + 7 * String(s.valor).length;
}

// ---------------------------------------------------------------------------
// Matriz oráculo × juiz: mesma escala para os dois lados (comparáveis).
// ---------------------------------------------------------------------------

const VEREDITOS = ['VALID', 'UNRESOLVED', 'INVALID'] as const;
const escalaMatriz = computed(() => Math.max(1, ...lados.value.flatMap(l => Object.values(l.m.pares))));
const NIVEIS = 6;

function celula(m: MetricasAvaliacao, o: string, j: string): number {
    return m.pares[`${o}+${j}`] ?? 0;
}

/** Degrau da rampa sequencial (0..5) para uma contagem > 0. */
function nivel(valor: number): number {
    return Math.min(NIVEIS - 1, Math.ceil((valor / escalaMatriz.value) * NIVEIS) - 1);
}

const semVeredito = (m: MetricasAvaliacao): number => m.juiz.NOT_CALLED + m.juiz.NO_RESPONSE;

// ---------------------------------------------------------------------------
// Tooltip: por marca, no ponteiro e no foco do teclado. Só realça: todo valor
// também está nos rótulos ou na tabela.
// ---------------------------------------------------------------------------

interface Dica { x: number; y: number; aEsquerda: boolean; titulo: string; valor: string; rotulo: string; cor: string; detalhe?: string }
const dica = ref<Dica | null>(null);

function mostrarDica(e: PointerEvent | FocusEvent, conteudo: Omit<Dica, 'x' | 'y' | 'aEsquerda'>): void {
    let x: number, y: number;
    if ('clientX' in e) {
        x = e.clientX;
        y = e.clientY;
    } else {
        const r = (e.target as HTMLElement).getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.top;
    }
    // Perto da borda direita a dica vira para a esquerda do ponteiro, para não sair da tela.
    dica.value = { ...conteudo, x, y, aEsquerda: x > window.innerWidth - 300 };
}
const esconderDica = (): void => {
    dica.value = null;
};

const dicaSegmento = (b: Barra, s: Segmento) => ({
    titulo: doisLados.value ? `${b.camada} · ${b.lado}` : b.camada,
    valor: `${s.valor} de ${b.total} (${pct(s.valor, b.total)}%)`,
    rotulo: rotuloDe(s.faixa),
    cor: `var(--viz-${s.faixa})`,
    detalhe: s.detalhe
});

const ROTULO_VEREDITO: Record<string, string> = { VALID: 'Válido', UNRESOLVED: 'Indeterminado', INVALID: 'Inválido' };

const dicaCelula = (lado: string, o: string, j: string, v: number) => ({
    titulo: doisLados.value ? `Oráculo × LLM Judge · ${lado}` : 'Oráculo × LLM Judge',
    valor: `${v} plano(s)`,
    rotulo: `oráculo ${ROTULO_VEREDITO[o]} · juiz ${ROTULO_VEREDITO[j]}${o === j ? ' (concordância)' : ' (discordância)'}`,
    cor: v > 0 ? `var(--viz-seq-${nivel(v)})` : 'var(--viz-vazio)'
});

// Tabela: o gêmeo acessível de cada gráfico.
const tabela = ref({ camadas: false, matriz: false, violacoes: false });
</script>

<template>
    <section v-if="lados.length > 0" class="viz mt-8" aria-label="Gráficos das métricas da avaliação">
        <div class="mb-3 flex items-center gap-2.5">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="4" y1="20" x2="20" y2="20" />
                    <line x1="7" y1="16" x2="7" y2="10" />
                    <line x1="12" y1="16" x2="12" y2="5" />
                    <line x1="17" y1="16" x2="17" y2="12" />
                </svg>
            </div>
            <div>
                <p class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Gráficos da avaliação</p>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">Os números dos cartões acima, por camada da cascata. O oráculo é o resultado normativo; o LLM Judge, experimental.</p>
            </div>
        </div>

        <p v-if="!temDados" class="rounded-2xl border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400 dark:border-white/10 dark:text-neutral-500">
            Nenhum plano avaliado — sem dados para os gráficos.
        </p>

        <div v-else class="grid gap-4">
            <!-- 1. Vereditos por camada -->
            <figure class="grafico" aria-label="Vereditos por camada">
                <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <p class="titulo">Vereditos por camada</p>
                        <p class="subtitulo">Parte de cada total por veredito, na ordem da cascata{{ doisLados ? ' — arquitetura e baseline lado a lado' : '' }}.</p>
                    </div>
                    <button type="button" class="alternar" @click="tabela.camadas = !tabela.camadas">{{ tabela.camadas ? 'Ver gráfico' : 'Ver tabela' }}</button>
                </div>

                <ul class="legenda" aria-label="Legenda">
                    <li v-for="f in FAIXAS" :key="f.chave">
                        <span class="amostra" :style="{ background: `var(--viz-${f.chave})` }" aria-hidden="true"></span>
                        <span aria-hidden="true" class="icone">{{ f.icone }}</span>{{ f.rotulo }}
                    </li>
                </ul>

                <table v-if="tabela.camadas" class="tabela">
                    <thead>
                        <tr>
                            <th scope="col">Camada</th>
                            <th v-if="doisLados" scope="col">Lado</th>
                            <th v-for="f in FAIXAS" :key="f.chave" scope="col">{{ f.rotulo }}</th>
                            <th scope="col">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="g in grupos" :key="g.camada">
                            <tr v-for="b in g.barras" :key="b.chave">
                                <th scope="row">{{ b.camada }}</th>
                                <td v-if="doisLados">{{ b.lado }}</td>
                                <td v-for="f in FAIXAS" :key="f.chave" class="numero">
                                    {{ b.segmentos.find(s => s.faixa === f.chave)?.valor ?? '—' }}
                                    <span v-if="b.segmentos.find(s => s.faixa === f.chave)?.detalhe" class="detalhe"> ({{ b.segmentos.find(s => s.faixa === f.chave)!.detalhe }})</span>
                                </td>
                                <td class="numero">{{ b.total }}</td>
                            </tr>
                        </template>
                    </tbody>
                </table>

                <div v-else class="grid gap-3">
                    <div v-for="(g, gi) in grupos" :key="g.camada" class="grid gap-1.5">
                        <div v-for="(b, i) in g.barras" :key="b.chave" class="linha-barra">
                            <p class="rotulo-linha">
                                <span v-if="i === 0" class="camada">{{ g.camada }}</span>
                                <span v-if="doisLados" class="lado">{{ b.lado }}</span>
                            </p>
                            <div :ref="gi === 0 && i === 0 ? definirTrilho : undefined" class="trilho" role="group" :aria-label="`${b.camada}${doisLados ? `, ${b.lado}` : ''}`">
                                <span v-if="b.total === 0" class="vazio-barra">sem planos avaliados</span>
                                <button
                                    v-for="(s, k) in visiveis(b)"
                                    :key="s.faixa"
                                    type="button"
                                    class="segmento"
                                    :class="{ fim: k === visiveis(b).length - 1 }"
                                    :style="{ flex: `${s.valor} 1 0%`, background: `var(--viz-${s.faixa})`, color: `var(--viz-rotulo-${s.faixa})` }"
                                    :aria-label="`${rotuloDe(s.faixa)}: ${s.valor} de ${b.total} (${pct(s.valor, b.total)}%)${s.detalhe ? `, ${s.detalhe}` : ''}`"
                                    @pointermove="mostrarDica($event, dicaSegmento(b, s))"
                                    @pointerleave="esconderDica"
                                    @focus="mostrarDica($event, dicaSegmento(b, s))"
                                    @blur="esconderDica"
                                >
                                    <span v-if="cabeRotulo(s, b)" class="valor-segmento">{{ s.valor }}</span>
                                </button>
                            </div>
                            <p class="ponta">{{ pct(b.segmentos.find(s => s.faixa === 'VALID')?.valor ?? 0, b.total) }}% válido</p>
                        </div>
                    </div>
                </div>
            </figure>

            <div class="grid min-w-0 gap-4" :class="doisLados ? '' : 'lg:grid-cols-2'">
                <!-- 2. Matriz oráculo × juiz -->
                <figure class="grafico" aria-label="Oráculo por LLM Judge">
                    <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
                        <div>
                            <p class="titulo">Oráculo × LLM Judge</p>
                            <p class="subtitulo">Planos por par de vereditos. Linhas: oráculo; colunas: juiz. A diagonal é a concordância.</p>
                        </div>
                        <button type="button" class="alternar" @click="tabela.matriz = !tabela.matriz">{{ tabela.matriz ? 'Ver gráfico' : 'Ver tabela' }}</button>
                    </div>

                    <table v-if="tabela.matriz" class="tabela">
                        <thead>
                            <tr>
                                <th v-if="doisLados" scope="col">Lado</th>
                                <th scope="col">Oráculo</th>
                                <th v-for="j in VEREDITOS" :key="j" scope="col">Juiz {{ ROTULO_VEREDITO[j].toLowerCase() }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <template v-for="l in lados" :key="l.nome">
                                <tr v-for="o in VEREDITOS" :key="`${l.nome}-${o}`">
                                    <td v-if="doisLados">{{ l.nome }}</td>
                                    <th scope="row">{{ ROTULO_VEREDITO[o] }}</th>
                                    <td v-for="j in VEREDITOS" :key="j" class="numero">{{ celula(l.m, o, j) }}</td>
                                </tr>
                            </template>
                        </tbody>
                    </table>

                    <div v-else class="grid gap-4" :class="doisLados ? 'sm:grid-cols-2' : ''">
                        <div v-for="l in lados" :key="l.nome" class="min-w-0 overflow-x-auto">
                            <p v-if="doisLados" class="mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">{{ l.nome }}</p>
                            <div class="matriz" role="group" :aria-label="`Oráculo por LLM Judge, ${l.nome}`">
                                <span class="canto" aria-hidden="true">oráculo ↓ · juiz →</span>
                                <span v-for="j in VEREDITOS" :key="`c-${j}`" class="cabeca">{{ ROTULO_VEREDITO[j] }}</span>
                                <template v-for="o in VEREDITOS" :key="`l-${o}`">
                                    <span class="cabeca linha">{{ ROTULO_VEREDITO[o] }}</span>
                                    <button
                                        v-for="j in VEREDITOS"
                                        :key="`${o}-${j}`"
                                        type="button"
                                        class="celula"
                                        :style="
                                            celula(l.m, o, j) > 0
                                                ? { background: `var(--viz-seq-${nivel(celula(l.m, o, j))})`, color: `var(--viz-seq-texto-${nivel(celula(l.m, o, j))})` }
                                                : { background: 'var(--viz-vazio)', color: 'var(--viz-mudo)' }
                                        "
                                        :aria-label="`Oráculo ${ROTULO_VEREDITO[o]}, juiz ${ROTULO_VEREDITO[j]}: ${celula(l.m, o, j)} plano(s)${o === j ? ', concordância' : ''}`"
                                        @pointermove="mostrarDica($event, dicaCelula(l.nome, o, j, celula(l.m, o, j)))"
                                        @pointerleave="esconderDica"
                                        @focus="mostrarDica($event, dicaCelula(l.nome, o, j, celula(l.m, o, j)))"
                                        @blur="esconderDica"
                                    >
                                        <span class="valor-celula">{{ celula(l.m, o, j) }}</span>
                                        <span v-if="o === j" class="marca-diagonal">concorda</span>
                                    </button>
                                </template>
                            </div>
                            <p class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                                concordantes {{ l.m.concordantes }} · discordantes {{ l.m.discordantes }}<template v-if="semVeredito(l.m) > 0"> · juiz sem veredito {{ semVeredito(l.m) }} (fora da matriz)</template>
                            </p>
                        </div>
                    </div>

                    <div v-if="!tabela.matriz" class="escala" aria-hidden="true">
                        <span>menos</span>
                        <span v-for="n in NIVEIS" :key="n" class="degrau" :style="{ background: `var(--viz-seq-${n - 1})` }"></span>
                        <span>mais planos (escala comum: máx. {{ escalaMatriz }})</span>
                    </div>
                </figure>

                <!-- 3. Violações -->
                <figure class="grafico" aria-label="Violações de segurança">
                    <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
                        <div>
                            <p class="titulo">Violações de segurança</p>
                            <p class="subtitulo">Planos com incremento num item bloqueado ou vetado pelo cenário, lido do AST.</p>
                        </div>
                        <button type="button" class="alternar" @click="tabela.violacoes = !tabela.violacoes">{{ tabela.violacoes ? 'Ver gráfico' : 'Ver tabela' }}</button>
                    </div>

                    <table v-if="tabela.violacoes" class="tabela">
                        <thead>
                            <tr><th scope="col">Lado</th><th scope="col">Violações</th><th scope="col">Total avaliado</th><th scope="col">%</th></tr>
                        </thead>
                        <tbody>
                            <tr v-for="l in lados" :key="l.nome">
                                <th scope="row">{{ l.nome }}</th>
                                <td class="numero">{{ l.m.violacoes }}</td>
                                <td class="numero">{{ l.m.total }}</td>
                                <td class="numero">{{ pct(l.m.violacoes, l.m.total) }}%</td>
                            </tr>
                        </tbody>
                    </table>

                    <div v-else class="grid gap-4">
                        <div v-for="l in lados" :key="l.nome">
                            <div class="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
                                <span class="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
                                    <span aria-hidden="true" class="icone">⚠</span>{{ l.nome }}
                                </span>
                                <span class="text-neutral-800 dark:text-neutral-100"><strong class="text-sm font-semibold">{{ l.m.violacoes }}</strong> de {{ l.m.total }} ({{ pct(l.m.violacoes, l.m.total) }}%)</span>
                            </div>
                            <div
                                class="medidor"
                                role="meter"
                                :aria-valuenow="l.m.violacoes"
                                aria-valuemin="0"
                                :aria-valuemax="l.m.total"
                                :aria-label="`Violações de segurança, ${l.nome}: ${l.m.violacoes} de ${l.m.total}`"
                                @pointermove="mostrarDica($event, { titulo: `Violações · ${l.nome}`, valor: `${l.m.violacoes} de ${l.m.total} (${pct(l.m.violacoes, l.m.total)}%)`, rotulo: 'incremento em item bloqueado ou vetado', cor: 'var(--viz-INVALID)' })"
                                @pointerleave="esconderDica"
                            >
                                <span v-if="l.m.violacoes > 0" class="preenchido" :style="{ width: `${(l.m.violacoes / Math.max(1, l.m.total)) * 100}%` }"></span>
                            </div>
                        </div>
                    </div>
                </figure>
            </div>
        </div>

        <!-- Tooltip: valor primeiro, rótulo depois; a cor só na chave de linha. -->
        <div v-if="dica" class="dica" :class="{ 'a-esquerda': dica.aEsquerda }" :style="{ left: `${dica.x}px`, top: `${dica.y}px` }" role="tooltip">
            <p class="dica-titulo">{{ dica.titulo }}</p>
            <p class="dica-valor">{{ dica.valor }}</p>
            <p class="dica-rotulo"><span class="chave" :style="{ background: dica.cor }" aria-hidden="true"></span>{{ dica.rotulo }}</p>
            <p v-if="dica.detalhe" class="dica-detalhe">{{ dica.detalhe }}</p>
        </div>
    </section>
</template>

<style scoped>
/* Papéis de cor (paleta de referência do dataviz; modo escuro sob .dark, que é como o app troca o tema). */
.viz {
    --viz-superficie: #fcfcfb;
    --viz-texto: #0b0b0b;
    --viz-texto-2: #52514e;
    --viz-mudo: #898781;
    --viz-grade: #e1e0d9;
    --viz-borda: rgba(11, 11, 11, 0.1);
    --viz-vazio: #f0efec;

    /* Vereditos, na ordem do empilhamento. Rótulo interno: tinta ou branco, pelo contraste com o preenchimento. */
    --viz-VALID: #0ca30c;
    --viz-UNRESOLVED: #2a78d6;
    --viz-INVALID: #d03b3b;
    --viz-SEM_VEREDITO: #898781;
    --viz-rotulo-VALID: #0b0b0b;
    --viz-rotulo-UNRESOLVED: #ffffff;
    --viz-rotulo-INVALID: #ffffff;
    --viz-rotulo-SEM_VEREDITO: #0b0b0b;

    /* Sequencial azul (um matiz), claro -> escuro; ordinal, então o degrau mais claro ainda passa 2:1 (250). */
    --viz-seq-0: #86b6ef;
    --viz-seq-1: #5598e7;
    --viz-seq-2: #2a78d6;
    --viz-seq-3: #1c5cab;
    --viz-seq-4: #104281;
    --viz-seq-5: #0d366b;
    --viz-seq-texto-0: #0b0b0b;
    --viz-seq-texto-1: #0b0b0b;
    --viz-seq-texto-2: #ffffff;
    --viz-seq-texto-3: #ffffff;
    --viz-seq-texto-4: #ffffff;
    --viz-seq-texto-5: #ffffff;
}

.dark .viz {
    --viz-superficie: #1a1a19;
    --viz-texto: #ffffff;
    --viz-texto-2: #c3c2b7;
    --viz-grade: #2c2c2a;
    --viz-borda: rgba(255, 255, 255, 0.1);
    --viz-vazio: #2c2c2a;

    --viz-UNRESOLVED: #3987e5;
    --viz-rotulo-UNRESOLVED: #0b0b0b;

    /* No escuro a âncora inverte: pouco = perto da superfície (o mais escuro que ainda passa 2:1), muito = claro. */
    --viz-seq-0: #184f95;
    --viz-seq-1: #256abf;
    --viz-seq-2: #3987e5;
    --viz-seq-3: #6da7ec;
    --viz-seq-4: #9ec5f4;
    --viz-seq-5: #cde2fb;
    --viz-seq-texto-0: #ffffff;
    --viz-seq-texto-1: #ffffff;
    --viz-seq-texto-2: #0b0b0b;
    --viz-seq-texto-3: #0b0b0b;
    --viz-seq-texto-4: #0b0b0b;
    --viz-seq-texto-5: #0b0b0b;
}

.grafico {
    min-width: 0;
    margin: 0;
    border: 1px solid var(--viz-borda);
    border-radius: 1rem;
    background: var(--viz-superficie);
    padding: 1.25rem;
    color: var(--viz-texto);
}
.titulo {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--viz-texto);
}
.subtitulo {
    font-size: 0.75rem;
    color: var(--viz-texto-2);
}
.alternar {
    border: 1px solid var(--viz-borda);
    border-radius: 9999px;
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    color: var(--viz-texto-2);
}
.alternar:hover {
    background: var(--viz-vazio);
}

.legenda {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    margin-bottom: 0.875rem;
    font-size: 0.75rem;
    color: var(--viz-texto-2);
}
.legenda li {
    display: flex;
    align-items: center;
    gap: 0.375rem;
}
.amostra {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 2px;
}
.icone {
    color: var(--viz-texto-2);
    font-size: 0.7rem;
    width: 0.75rem;
    text-align: center;
}

/* Barras: rótulo | trilho | ponta. Espessura 20px (<= 24px), 2px de superfície entre segmentos, ponta de dados arredondada. */
.linha-barra {
    display: grid;
    grid-template-columns: minmax(7rem, 11rem) 1fr 5.5rem;
    align-items: center;
    gap: 0.75rem;
}
@media (max-width: 640px) {
    .linha-barra {
        grid-template-columns: 1fr 4.5rem;
    }
    .rotulo-linha {
        grid-column: 1 / -1;
    }
}
.rotulo-linha {
    display: flex;
    flex-direction: column;
    font-size: 0.75rem;
    line-height: 1.2;
}
.camada {
    color: var(--viz-texto);
    font-weight: 500;
}
.lado {
    color: var(--viz-mudo);
}
.trilho {
    display: flex;
    gap: 2px;
    height: 20px;
    min-width: 0;
}
.vazio-barra {
    font-size: 0.7rem;
    color: var(--viz-mudo);
    align-self: center;
}
.segmento {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    font-size: 0.7rem;
    font-weight: 600;
    cursor: default;
    transition: filter 0.15s ease;
}
.segmento.fim {
    border-top-right-radius: 4px;
    border-bottom-right-radius: 4px;
}
.segmento:hover,
.segmento:focus-visible {
    filter: brightness(1.12);
}
.segmento:focus-visible,
.celula:focus-visible {
    outline: 2px solid var(--viz-texto);
    outline-offset: 2px;
}
.valor-segmento {
    white-space: nowrap;
}
.ponta {
    font-size: 0.75rem;
    color: var(--viz-texto-2);
    text-align: right;
}

/* Matriz: cabeçalhos + 3x3, 2px de superfície entre células. */
.matriz {
    display: grid;
    grid-template-columns: minmax(5.5rem, auto) repeat(3, minmax(5rem, 1fr));
    gap: 2px;
    font-size: 0.7rem;
}
.canto {
    align-self: end;
    color: var(--viz-mudo);
    font-size: 0.65rem;
    padding: 0 0.25rem 0.25rem 0;
}
.cabeca {
    color: var(--viz-texto-2);
    text-align: center;
    align-self: end;
    padding-bottom: 0.25rem;
}
.cabeca.linha {
    text-align: right;
    align-self: center;
    padding: 0 0.5rem 0 0;
}
.celula {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 3rem;
    border: 0;
    border-radius: 4px;
    cursor: default;
    transition: filter 0.15s ease;
}
.celula:hover {
    filter: brightness(1.1);
}
.valor-celula {
    font-size: 0.875rem;
    font-weight: 600;
}
.marca-diagonal {
    font-size: 0.6rem;
    opacity: 0.85;
}
.escala {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-top: 0.875rem;
    font-size: 0.65rem;
    color: var(--viz-mudo);
}
.escala > span:first-child {
    margin-right: 0.375rem;
}
.escala > span:last-child {
    margin-left: 0.375rem;
}
.degrau {
    width: 1rem;
    height: 0.625rem;
    border-radius: 2px;
}

/* Medidor: preenchimento = inválido; trilho = um degrau mais claro do mesmo matiz. */
.medidor {
    height: 10px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--viz-INVALID) 16%, var(--viz-superficie));
    overflow: hidden;
}
.preenchido {
    display: block;
    height: 100%;
    background: var(--viz-INVALID);
    border-radius: 0 4px 4px 0;
}

/* Tabela: o gêmeo acessível. */
.tabela {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
    color: var(--viz-texto);
}
.tabela th,
.tabela td {
    border-bottom: 1px solid var(--viz-grade);
    padding: 0.375rem 0.5rem;
    text-align: left;
}
.tabela thead th {
    color: var(--viz-texto-2);
    font-weight: 500;
}
.tabela .numero {
    text-align: right;
    font-variant-numeric: tabular-nums;
}
.detalhe {
    color: var(--viz-mudo);
}

.dica {
    position: fixed;
    z-index: 50;
    transform: translate(12px, calc(-100% - 12px));
    pointer-events: none;
    min-width: 9rem;
    max-width: 16rem;
    border: 1px solid var(--viz-borda);
    border-radius: 0.5rem;
    background: var(--viz-superficie);
    padding: 0.5rem 0.625rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    font-size: 0.7rem;
    color: var(--viz-texto-2);
}
.dica.a-esquerda {
    transform: translate(calc(-100% - 12px), calc(-100% - 12px));
}
.dica-titulo {
    color: var(--viz-mudo);
}
.dica-valor {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--viz-texto);
}
.dica-rotulo {
    display: flex;
    align-items: center;
    gap: 0.375rem;
}
.chave {
    width: 0.75rem;
    height: 2px;
    border-radius: 1px;
}
.dica-detalhe {
    color: var(--viz-mudo);
}
</style>
