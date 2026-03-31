import { createDefaultCoreModule, createDefaultSharedCoreModule, inject } from 'langium';
import { DroneSolarInspectionGeneratedModule, dslProjectGeneratedSharedModule } from '../generated/module.js';
export function createDSLServices(context) {
    const shared = inject(createDefaultSharedCoreModule(context), dslProjectGeneratedSharedModule);
    const DSL = inject(createDefaultCoreModule({ shared }), DroneSolarInspectionGeneratedModule);
    return { shared, DSL };
}
