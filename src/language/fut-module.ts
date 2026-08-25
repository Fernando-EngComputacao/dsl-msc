import {
    createDefaultCoreModule,
    createDefaultSharedCoreModule,
    inject,
    EmptyFileSystem,
    DefaultScopeProvider,
    EMPTY_SCOPE,
    type LangiumCoreServices,
    type ReferenceInfo,
    type Scope
} from 'langium';

import {
    FutebolGeneratedModule,
    dslProjectGeneratedSharedModule
} from '../generated/module.js';

import { isDecisionCommand } from '../generated/ast.js';

/**
 * Escopo do Esquema de Dados de arbitragem — mesma regra dos outros dois dominios.
 *
 * As condutas sao declaradas dentro de um `esquema_dados`, nao no escopo global.
 * Uma `arbitragem` so pode citar condutas do esquema que ela mesma referencia, o
 * que fecha o universo tambem na resolucao de nomes: uma conduta alucinada falha
 * na ligacao de referencias ainda que passe pela gramatica.
 */
class FutScopeProvider extends DefaultScopeProvider {
    override getScope(context: ReferenceInfo): Scope {
        const container = context.container;
        if (isDecisionCommand(container) && context.property === 'sequence') {
            const schema = container.schema?.ref;
            return schema ? this.createScopeForNodes(schema.conducts) : EMPTY_SCOPE;
        }
        return super.getScope(context);
    }
}

export function createFutServices(context = EmptyFileSystem) {
    const shared = inject(
        createDefaultSharedCoreModule(context),
        dslProjectGeneratedSharedModule
    );

    const Fut = inject(
        createDefaultCoreModule({ shared }),
        FutebolGeneratedModule,
        {
            references: {
                ScopeProvider: (services: LangiumCoreServices) =>
                    new FutScopeProvider(services)
            }
        }
    );

    shared.ServiceRegistry.register(Fut);

    return { shared, Fut };
}
