/**
 * Transporte comum das chamadas da avaliação ao motor do domínio
 * (`/validar-plano`, `/diagnosticar-indeterminacao`): um POST JSON com o mesmo
 * tratamento de timeout e cancelamento. `sinal` cancela a chamada em andamento
 * e o erro original sobe intacto — quem chama distingue cancelamento de falha
 * por `sinal.aborted`. Timeout, motor inacessível e resposta não-2xx viram
 * `Error` com a causa; o corpo da resposta de erro vai na mensagem.
 */
export async function postarJsonNoMotor(motor: string, rota: string, corpo: unknown, timeoutMs: number, sinal: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combinado = new AbortController();
    const abortar = (): void => combinado.abort();
    timeout.addEventListener('abort', abortar);
    sinal.addEventListener('abort', abortar);

    let response: Response;
    try {
        response = await fetch(`${motor}${rota}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(corpo),
            signal: combinado.signal
        });
    } catch (error) {
        if (sinal.aborted) throw error;
        const causa = timeout.aborted ? `sem resposta em ${timeoutMs / 1000}s` : (error as Error).message;
        throw new Error(`motor (${motor}) inacessivel: ${causa}`);
    } finally {
        timeout.removeEventListener('abort', abortar);
        sinal.removeEventListener('abort', abortar);
    }
    if (!response.ok) {
        throw new Error(`motor respondeu ${response.status}: ${await response.text()}`);
    }
    return response.json();
}
