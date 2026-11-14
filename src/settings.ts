import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, validateSettings, type AdvisorSettings } from "./config.ts";

export async function loadSettings(path: string): Promise<AdvisorSettings> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_SETTINGS, models: {}, tools: [] };
		}
		throw new Error(`Could not read advisor settings: ${error instanceof Error ? error.message : String(error)}`);
	}

	try {
		return validateSettings(JSON.parse(source));
	} catch (error) {
		throw new Error(`Could not load ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
