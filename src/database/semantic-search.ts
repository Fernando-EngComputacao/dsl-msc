import neo4j from 'neo4j-driver';
import { pipeline } from '@xenova/transformers';

const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '#Infufg2025')
);

interface LeituraSensores {
    cultura_identificada: string;
    temperatura: number;
    vento_kmh: number;
    umidade: number;
    observacao_texto: string;
}

async function motorDeDecisaoDrone(dados: LeituraSensores) {
    console.log(`\n🛸 RECEBENDO INPUT DO DRONE E DO PEÃO...`);
    
    // 1. EMBEDDING: Transforma o input em vetor
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    const textoBusca = `${dados.observacao_texto}. Clima: T=${dados.temperatura}C, Vento=${dados.vento_kmh}km/h, Umidade=${dados.umidade}%`;
    const output = await extractor(textoBusca, { pooling: 'mean', normalize: true });
    const vetorBusca = Array.from(output.data);

    const session = driver.session();
    let regrasRecuperadas: string[] = [];

    try {
        // 2. CONSULTA KG: Busca apenas as regras da cultura identificada
        const query = `
            CALL db.index.vector.queryNodes('agro_rules_index', 5, $vetorBusca)
            YIELD node AS regra, score
            OPTIONAL MATCH (cultura:Crop)-[:HAS_RULE]->(regra)
            WITH regra, score, coalesce(cultura.name, 'Regra Global') AS escopo
            WHERE escopo = $culturaAlvo OR escopo = 'Regra Global'
            RETURN regra.description AS descricao
        `;

        const result = await session.run(query, { vetorBusca, culturaAlvo: dados.cultura_identificada });
        regrasRecuperadas = result.records.map(record => record.get('descricao'));

        if (regrasRecuperadas.length === 0) {
            console.log('⚠️ Nenhuma regra encontrada no Grafo para avaliar.');
            return;
        }

        // 3. PROMPTING (LLM Gramatics DSL): Cruzando dados do sensor com as regras do Grafo
        console.log('🧠 Enviando contexto para o LLM (Tomada de Decisão)...\n');
        
        const promptEstruturado = `
            Você é o sistema autônomo de um Drone Agrícola.
            Sua missão é avaliar os dados dos sensores e decidir se o drone pode executar a ordem do usuário, baseando-se EXCLUSIVAMENTE nas Regras Extraídas do Grafo de Conhecimento.

            [DADOS DOS SENSORES]
            Cultura: ${dados.cultura_identificada}
            Temperatura: ${dados.temperatura}°C
            Vento: ${dados.vento_kmh} km/h
            Umidade: ${dados.umidade}%
            Pedido do operador: "${dados.observacao_texto}"

            [REGRAS EXTRAÍDAS DO GRAFO PARA ESSA CULTURA]
            ${regrasRecuperadas.map(r => `- ${r}`).join('\n')}

            [FORMATO DE SAÍDA EXIGIDO - JSON]
            Analise os dados. Retorne um JSON com:
            "status": "PERMITIDO" ou "RECUSADO"
            "motivo": Explicar o cruzamento lógico das regras com os sensores.
            "acao_drone": O que o drone deve fazer agora (ex: retornar a base, aplicar produto X).
            `;

        console.log("================ PROMPT GERADO ================");
        console.log(promptEstruturado);
        console.log("===============================================\n");

        // 4. CHAMADA AO LLM (Aqui você usaria openai.chat.completions.create, etc.)
        const respostaLLM = await simularChamadaLLM(promptEstruturado, dados);
        
        console.log('✅ DECISÃO FINAL DO SISTEMA (Retorno do LLM):');
        console.log(JSON.stringify(respostaLLM, null, 2));

    } catch (error) {
        console.error('❌ Erro no motor de decisão:', error);
    } finally {
        await session.close();
    }
}

// Função simulando a "inteligência" de um LLM lendo o prompt acima
async function simularChamadaLLM(prompt: string, sensores: LeituraSensores) {
    // A IA faria esse raciocínio matematico/lógico:
    if (sensores.cultura_identificada === 'Cana_de_Acucar' && sensores.temperatura > 32) {
        return {
            status: "RECUSADO",
            motivo: `A temperatura atual é ${sensores.temperatura}°C, o que viola a Regra Climática da Cana que exige T < 32°C. Além disso, o sensor foliar indica estresse hídrico. A aplicação nestas condições causaria fitotoxicidade grave ou perda do produto por evaporação rápida.`,
            acao_drone: "Abortar missão. Registrar log de estresse hídrico no sistema e retornar para a base."
        };
    }
    
    return {
        status: "PERMITIDO",
        motivo: "Todos os parâmetros climáticos e as regras de restrição foram respeitados.",
        acao_drone: "Iniciar aplicação seguindo a vazão cadastrada na DSL."
    };
}

// 🧪 EXECUTANDO SEU TESTE
async function run() {
    const leituraCana: LeituraSensores = {
        cultura_identificada: "Cana_de_Acucar",
        temperatura: 41.5, // ⚠️ Acima do limite da regra (32C)!
        vento_kmh: 5,
        umidade: 40,
        observacao_texto: "Aplique veneno na cultura"
    };

    await motorDeDecisaoDrone(leituraCana);
    await driver.close();
}

run();