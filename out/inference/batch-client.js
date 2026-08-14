import * as fs from 'fs';
import * as path from 'path';
async function processBatch() {
    // 1. Gramática EBNF (Esquema de Dados que será enviado para o Outlines no Python)
    const icuEbnfGrammar = `
        ?start: atuacao
        atuacao: "atuacao_bomba { acao " acao " farmaco " farmaco " ajuste_mcg_kg_min " float " via " via " log '" string "' }"
        
        acao: "AUMENTAR_VAZAO" | "REDUZIR_VAZAO" | "MANTER_BLOQUEADO" | "INICIAR_INFUSAO"
        farmaco: "Noradrenalina" | "Vasopressina" | "Propofol"
        via: "ACESSO_CENTRAL" | "ACESSO_PERIFERICO"
        
        float: /[0-9]+\\.[0-9]{1,2}/
        string: /[a-zA-Z0-9_ \\.\\-]+/
    `;
    // 2. Simulando o Ground Truth do Neo4j (Pode ser substituído pela chamada real ao banco)
    const neo4jGroundTruth = `
        1. PAM < 60: Aumento de Propofol PROIBIDO (Hipotensao Severa). Ação: MANTER_BLOQUEADO.
        2. FC > 130 e Nora >= 0.5: Aumento de Noradrenalina PROIBIDO (Fibrilacao). Ação: MANTER_BLOQUEADO.
        3. Ação de resgate sugerida pelo grafo para PAM baixa sem Nora: INICIAR_INFUSAO de Vasopressina a 0.01 no ACESSO_CENTRAL.
        4. Se PAM normal (> 65): Aumento de Propofol PERMITIDO.
    `;
    // 3. Captura o arquivo txt da linha de comando ou do caminho padrão
    const filePath = process.argv[2] || path.join(process.cwd(), 'src', 'examples', 'prompts.txt');
    if (!fs.existsSync(filePath)) {
        console.error(`❌ Arquivo de testes não encontrado em: ${filePath}`);
        return;
    }
    // 4. Lê o arquivo, quebra pelas linhas e ignora linhas vazias
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n').filter(line => line.trim().length > 0);
    console.log(`📋 Encontrados ${lines.length} prompts para análise em lote.\n`);
    // 5. Laço de repetição para inferência em cada prompt
    for (let i = 0; i < lines.length; i++) {
        const userIntent = lines[i].trim();
        console.log(`====================================================`);
        console.log(`🔍 [CENÁRIO ${i + 1}]: "${userIntent}"`);
        const prompt = `You are an autonomous critical care AI. Evaluate telemetry and Ground Truth rules, then output the strict command.
        
        [COMANDO HUMANO]: "${userIntent}"
        
        [NEO4J GROUND TRUTH]:
        ${neo4jGroundTruth}
        
        Generate the strict infusion plan:
        `;
        try {
            const response = await fetch('http://127.0.0.1:8000/generate-constrained', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: prompt, ebnf_grammar: icuEbnfGrammar })
            });
            if (!response.ok)
                throw new Error(`Erro HTTP: ${response.status}`);
            const data = await response.json();
            console.log(`✅ [SAÍDA RESTRITA CML]:`);
            console.log(data.resultado);
            console.log(`\n`);
        }
        catch (error) {
            console.error(`❌ Erro ao processar o Cenário ${i + 1}:`, error);
        }
    }
    console.log(`🎉 Processamento em lote finalizado com sucesso!`);
}
processBatch();
