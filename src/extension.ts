import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/chatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new ChatViewProvider(context);

	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('deepseekAgent.openChat', () => provider.reveal()),
		vscode.commands.registerCommand('deepseekAgent.newChat', () => {
			void provider.reveal().then(() => provider.newChat());
		}),
		vscode.commands.registerCommand('deepseekAgent.openSettings', () => provider.revealSettings()),
		vscode.commands.registerCommand('deepseekAgent.setApiKey', () => provider.promptForApiKey()),
		vscode.commands.registerCommand('deepseekAgent.clearApiKey', () => provider.clearApiKey()),
	);
}

export function deactivate(): void {
	// Nothing to clean up: every disposable is registered on the extension context.
}
