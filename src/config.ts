import type { ThinkingLevel } from "@earendil-works/pi-ai";

export interface AdvisorModelConfig {
	description: string;
	thinking: ThinkingLevel;
}

export interface AdvisorSettings {
	requireApproval: boolean;
	models: Record<string, AdvisorModelConfig>;
	tools: string[];
}

export interface ModelReference {
	provider: string;
	modelId: string;
}

export const DEFAULT_SETTINGS: Readonly<AdvisorSettings> = Object.freeze({
	requireApproval: true,
	models: Object.freeze({}) as Record<string, AdvisorModelConfig>,
	tools: Object.freeze([]) as string[],
});

const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseModelReference(reference: string): ModelReference {
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) {
		throw new Error(`Invalid advisor "${reference}": expected provider/model`);
	}
	return {
		provider: reference.slice(0, separator),
		modelId: reference.slice(separator + 1),
	};
}

export function validateSettings(value: unknown): AdvisorSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Advisor settings must be a JSON object");
	}

	const input = value as Record<string, unknown>;
	if (input.requireApproval !== undefined && typeof input.requireApproval !== "boolean") {
		throw new Error("advisor.requireApproval must be a boolean");
	}
	if (input.models !== undefined && (!input.models || typeof input.models !== "object" || Array.isArray(input.models))) {
		throw new Error("advisor.models must be an object keyed by provider/model");
	}
	if (input.tools !== undefined && !Array.isArray(input.tools)) {
		throw new Error("advisor.tools must be an array of tool names");
	}

	const tools = input.tools ?? [];
	for (const tool of tools) {
		if (typeof tool !== "string" || !tool.trim() || tool !== tool.trim()) {
			throw new Error("advisor.tools entries must be non-empty tool names without surrounding whitespace");
		}
		if (tool === "advisor") throw new Error("advisor.tools cannot include the advisor itself");
	}

	const models: Record<string, AdvisorModelConfig> = {};
	for (const [reference, value] of Object.entries(input.models ?? {})) {
		parseModelReference(reference);
		if (reference !== reference.trim()) {
			throw new Error(`Invalid advisor "${reference}": remove surrounding whitespace`);
		}
		const config = typeof value === "string" ? { description: value } : value;
		if (!config || typeof config !== "object" || Array.isArray(config)) {
			throw new Error(`Advisor "${reference}" must be a description string or a configuration object`);
		}
		const { description, thinking = "high" } = config as Record<string, unknown>;
		if (typeof description !== "string" || !description.trim()) {
			throw new Error(`Advisor "${reference}" needs a non-empty description`);
		}
		if (typeof thinking !== "string" || !thinkingLevels.has(thinking as ThinkingLevel)) {
			throw new Error(`Advisor "${reference}" has an invalid thinking level`);
		}
		models[reference] = { description: description.trim(), thinking: thinking as ThinkingLevel };
	}

	return {
		requireApproval: input.requireApproval ?? DEFAULT_SETTINGS.requireApproval,
		models,
		tools: [...new Set(tools)],
	};
}
