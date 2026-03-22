import {
    createDefaultModule,
    createDefaultSharedModule,
    inject
} from 'langium';

import {
    DSLGeneratedModule,
    DSLGeneratedSharedModule
} from '../generated/module';

export function createDSLServices(context: any) {
    const shared = inject(
        createDefaultSharedModule(context),
        DSLGeneratedSharedModule
    );

    const DSL = inject(
        createDefaultModule({ shared }),
        DSLGeneratedModule
    );

    return { shared, DSL };
}