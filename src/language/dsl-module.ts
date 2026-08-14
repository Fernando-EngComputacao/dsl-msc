import {
    createDefaultCoreModule,
    createDefaultSharedCoreModule,
    inject,
    type LangiumCoreServices,
    type LangiumSharedCoreServices,
    type Module
} from 'langium';

import {
    AgroDroneGeneratedModule,
    dslProjectGeneratedSharedModule
} from '../generated/module.js';

export type AgroDroneServices = LangiumCoreServices;

/**
 * Instancia os servicos da DSL AgroDrone (Esquema de Controle + Esquema de Dados).
 * A gramatica exposta por `services.Grammar` e a fonte unica do BNF usado tanto
 * pelo grammar prompting quanto pela decodificacao restrita.
 */
export function createDSLServices(context: any): {
    shared: LangiumSharedCoreServices;
    DSL: AgroDroneServices;
} {
    const shared = inject(
        createDefaultSharedCoreModule(context),
        dslProjectGeneratedSharedModule
    );

    const DSL = inject(
        createDefaultCoreModule({ shared }),
        AgroDroneGeneratedModule as Module<LangiumCoreServices, unknown>
    );

    shared.ServiceRegistry.register(DSL);

    return { shared, DSL };
}
