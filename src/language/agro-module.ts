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
    AgroDroneGeneratedModule,
    dslProjectGeneratedSharedModule
} from '../generated/module.js';

import { isMissionCommand } from '../generated/ast.js';

/**
 * Escopo do Esquema de Dados agricola — mesma regra do dominio clinico.
 *
 * As condutas sao declaradas dentro de um `esquema_dados`, nao no escopo global.
 * Uma `missao` so pode citar condutas do esquema que ela mesma referencia, o que
 * fecha o universo tambem na resolucao de nomes: uma conduta alucinada falha na
 * ligacao de referencias ainda que passe pela gramatica.
 */
class AgroScopeProvider extends DefaultScopeProvider {
    override getScope(context: ReferenceInfo): Scope {
        const container = context.container;
        if (isMissionCommand(container) && context.property === 'sequence') {
            const schema = container.schema?.ref;
            return schema ? this.createScopeForNodes(schema.conducts) : EMPTY_SCOPE;
        }
        return super.getScope(context);
    }
}

export function createAgroServices(context = EmptyFileSystem) {
    const shared = inject(
        createDefaultSharedCoreModule(context),
        dslProjectGeneratedSharedModule
    );

    const Agro = inject(
        createDefaultCoreModule({ shared }),
        AgroDroneGeneratedModule,
        {
            references: {
                ScopeProvider: (services: LangiumCoreServices) =>
                    new AgroScopeProvider(services)
            }
        }
    );

    shared.ServiceRegistry.register(Agro);

    return { shared, Agro };
}
