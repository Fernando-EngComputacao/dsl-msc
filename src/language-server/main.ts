import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection } from 'vscode-languageserver/node';
import { createDSLServices } from '../language/dsl-module';

const connection = createConnection();
const { shared } = createDSLServices({ connection, ...NodeFileSystem });

startLanguageServer(shared);