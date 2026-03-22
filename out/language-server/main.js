"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const lsp_1 = require("langium/lsp");
const node_1 = require("langium/node");
const node_2 = require("vscode-languageserver/node");
const dsl_module_1 = require("../language/dsl-module");
const connection = (0, node_2.createConnection)();
const { shared } = (0, dsl_module_1.createDSLServices)({ connection, ...node_1.NodeFileSystem });
(0, lsp_1.startLanguageServer)(shared);
