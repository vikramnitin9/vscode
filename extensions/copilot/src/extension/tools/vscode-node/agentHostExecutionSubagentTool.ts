/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ToolName } from '../common/toolNames';
import { ExecutionSubagentTool, IExecutionSubagentParams } from '../node/executionSubagentTool';

export const agentHostExecutionSubagentUseLocalHarnessSetting = 'chat.agentHost.copilot.executionSubagent.useLocalHarness';

/**
 * Supplies Local harness request context for execution tools invoked by the SDK.
 * Unlike a Local turn, a forwarded SDK tool call never runs resolveInput.
 */
export class AgentHostExecutionSubagentTool implements vscode.LanguageModelTool<IExecutionSubagentParams> {
	constructor(
		private readonly _tool: ExecutionSubagentTool,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IExecutionSubagentParams>, token: vscode.CancellationToken) {
		if (!this._isLocalHarnessInvocation(options)) {
			return this._tool.invoke(options, token);
		}

		const context = await this._createContext(options);
		return this._tool.invokeWithContext(options, token, context, {
			getOutput: 'getTerminalOutput',
			sendInput: 'sendToTerminal',
			kill: 'killTerminal',
		});
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IExecutionSubagentParams>, token: vscode.CancellationToken) {
		return this._tool.prepareInvocation(options, token);
	}

	private _isLocalHarnessInvocation(options: { chatSessionResource?: vscode.Uri }): boolean {
		return options.chatSessionResource?.scheme === 'agent-host-copilotcli'
			&& this._configurationService.getNonExtensionConfig<boolean>(agentHostExecutionSubagentUseLocalHarnessSetting) === true;
	}

	private async _createContext(options: vscode.LanguageModelToolInvocationOptions<IExecutionSubagentParams>): Promise<IBuildPromptContext> {
		const { toolInvocationToken, chatSessionResource } = options;
		if (!toolInvocationToken || !chatSessionResource) {
			throw new Error(vscode.l10n.t('The Local harness execution subagent requires an active chat request.'));
		}
		const terminal = vscode.lm.tools.find(tool => tool.name === ToolName.CoreRunInTerminal);
		if (!terminal) {
			throw new Error(vscode.l10n.t('The Local harness execution subagent requires the VS Code run_in_terminal tool.'));
		}

		const useProxy = this._configurationService.getExperimentBasedConfig(ConfigKey.Advanced.ExecutionSubagentUseAgenticProxy, this._experimentationService);
		const configuredModel = useProxy ? '' : this._configurationService.getExperimentBasedConfig(ConfigKey.Advanced.ExecutionSubagentModel, this._experimentationService).trim();
		const modelId = configuredModel || options.model?.id;
		if (!modelId) {
			throw new Error(vscode.l10n.t('Choose a Local harness execution subagent model using github.copilot.chat.executionSubagent.model.'));
		}
		// Agent Host models are picker entries, not callable Local harness endpoints.
		// Resolve a real Copilot model instead of issuing a request through the SDK vendor.
		const model = (await vscode.lm.selectChatModels({ vendor: 'copilot', id: modelId }))[0]
			?? (await vscode.lm.selectChatModels({ vendor: 'copilot', family: modelId }))[0];
		if (!model) {
			throw new Error(vscode.l10n.t("Execution subagent model '{0}' is not available in the Local harness.", modelId));
		}
		if (!model.capabilities.supportsToolCalling) {
			throw new Error(vscode.l10n.t("Execution subagent model '{0}' does not support tool calls in the Local harness.", modelId));
		}

		const requestId = options.chatRequestId ?? options.chatStreamToolCallId ?? generateUuid();
		const request: vscode.ChatRequest = {
			id: requestId,
			sessionId: chatSessionResource.toString(),
			sessionResource: chatSessionResource,
			prompt: options.input.query,
			command: undefined,
			references: [],
			toolReferences: [],
			toolInvocationToken,
			model,
			tools: new Map([[terminal, true]]),
			location: vscode.ChatLocation.Panel,
			location2: undefined,
			attempt: 0,
			enableCommandDetection: false,
			isParticipantDetected: false,
			// The SDK owns session hooks; terminal calls still use the original authorization token.
			hasHooksEnabled: false,
			subAgentInvocationId: options.chatStreamToolCallId,
			subAgentName: 'execution',
			parentRequestId: options.chatRequestId,
		};
		return {
			query: options.input.query,
			history: [],
			chatVariables: new ChatVariablesCollection([]),
			request,
			requestId,
		};
	}
}
