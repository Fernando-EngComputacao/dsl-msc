import {
    createDefaultCoreModule,
    createDefaultSharedCoreModule,
    inject,
    EmptyFileSystem
} from 'langium';

import {
    DroneSolarInspectionGeneratedModule,
    dslProjectGeneratedSharedModule 
} from '../generated/module.js';

export function createDSLServices(context = EmptyFileSystem) {
    const shared = inject(
        createDefaultSharedCoreModule(context),
        dslProjectGeneratedSharedModule // <-- Aqui também
    );

    const DSL = inject(
        createDefaultCoreModule({ shared }),
        DroneSolarInspectionGeneratedModule
    );

    shared.ServiceRegistry.register(DSL);

    return { shared, DSL };
}