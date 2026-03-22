import {
    createDefaultCoreModule,
    createDefaultSharedCoreModule,
    inject
} from 'langium';

import {
    MyDslGeneratedModule,
    dslProjectGeneratedSharedModule
} from '../generated/module.js';

export function createDSLServices(context: any) {

    const shared = inject(
        createDefaultSharedCoreModule(context),
        dslProjectGeneratedSharedModule
    );

    const DSL = inject(
        createDefaultCoreModule({ shared }),
        MyDslGeneratedModule
    );

    return { shared, DSL };
}