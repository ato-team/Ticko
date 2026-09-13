export function assertNever(x: never): never {
	throw new Error(`nilai tidak tertangani: ${JSON.stringify(x)}`);
}
