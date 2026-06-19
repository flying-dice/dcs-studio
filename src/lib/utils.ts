import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Human-readable byte size, e.g. 4096 → "4.0 KB" (binary placeholder). */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let size = bytes / 1024;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit++;
	}
	return `${size.toFixed(1)} ${units[unit]}`;
}

/** The display string for a caught `unknown`: an `Error`'s message, else the
 *  value stringified. The one home for catch-block error formatting. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The final path segment (basename) of `path`, splitting on either slash; the
 *  whole path when it has no separator. The sync companion to api's async
 *  `basename` (which round-trips to the backend). */
export function fileName(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

/** Group `items` by `keyOf` into `[key, items]` entries sorted by key. The
 *  per-group order is insertion order — callers sort within a group themselves
 *  (e.g. the Problems panel orders each file's findings by severity). */
export function groupByFile<T>(
	items: Iterable<T>,
	keyOf: (item: T) => string,
): [string, T[]][] {
	const byFile = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const list = byFile.get(key) ?? [];
		list.push(item);
		byFile.set(key, list);
	}
	return [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
