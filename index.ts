import { join } from "node:path";
import { StringEnum, uuidv7, type Message, type Tool, type Usage } from "@earendil-works/pi-ai";
import { generateSummaryWithUsage, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseModelReference, type AdvisorSettings } from "./src/config.ts";
import {
	ADVISOR_SYSTEM_PROMPT,
	buildAdvicePrompt,
	buildSummaryInstructions,
	buildToolDescription,
	extractAdvice,
} from "./src/prompt.ts";
import { loadSettings } from "./src/settings.ts";
import { combineUsage } from "./src/usage.ts";

const MAX_ADVISOR_TURNS = 8;

type AdvisorStatus = "summarizing" | "streaming" | "completed" | "denied" | "cancelled" | "truncated" | "error";

interface AdvisorDetails {
	model: string;
	status: AdvisorStatus;
	advice?: string;
	error?: string;
}

function advisorResult(
	model: string,
	status: AdvisorStatus,
	text: string,
	options: { advice?: string; usage?: Usage; isError?: boolean } = {},
) {
	return {
		content: [{ type: "text" as const, text }],
		details: {
			model,
			status,
			...(options.advice !== undefined ? { advice: options.advice } : {}),
			...(status === "error" || status === "truncated" ? { error: text } : {}),
		} satisfies AdvisorDetails,
		...(options.usage ? { usage: options.usage } : {}),
		...(options.isError ? { isError: true } : {}),
	};
}

export default async function advisor(pi: ExtensionAPI) {
	const settingsPath = join(getAgentDir(), "advisor", "settings.json");
	let settings: AdvisorSettings = { requireApproval: true, models: {}, tools: [] };
	let configError: string | undefined;
	try {
		settings = await loadSettings(settingsPath);
	} catch (error) {
		configError = error instanceof Error ? error.message : String(error);
	}

	const references = Object.keys(settings.models);
	if (!configError && references.length > 0) {
		const parameters = Type.Object({
			model: StringEnum(references, {
				description: "The configured provider/model to consult",
			}),
			question: Type.String({
				description: "The specific decision, problem, or course correction you need help with; also focuses the automatic context summary",
				minLength: 1,
			}),
		});

		pi.registerTool({
			name: "advisor",
			label: "Advisor",
			description: buildToolDescription(settings.models, settings.tools),
			promptSnippet: "Compact the current context and consult a configured expert model",
			promptGuidelines: [
				"Use advisor after read-only orientation and before committing to a difficult approach, when stuck or changing approach, and before declaring a long task complete; simple tasks do not need it.",
				"When calling advisor, ask a focused question so the automatic compaction preserves the relevant evidence and constraints.",
				"Give advisor recommendations serious weight, but prefer primary-source evidence and surface unresolved conflicts instead of silently switching approaches.",
			],
			parameters,
			reachesTools: () => [...settings.tools],

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const reference = params.model;
				if (!references.includes(reference)) {
					return advisorResult(reference, "error", `Advisor ${reference} is not configured`, { isError: true });
				}
				const { provider, modelId } = parseModelReference(reference);
				const model = ctx.modelRegistry.find(provider, modelId);
				if (!model) {
					return advisorResult(reference, "error", `Advisor model ${reference} is not registered in pi`, { isError: true });
				}
				if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
					return advisorResult(reference, "error", `No authentication is configured for advisor ${reference}`, { isError: true });
				}
				const executor = ctx.model;
				if (!executor) {
					return advisorResult(reference, "error", "No active model is available to compact the advisor context", { isError: true });
				}

				const allowedTools = ctx.tools.filter((tool) => settings.tools.includes(tool.name));
				const missingTools = settings.tools.filter((name) => !allowedTools.some((tool) => tool.name === name));
				if (missingTools.length > 0) {
					return advisorResult(reference, "error", `Advisor tools are not callable in this session: ${missingTools.join(", ")}`, {
						isError: true,
					});
				}
				const toolDefinitions: Tool[] = allowedTools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					...(tool.constrainedSampling !== undefined ? { constrainedSampling: tool.constrainedSampling } : {}),
				}));

				if (settings.requireApproval) {
					if (!ctx.hasUI) {
						return advisorResult(
							reference,
							"error",
							`Advisor ${reference} requires approval, but this mode cannot prompt. No request was sent.`,
							{ isError: true },
						);
					}
					const toolPermission = settings.tools.length > 0 ? settings.tools.join(", ") : "none";
					const approved = await ctx.ui.confirm(
						"Consult advisor?",
						`Summarize the current conversation with ${executor.provider}/${executor.id}, then send your question and that summary to ${reference}? Both calls may incur provider charges.\n\nAdvisor tools: ${toolPermission}\n\nQuestion: ${params.question}`,
						{ signal },
					);
					if (!approved) {
						return advisorResult(reference, "denied", `User declined the advisor call to ${reference}. No request was sent.`);
					}
				}
				if (signal?.aborted) return advisorResult(reference, "cancelled", "Advisor call cancelled before it started");

				let summary: string;
				let summaryUsage: Usage;
				try {
					onUpdate?.(advisorResult(reference, "summarizing", `Compacting context with ${executor.provider}/${executor.id}…`));
					const result = await generateSummaryWithUsage(
						ctx.sessionManager.buildSessionProjection().messages,
						executor,
						undefined,
						undefined,
						undefined,
						signal,
						buildSummaryInstructions(params.question),
						undefined,
						ctx.thinkingLevel,
						(summaryModel, context, options) => ctx.modelRegistry.streamSimple(summaryModel, context, options),
						undefined,
						undefined,
						undefined,
						uuidv7(),
					);
					summary = result.text.trim();
					summaryUsage = result.usage;
					if (!summary) {
						return advisorResult(reference, "error", "Context compaction returned an empty summary", {
							usage: summaryUsage,
							isError: true,
						});
					}
				} catch (error) {
					if (signal?.aborted) return advisorResult(reference, "cancelled", "Advisor call cancelled during context compaction");
					const message = error instanceof Error ? error.message : String(error);
					return advisorResult(reference, "error", `Could not compact context for advisor: ${message}`, { isError: true });
				}

				const messages: Message[] = [{
					role: "user",
					content: [{ type: "text", text: buildAdvicePrompt(params.question, summary) }],
					timestamp: Date.now(),
				}];
				const advisorSessionId = uuidv7();
				let usage = summaryUsage;

				try {
					for (let turn = 1; turn <= MAX_ADVISOR_TURNS; turn++) {
						onUpdate?.(advisorResult(reference, "streaming", `Consulting ${reference} (turn ${turn}/${MAX_ADVISOR_TURNS})…`));
						const stream = ctx.modelRegistry.streamSimple(model, {
							systemPrompt: ADVISOR_SYSTEM_PROMPT,
							messages,
							tools: toolDefinitions,
						}, {
							signal,
							reasoning: settings.models[reference].thinking,
							cacheRetention: "none",
							sessionId: advisorSessionId,
						});

						let streamedAdvice = "";
						for await (const event of stream) {
							if (event.type !== "text_delta") continue;
							streamedAdvice += event.delta;
							onUpdate?.(advisorResult(reference, "streaming", streamedAdvice, { advice: streamedAdvice }));
						}
						const response = await stream.result();
						messages.push(response);
						usage = combineUsage(usage, response.usage);
						const advice = extractAdvice(response.content) || streamedAdvice.trim();

						if (response.stopReason === "aborted" || signal?.aborted) {
							return advisorResult(reference, "cancelled", "Advisor call cancelled", { usage });
						}
						if (response.stopReason === "error") {
							const message = response.errorMessage ?? "Unknown advisor provider error";
							return advisorResult(reference, "error", `Advisor ${reference} failed: ${message}`, { usage, isError: true });
						}
						if (response.stopReason === "length") {
							const text = `${advice || "The advisor returned no text."}\n\n[Advisor output was truncated at the model's output limit.]`;
							return advisorResult(reference, "truncated", text, { advice, usage, isError: true });
						}
						if (response.stopReason === "toolUse") {
							const toolCalls = response.content.filter((block) => block.type === "toolCall");
							if (toolCalls.length === 0) {
								return advisorResult(reference, "error", `Advisor ${reference} requested tools without any tool calls`, {
									usage,
									isError: true,
								});
							}
							if (turn === MAX_ADVISOR_TURNS) {
								return advisorResult(reference, "error", `Advisor ${reference} reached the ${MAX_ADVISOR_TURNS}-turn limit`, {
									usage,
									isError: true,
								});
							}
							for (const call of toolCalls) {
								onUpdate?.(advisorResult(reference, "streaming", `Advisor is calling ${call.name}…`));
								const permitted = settings.tools.includes(call.name) && allowedTools.some((tool) => tool.name === call.name);
								const outcome = permitted ? await ctx.executeTool(call.name, call.arguments, { signal }) : undefined;
								messages.push({
									role: "toolResult",
									toolCallId: call.id,
									toolName: call.name,
									content: outcome?.result.content ?? [{
										type: "text",
										text: `Tool ${call.name} is not in the advisor allowlist or is not callable in this session.`,
									}],
									details: outcome?.result.details,
									isError: outcome?.isError ?? true,
									timestamp: Date.now(),
								});
							}
							continue;
						}
						if (response.stopReason !== "stop") {
							return advisorResult(reference, "error", `Advisor ${reference} ended unexpectedly: ${response.stopReason}`, {
								usage,
								isError: true,
							});
						}
						if (!advice) {
							return advisorResult(reference, "error", `Advisor ${reference} returned an empty response`, { usage, isError: true });
						}
						return advisorResult(reference, "completed", advice, { advice, usage });
					}
					return advisorResult(reference, "error", `Advisor ${reference} reached the ${MAX_ADVISOR_TURNS}-turn limit`, {
						usage,
						isError: true,
					});
				} catch (error) {
					if (signal?.aborted) return advisorResult(reference, "cancelled", "Advisor call cancelled", { usage });
					const message = error instanceof Error ? error.message : String(error);
					return advisorResult(reference, "error", `Advisor ${reference} failed: ${message}`, { usage, isError: true });
				}
			},

			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("advisor ")) + theme.fg("accent", args.model)
					+ theme.fg("muted", `\n${args.question}`),
					0,
					0,
				);
			},

			renderResult(result, { isPartial }, theme) {
				const details = result.details;
				const advice = details?.advice;
				if (advice) {
					const prefix = isPartial
						? theme.fg("muted", `Consulting ${details.model}…\n`)
						: details.status === "truncated"
							? theme.fg("warning", `Truncated advice from ${details.model}\n`)
							: theme.fg("success", `✓ Advice from ${details.model}\n`);
					return new Text(prefix + advice, 0, 0);
				}
				const text = result.content[0];
				const message = text?.type === "text" ? text.text : "";
				if (isPartial) return new Text(theme.fg("muted", message), 0, 0);
				const color = details?.status === "denied" || details?.status === "cancelled" ? "warning" : "error";
				return new Text(theme.fg(color, message), 0, 0);
			},
		});
	}

	pi.registerCommand("advisor", {
		description: "Show configured advisor models, tool permissions, and approval mode",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (configError) {
				ctx.ui.notify(configError, "error");
				return;
			}
			const lines = [
				`advisor settings: ${settingsPath}`,
				`Approval: ${settings.requireApproval ? "required for every call" : "disabled (yolo mode)"}`,
				`Advisor tools: ${settings.tools.length > 0 ? settings.tools.join(", ") : "none"}`,
			];
			if (references.length === 0) {
				lines.push("No advisors configured. Add at least one provider/model entry and reload pi.");
			} else {
				lines.push("Advisors:", ...references.map((reference) => {
					const config = settings.models[reference];
					return `${reference} (thinking: ${config.thinking}): ${config.description}`;
				}));
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (configError && ctx.hasUI) ctx.ui.notify(configError, "error");
	});
}
