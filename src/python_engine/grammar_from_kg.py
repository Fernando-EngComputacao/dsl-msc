"""
Motor de Recuperação Determinística (SPC-CML)
Recorta a gramática completa G com base nas restrições fornecidas pelo Neo4j (GraphRAG),
gerando a gramática especializada G_hat (Ĝ).
"""
from bnf import Rule

def gramatica_do_subgrafo(subgrafo: dict, rules: dict[str, Rule]) -> str:
    """
    subgrafo: dicionário com as permissões filtradas pelo Neo4j. Exemplo de entrada:
      {
         "acoes_permitidas": ["MANTER_BLOQUEADO", "INICIAR_INFUSAO"],
         "farmacos_liberados": ["Vasopressina", "Propofol", "Noradrenalina"],
         "vias_disponiveis": ["ACESSO_CENTRAL"]
      }

    Retorna G_hat em BNF: subconjunto da gramática G podado pelas restrições do domínio.
    Violações médicas tornam-se sintaticamente inexprimíveis para o LLM.
    """
    
    # 1. Mapeamento do vocabulário da UTI (Esquema de Dados)
    poda = {
        "tipo_acao": subgrafo.get("acoes_permitidas"),
        "tipo_farmaco": subgrafo.get("farmacos_liberados"),
        "tipo_via": subgrafo.get("vias_disponiveis"),
    }
    
    podadas: dict[str, list[str]] = {}
    
    # 2. Filtragem das alternativas de cada regra
    for nome, r in rules.items():
        # Se for uma regra RegEx ou terminal simples, mantém intacta
        if r.regex is not None:
            podadas[nome] = [f"/{r.regex}/"]
            continue
        
        alts = [" ".join(a) for a in r.alts]
        permitidos = poda.get(nome)
        
        # Se a regra atual estiver na nossa lista de poda (ações, fármacos, vias)
        if permitidos:
            # Mantém apenas as alternativas que contêm algum dos termos permitidos
            alts = [a for a in alts if any(p in a for p in permitidos)]
            
        # Adiciona a regra podada se ainda sobrar alguma alternativa válida
        if alts:
            podadas[nome] = alts

    # 3. Varredura: remove produções que se tornaram inalcançáveis a partir da raiz ('plano')
    alcancaveis = set()
    fila = ["plano"]  # Nó raiz definido no seu arquivo advanced_icu.bnf
    
    while fila:
        n = fila.pop()
        
        # Ignora se já foi visitado ou se foi podado inteiramente
        if n in alcancaveis or n not in podadas:
            continue
            
        alcancaveis.add(n)
        
        # Pega as alternativas válidas desta regra
        for alt in podadas[n]:
            # Quebra a alternativa em símbolos individuais
            for sim in alt.replace("+", " ").split():
                # Se não for uma string literal (ex: "AUMENTAR") nem regex (ex: /[0-9]/), é um não-terminal
                if not sim.startswith('"') and not sim.startswith("/"):
                    fila.append(sim)

    # 4. Monta a string final da gramática especializada Ĝ (G_hat)
    linhas_g_hat = []
    
    # Itera sobre a gramática original para manter a ordem estrutural correta
    for n in rules:
        if n in alcancaveis:
            linhas_g_hat.append(f"{n} ::= " + " | ".join(podadas[n]))
            
    return "\n".join(linhas_g_hat)