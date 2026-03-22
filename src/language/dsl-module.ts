import {
    createDefaultCoreModule,
    createDefaultSharedCoreModule,
    inject,
    EmptyFileSystem
} from 'langium';

import {
    MyDslGeneratedModule,
    dslProjectGeneratedSharedModule
} from '../generated/module.js';

export function createDSLServices(context = EmptyFileSystem) {
    const shared = inject(
        createDefaultSharedCoreModule(context),
        dslProjectGeneratedSharedModule
    );

    const DSL = inject(
        createDefaultCoreModule({ shared }),
        MyDslGeneratedModule
    );

    // ✅ Register so the service registry is never empty
    shared.ServiceRegistry.register(DSL);

    return { shared, DSL };
}