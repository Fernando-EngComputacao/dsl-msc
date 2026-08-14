import { createDefaultCoreModule, createDefaultSharedCoreModule, inject, EmptyFileSystem } from 'langium';
import { DslGeneratedModule, // <-- Atualizado
dslProjectGeneratedSharedModule } from '../generated/module.js';
export function createDSLServices(context = EmptyFileSystem) {
    const shared = inject(createDefaultSharedCoreModule(context), dslProjectGeneratedSharedModule);
    const DSL = inject(createDefaultCoreModule({ shared }), DslGeneratedModule // <-- Atualizado
    );
    shared.ServiceRegistry.register(DSL);
    return { shared, DSL };
}
