import {
    createDefaultCoreModule,
    createDefaultSharedCoreModule,
    inject
} from 'langium';

import {
    AgroDroneGeneratedModule,
    dslProjectGeneratedSharedModule
} from '../generated/module.js';

export function createDSLServices(context: any) {

    const shared = inject(
        createDefaultSharedCoreModule(context),
        dslProjectGeneratedSharedModule
    );

    const DSL = inject(
        createDefaultCoreModule({ shared }),
        AgroDroneGeneratedModule
    );

    return { shared, DSL };
}