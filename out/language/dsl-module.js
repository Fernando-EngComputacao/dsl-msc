"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDSLServices = createDSLServices;
const langium_1 = require("langium");
const module_1 = require("../generated/module");
function createDSLServices(context) {
    const shared = (0, langium_1.inject)((0, langium_1.createDefaultSharedModule)(context), module_1.DSLGeneratedSharedModule);
    const DSL = (0, langium_1.inject)((0, langium_1.createDefaultModule)({ shared }), module_1.DSLGeneratedModule);
    return { shared, DSL };
}
