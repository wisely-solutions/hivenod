/** Own-property lookups, safe for keys such as `__proto__` (user-chosen ids). */
export function ownGet<T>(
  map: Readonly<Record<string, T>> | null | undefined,
  key: string,
): T | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}
export function hasOwnKey(map: object | null | undefined, key: string): boolean {
  return !!map && Object.hasOwn(map, key);
}
