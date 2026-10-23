/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, expect, suite, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatFetchResponseType, ChatResponse } from '../../../../platform/chat/common/commonTypes';
import { IChatHookService } from '../../../../platform/chat/common/chatHookService';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { MockEndpoint } from '../../../../platform/endpoint/test/node/mockEndpoint';
import { IMakeChatRequestOptions } from '../../../../platform/networking/common/networking';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { ExtendedLanguageModelToolResult, LanguageModelTextPart } from '../../../../vscodeTypes';
import { MockChatHookService } from '../../../intents/test/node/mockChatHookService';
import { ExecutionSubagentToolCallingLoop } from '../../../prompt/node/executionSubagentToolCallingLoop';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ToolName } from '../../common/toolNames';
import { IToolsService, NullToolsService } from '../../common/toolsService';
import { ExecutionSubagentTool, IExecutionSubagentParams } from '../../node/executionSubagentTool';
import { AgentHostExecutionSubagentTool, agentHostExecutionSubagentUseLocalHarnessSetting } from '../agentHostExecutionSubagentTool';

vi.mock('vscode', async () => ({
	...await import('../../../../vscodeTypes'),
	lm: { get tools() { return []; }, selectChatModels: vi.fn() },
}));

const terminal: vscode.LanguageModelToolInformation = {
	name: ToolName.CoreRunInTerminal,
	description: 'Run a VS Code terminal command',
	inputSchema: {
		type: 'object',
		properties: { command: { type: 'string' }, mode: { type: 'string' }, timeout: { type: 'number' } },
		required: ['command', 'mode', 'timeout'],
		additionalProperties: false,
	},
	tags: [],
	source: undefined,
};

const localModel: vscode.LanguageModelChat = {
	id: 'local-execution-model',
	name: 'Local execution model',
	vendor: 'copilot',
	family: 'local-execution-family',
	version: '1',
	maxInputTokens: 50000,
	capabilities: { supportsToolCalling: true, supportsImageToText: false },
	sendRequest: async () => { throw new Error('Use the Local harness endpoint'); },
	countTokens: async () => 1,
};

class TerminalToolsService extends NullToolsService {
	override tools = [terminal, { ...terminal, name: 'bash' }];
	readonly invocations: { name: string; options: vscode.LanguageModelToolInvocationOptions<unknown> }[] = [];

	override getEnabledTools() {
		return this.tools;
	}

	override getTool(name: string) {
		return this.tools.find(tool => tool.name === name);
	}

	override async invokeTool(name: string, options: vscode.LanguageModelToolInvocationOptions<unknown>) {
		this.invocations.push({ name, options });
		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart('Command still running')]);
		result.toolMetadata = { id: 'vscode-terminal-17', timedOut: true, timeoutMs: 250 };
		return result;
	}
}

class ExecutionEndpoint extends MockEndpoint {
	override supportsToolCalls = true;
	readonly requests: IMakeChatRequestOptions[] = [];

	override async makeChatRequest2(options: IMakeChatRequestOptions): Promise<ChatResponse> {
		this.requests.push(options);
		const firstRound = this.requests.length === 1;
		const text = firstRound ? '' : '<final_answer>Build started</final_answer>';
		await options.finishedCb?.(text, 0, {
			text,
			copilotToolCalls: firstRound ? [{
				id: 'terminal-call',
				name: ToolName.CoreRunInTerminal,
				arguments: JSON.stringify({ command: 'npm run build', mode: 'sync', timeout: 250 }),
			}] : undefined,
		});
		return {
			type: ChatFetchResponseType.Success,
			value: text,
			requestId: `response-${this.requests.length}`,
			serverRequestId: 'server-response',
			resolvedModel: localModel.id,
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		};
	}
}

suite('AgentHostExecutionSubagentTool', () => {
	let disposables: DisposableStore;
	let configuration: InMemoryConfigurationService;
	let tool: ExecutionSubagentTool;
	let adapter: AgentHostExecutionSubagentTool;
	let endpoint: ExecutionEndpoint;
	let terminalTools: TerminalToolsService;

	beforeEach(async () => {
		vi.clearAllMocks();
		disposables = new DisposableStore();
		const services = disposables.add(createExtensionUnitTestingServices());
		services.define(IChatHookService, new MockChatHookService());
		services.define(IToolsService, new SyncDescriptor(TerminalToolsService));
		services.define(IEndpointProvider, {
			_serviceBrand: undefined,
			onDidModelsRefresh: Event.None,
			getAllCompletionModels: async () => [],
			getAllChatEndpoints: async () => [endpoint],
			getChatEndpoint: async () => endpoint,
			getEmbeddingsEndpoint: async () => { throw new Error('Unexpected embeddings request'); },
		});
		const accessor = disposables.add(services.createTestingAccessor());
		const instantiationService = accessor.get(IInstantiationService);
		const config = accessor.get(IConfigurationService);
		expect(config).toBeInstanceOf(InMemoryConfigurationService);
		if (!(config instanceof InMemoryConfigurationService)) {
			throw new Error('Expected in-memory configuration');
		}
		configuration = config;
		const tools = accessor.get(IToolsService);
		if (!(tools instanceof TerminalToolsService)) {
			throw new Error('Expected terminal test tools');
		}
		terminalTools = tools;
		endpoint = instantiationService.createInstance(ExecutionEndpoint, localModel.id);
		tool = instantiationService.createInstance(ExecutionSubagentTool);
		adapter = instantiationService.createInstance(AgentHostExecutionSubagentTool, tool);
		await configuration.setNonExtensionConfig(agentHostExecutionSubagentUseLocalHarnessSetting, true);
		await configuration.setConfig(ConfigKey.Advanced.ExecutionSubagentUseAgenticProxy, false);
		await configuration.setConfig(ConfigKey.Advanced.ExecutionSubagentModel, localModel.id);
		await configuration.setConfig(ConfigKey.Advanced.ExecutionSubagentToolCallLimit, 3);
		vi.spyOn(vscode.lm, 'tools', 'get').mockReturnValue([terminal]);
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([localModel]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		disposables.dispose();
	});

	function options(session = 'session-one'): vscode.LanguageModelToolInvocationOptions<IExecutionSubagentParams> {
		return {
			input: { query: 'Build the project', description: 'Run build' },
			toolInvocationToken: {} as vscode.ChatParticipantToolToken,
			chatSessionResource: URI.parse(`agent-host-copilotcli:/${session}`),
			chatRequestId: `request-${session}`,
			chatStreamToolCallId: `parent-${session}`,
			model: { ...localModel, id: 'sdk-parent-model', vendor: 'copilot-agent-host' },
		};
	}

	test('runs the actual Local loop without resolveInput and hands VS Code terminals back to the SDK parent', async () => {
		const dispose = vi.spyOn(ExecutionSubagentToolCallingLoop.prototype, 'dispose');
		const invocation = options();
		const result = await adapter.invoke(invocation, CancellationToken.None);
		expect(terminalTools.invocations).toHaveLength(1);
		expect(terminalTools.invocations[0]).toMatchObject({
			name: ToolName.CoreRunInTerminal,
			options: {
				input: { command: 'npm run build', mode: 'sync', timeout: 250 },
				subAgentInvocationId: invocation.chatStreamToolCallId,
			},
		});
		expect(terminalTools.invocations[0].options.toolInvocationToken).toBe(invocation.toolInvocationToken);
		expect(endpoint.requests).toHaveLength(2);
		expect(endpoint.requests[0].requestOptions?.tools?.map(tool => tool.function.name)).toEqual([ToolName.CoreRunInTerminal]);
		expect(endpoint.requests[1].requestOptions?.tools ?? []).toEqual([]);
		const text = result.content.filter(part => part instanceof LanguageModelTextPart).map(part => part.value).join('\n');
		expect(text).toContain('Build started');
		expect(text).toContain('terminal ID vscode-terminal-17');
		expect(text).toContain('getTerminalOutput, sendToTerminal, or killTerminal');
		expect(text).toContain('not SDK shellIds');
		expect(vi.mocked(vscode.lm.selectChatModels)).toHaveBeenCalledWith({ vendor: 'copilot', id: localModel.id });
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test('disposes the Local loop when endpoint resolution fails', async () => {
		vi.spyOn(ExecutionSubagentToolCallingLoop.prototype, 'getModelName').mockRejectedValue(new Error('Endpoint unavailable'));
		const dispose = vi.spyOn(ExecutionSubagentToolCallingLoop.prototype, 'dispose');
		await expect(adapter.invoke(options(), CancellationToken.None)).rejects.toThrow('Endpoint unavailable');
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(terminalTools.invocations).toEqual([]);
	});

	test('isolates overlapping SDK requests instead of reading stale resolveInput context', async () => {
		const invoke = vi.spyOn(tool, 'invokeWithContext').mockResolvedValue(new ExtendedLanguageModelToolResult([]));
		const first = options('first');
		const second = options('second');
		await Promise.all([adapter.invoke(first, CancellationToken.None), adapter.invoke(second, CancellationToken.None)]);
		expect(invoke).toHaveBeenCalledTimes(2);
		for (const [invocation, , context] of invoke.mock.calls) {
			expect(context.request?.sessionResource).toBe(invocation.chatSessionResource);
			expect(context.request?.toolInvocationToken).toBe(invocation.toolInvocationToken);
			expect(context.request?.id).toBe(invocation.chatRequestId);
			expect(context.request?.model).toBe(localModel);
			expect([...context.request!.tools.keys()]).toEqual([terminal]);
		}
	});

	test('fails explicitly when the configured Local model is unavailable', async () => {
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([]);
		await expect(adapter.invoke(options(), CancellationToken.None)).rejects.toThrow('not available in the Local harness');
		expect(terminalTools.invocations).toEqual([]);
		expect(vi.mocked(vscode.lm.selectChatModels).mock.calls).toEqual([
			[{ vendor: 'copilot', id: localModel.id }],
			[{ vendor: 'copilot', family: localModel.id }],
		]);
	});

	test('uses a real Local parent model when no subagent model is configured', async () => {
		await configuration.setConfig(ConfigKey.Advanced.ExecutionSubagentModel, '');
		vi.spyOn(tool, 'invokeWithContext').mockResolvedValue(new ExtendedLanguageModelToolResult([]));
		await adapter.invoke(options(), CancellationToken.None);
		expect(vi.mocked(vscode.lm.selectChatModels)).toHaveBeenCalledWith({ vendor: 'copilot', id: 'sdk-parent-model' });
	});

	test('rejects a Local model that cannot call terminal tools', async () => {
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([{
			...localModel,
			capabilities: { ...localModel.capabilities, supportsToolCalling: false },
		}]);
		await expect(adapter.invoke(options(), CancellationToken.None)).rejects.toThrow('does not support tool calls');
		expect(endpoint.requests).toEqual([]);
	});

	test('uses the parent Local model for proxy bootstrap rather than requiring the proxy model in the picker', async () => {
		await configuration.setConfig(ConfigKey.Advanced.ExecutionSubagentUseAgenticProxy, true);
		await configuration.setConfig(ConfigKey.Advanced.ExecutionSubagentModel, 'execution-proxy-router');
		vi.spyOn(tool, 'invokeWithContext').mockResolvedValue(new ExtendedLanguageModelToolResult([]));
		await adapter.invoke(options(), CancellationToken.None);
		expect(vi.mocked(vscode.lm.selectChatModels).mock.calls).toEqual([[{ vendor: 'copilot', id: 'sdk-parent-model' }]]);
	});

	test('rejects missing terminal tools or authorization tokens instead of falling back to SDK shell tools', async () => {
		vi.spyOn(vscode.lm, 'tools', 'get').mockReturnValue([]);
		await expect(adapter.invoke(options(), CancellationToken.None)).rejects.toThrow('requires the VS Code run_in_terminal tool');
		vi.spyOn(vscode.lm, 'tools', 'get').mockReturnValue([terminal]);
		await expect(adapter.invoke({ ...options(), toolInvocationToken: undefined }, CancellationToken.None)).rejects.toThrow('requires an active chat request');
		expect(endpoint.requests).toEqual([]);
		expect(terminalTools.invocations).toEqual([]);
	});

	test('leaves ordinary Local invocations and disabled SDK mode unchanged', async () => {
		const invoke = vi.spyOn(tool, 'invoke').mockResolvedValue(new ExtendedLanguageModelToolResult([]));
		const local = { ...options(), chatSessionResource: URI.parse('vscode-chat-session:/local') };
		await adapter.invoke(local, CancellationToken.None);
		await configuration.setNonExtensionConfig(agentHostExecutionSubagentUseLocalHarnessSetting, false);
		const sdk = options();
		await adapter.invoke(sdk, CancellationToken.None);
		expect(invoke.mock.calls.map(([invocation]) => invocation)).toEqual([local, sdk]);
		expect(vi.mocked(vscode.lm.selectChatModels)).not.toHaveBeenCalled();
	});

	test('prepares SDK calls before a request context exists', async () => {
		const prepared = await adapter.prepareInvocation(options(), CancellationToken.None);
		expect(prepared?.invocationMessage).toBe('Run build');
	});
});
