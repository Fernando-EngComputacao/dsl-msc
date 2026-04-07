import neo4j from 'neo4j-driver';
import { pipeline } from '@xenova/transformers';

// ✅ Conexão com o Neo4j
const driver = neo4j.driver(
    'bolt://localhost:7687',
    neo4j.auth.basic('neo4j', '#Infufg2025') // Ajuste a senha se necessário
);

async function buscarNoGrafo(inputUsuario: string) {
    console.log(`\n🗣️ Input recebido: "${inputUsuario}"`);
    console.log('⏳ Gerando embedding do input...');
    
    // 1. Carrega o extrator e gera o vetor do input
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    const output = await extractor(inputUsuario, { pooling: 'mean', normalize: true });
    const vetorBusca = Array.from(output.data);

    const session = driver.session();

    try {
        console.log('🔍 Buscando regras similares no Neo4j...\n');

        // 2. Consulta Cypher (GraphRAG)
        // Usamos o índice vetorial 'agro_rules_index' criado no passo anterior
        // Buscamos o top 3 resultados (k = 3)
        // O "OPTIONAL MATCH" verifica se a regra está ligada a uma Cultura específica ou se é Global
        const query = `
            CALL db.index.vector.queryNodes('agro_rules_index', 3, $vetorBusca)
            YIELD node AS regra, score
            OPTIONAL MATCH (cultura:Crop)-[:HAS_RULE]->(regra)
            RETURN 
                coalesce(cultura.name, 'Regra Global') AS escopo,
                regra.type AS tipo_regra,
                regra.description AS descricao,
                score
            ORDER BY score DESC
        `;

        const result = await session.run(query, { vetorBusca });

        if (result.records.length === 0) {
            console.log('⚠️ Nenhuma regra encontrada para este input.');
            return;
        }

        console.log('🎯 RESULTADOS ENCONTRADOS NO GRAFO:');
        result.records.forEach((record, index) => {
            const score = record.get('score').toFixed(4); // Grau de semelhança (0 a 1)
            const escopo = record.get('escopo');          // Soja, Milho, Cana ou Global
            const tipo = record.get('tipo_regra');        // SweepRule, BanRule, etc.
            const descricao = record.get('descricao');

            console.log(`\n[${index + 1}] Grau de Confiança: ${score}`);
            console.log(`    🌾 Escopo: ${escopo}`);
            console.log(`    🏷️  Tipo de Regra: ${tipo ?? 'GlobalRule'}`);
            console.log(`    📋 Descrição: ${descricao}`);
        });

    } catch (error) {
        console.error('❌ Erro durante a busca no Neo4j:', error);
    } finally {
        await session.close();
    }
}

// ==========================================
// 🧪 TESTES BASEADOS NO SEU DIAGRAMA (PDF)
// ==========================================
async function runTests() {
    // Teste 1: Simulação do sensor de folha da Cana (deve retornar a regra de estresse hídrico)
    //await buscarNoGrafo("Temperatura alta nas folhas detectada pelo sensor, marcando 41 graus.");
    
    // Teste 2: Simulação do Agrônomo (deve retornar a proibição de misturar glifosato na soja)
     await buscarNoGrafo("Vai chover logo, posso misturar glifosato com mancozebe?");
    
    // Teste 3: Simulação de regra global
    // await buscarNoGrafo("Estou saindo do campo de soja e indo para a cana com o drone.");

    // Fechar a conexão do banco ao terminar
    await driver.close();
}

runTests();