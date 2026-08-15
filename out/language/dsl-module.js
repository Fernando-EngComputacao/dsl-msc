import { createDefaultCoreModule, createDefaultSharedCoreModule, inject, EmptyFileSystem, DefaultScopeProvider, EMPTY_SCOPE } from 'langium';
import { DslGeneratedModule, dslProjectGeneratedSharedModule } from '../generated/module.js';
import { isPlanCommand } from '../generated/ast.js';
/**
 * Escopo do Esquema de Dados.
 *
 * As condutas (`conduta`) sao declaradas dentro de um `esquema_dados`, e nao no
 * escopo global. Um `plano` so pode citar condutas do esquema que ele mesmo
 * referencia — o que faz do Esquema de Dados um universo fechado tambem no nivel
 * de resolucao de nomes, e nao apenas no nivel sintatico.
 *
 * Consequencia para a arquitetura: uma conduta alucinada pelo LLM falha na
 * ligacao de referencias mesmo que passe pela gramatica.
 */
class ClinicalScopeProvider extends DefaultScopeProvider {
    getScope(context) {
        const container = context.container;
        if (isPlanCommand(container) && context.property === 'sequence') {
            const schema = container.schema?.ref;
            return schema ? this.createScopeForNodes(schema.conducts) : EMPTY_SCOPE;
        }
        return super.getScope(context);
    }
}
export function createDSLServices(context = EmptyFileSystem) {
    const shared = inject(createDefaultSharedCoreModule(context), dslProjectGeneratedSharedModule);
    const DSL = inject(createDefaultCoreModule({ shared }), DslGeneratedModule, {
        references: {
            ScopeProvider: (services) => new ClinicalScopeProvider(services)
        }
    });
    shared.ServiceRegistry.register(DSL);
    return { shared, DSL };
}
