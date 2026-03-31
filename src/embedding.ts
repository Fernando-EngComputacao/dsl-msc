import { pipeline } from '@xenova/transformers';

async function gerarVetores() {
    console.log('⏳ Carregando o modelo (baixando na 1ª vez)...');
    
    // O pipeline 'feature-extraction' é o responsável por gerar embeddings
    // Usamos a versão do all-MiniLM-L6-v2 convertida para ONNX (Xenova)
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    
    console.log('✅ Modelo carregado!\n');

    // Textos que queremos converter para matemática
    const textos = [
        "A fumaça indica fogo na Fazenda Vale Verde.",
        "Incêndio detectado perto das placas solares.",
        "O drone precisa retornar para a base devido à tempestade."
    ];

    for (const texto of textos) {
        // Gera o vetor. 
        // pooling: 'mean' e normalize: true são os padrões matemáticos recomendados para busca (Cosine Similarity)
        const output = await extractor(texto, { pooling: 'mean', normalize: true });
        
        // output.data contém o Float32Array com as 384 dimensões
        const vetor = Array.from(output.data);
        
        console.log(`Texto: "${texto}"`);
        console.log(`Tamanho do Vetor: ${vetor.length} dimensões`);
        console.log(`Primeiros 5 números: [${vetor.slice(0, 5).map(n => n.toFixed(4)).join(', ')}...]\n`);
    }
}

gerarVetores();