export async function runCMLInference() {
    // 1. Definição do Esquema de Dados em formato EBNF (Grammar Prompting)
    const icuEbnfGrammar = `
        ?start: atuacao
        atuacao: "atuacao_bomba { acao " acao " farmaco " farmaco " ajuste_mcg_kg_min " float " via " via " log '" string "' }"
        
        acao: "AUMENTAR_VAZAO" | "REDUZIR_VAZAO" | "MANTER_BLOQUEADO" | "INICIAR_INFUSAO"
        farmaco: "Noradrenalina" | "Vasopressina" | "Propofol"
        via: "ACESSO_CENTRAL" | "ACESSO_PERIFERICO"
        
        float: /[0-9]+\\.[0-9]{1,2}/
        string: /[a-zA-Z0-9_ \\.\\-]+/
    `;
    // 2. Simulação de Contexto (O que seria a saída do seu Neo4j.ts e sensores)
    const userIntent = "A pressão tá despencando (PAM=52), sobe a nora urgente e aprofunda o propofol!";
    const neo4jGroundTruth = `
        1. PAM < 60: Aumento de Propofol PROIBIDO (Hipotensao Severa). Ação: MANTER_BLOQUEADO.
        2. FC > 130 e Nora >= 0.5: Aumento de Noradrenalina PROIBIDO (Fibrilacao). Ação: MANTER_BLOQUEADO.
        3. Ação de resgate sugerida pelo grafo: INICIAR_INFUSAO de Vasopressina a 0.01 no ACESSO_CENTRAL.
    `;
    // 3. Montagem do Prompt
    const prompt = `You are an autonomous critical care AI. Evaluate telemetry and Ground Truth rules, then output the strict command.
    
    [COMANDO HUMANO]: "${userIntent}"
    
    [NEO4J GROUND TRUTH]:
    ${neo4jGroundTruth}
    
    Generate the strict infusion plan:
    `;
    console.log("⏳ Enviando prompt e Gramática EBNF para o motor Python...");
    // 4. Requisição HTTP
    try {
        const response = await fetch('http://127.0.0.1:8000/generate-constrained', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt, ebnf_grammar: icuEbnfGrammar })
        });
        if (!response.ok)
            throw new Error(`HTTP error: ${response.status}`);
        const data = await response.json();
        console.log("\n✅ Comando Restrito Gerado (Sem Alucinações):");
        console.log(data.resultado);
    }
    catch (error) {
        console.error("❌ Erro na inferência:", error);
    }
}
runCMLInference();
