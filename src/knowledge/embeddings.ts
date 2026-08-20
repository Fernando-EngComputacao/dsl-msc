/**
 * Cliente do endpoint de embedding do motor Python (`POST /embed`).
 *
 * Usado nos dois sentidos da recuperacao por similaridade: `neo4j.ts`/`neo4j-agro.ts`
 * embutem cada Farmaco/Protocolo (ou Produto/Cultura) na sincronizacao, e
 * `graphrag.ts`/`graphrag-agro.ts` embutem a intencao digitada na consulta. Mesmo
 * modelo dos dois lados (ver EMBED_GGUF_* em python_engine/main.py) — vetores
 * comparaveis por similaridade de cosseno.
 */

const ENDPOINT = process.env.SPC_CML_ENDPOINT ?? 'http://127.0.0.1:8000';
const TIMEOUT_MS = Number(process.env.SPC_CML_TIMEOUT_MS ?? 600_000);

/** Dimensao do vetor do bge-m3 (ver EMBED_GGUF_* em python_engine/main.py). */
export const EMBED_DIMENSOES = 1024;

/**
 * Versao tolerante a falha: usada na sincronizacao, onde a ausencia do motor nao
 * deve impedir o resto do grafo de ser gravado — so o no fica sem vetor, e a
 * proxima sincronizacao (com o motor no ar) completa.
 */
export async function embedOpcional(texto: string): Promise<number[] | null> {
    try {
        return await embedTexto(texto);
    } catch (error) {
        console.warn(`   (embedding indisponivel — no ficara sem vetor: ${(error as Error).message})`);
        return null;
    }
}

export async function embedTexto(texto: string): Promise<number[]> {
    let response: Response;
    try {
        response = await fetch(`${ENDPOINT}/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texto }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (error) {
        const causa =
            (error as Error).name === 'TimeoutError'
                ? `sem resposta em ${TIMEOUT_MS / 1000}s (ajuste SPC_CML_TIMEOUT_MS)`
                : (error as Error).message;
        throw new Error(`${ENDPOINT} inacessivel: ${causa}`);
    }
    if (!response.ok) {
        throw new Error(`${ENDPOINT} respondeu ${response.status}: ${await response.text()}`);
    }
    const corpo = (await response.json()) as { vetor: number[] };
    return corpo.vetor;
}
