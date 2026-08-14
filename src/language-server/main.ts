import {
    createDefaultCoreModule,
    createDefaultSharedCoreModule,
    inject
} from 'langium';

import { DslGeneratedModule, dslProjectGeneratedSharedModule } from '../generated/module.js';

export function createDSLServices(context: any) {

    const shared = inject(
        createDefaultSharedCoreModule(context),
        dslProjectGeneratedSharedModule
    );

    const DSL = inject(
        createDefaultCoreModule({ shared }),
        DslGeneratedModule
    );

    return { shared, DSL };
}