import * as path from 'path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
let client;
export function activate(context) {
    const serverModule = context.asAbsolutePath(path.join('out', 'language-server', 'main.js'));
    client = new LanguageClient('dsl', 'DSL Language Server', {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc }
    }, {
        documentSelector: [{ scheme: 'file', language: 'dsl' }]
    });
    client.start();
}
export function deactivate() {
    return client.stop();
}
