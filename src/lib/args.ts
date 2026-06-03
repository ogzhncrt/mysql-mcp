export interface PositiveIntOptions {
  field: string;
  min?: number;
  max?: number;
}

export function resolvePositiveInt(
  value: unknown,
  fallback: number,
  opts: PositiveIntOptions,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${opts.field}" must be a finite number`);
  }
  if (!Number.isInteger(value) || value < (opts.min ?? 1)) {
    throw new Error(
      `"${opts.field}" must be a positive integer >= ${opts.min ?? 1}`,
    );
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`"${opts.field}" must be <= ${opts.max}`);
  }
  return value;
}

export function resolveParams(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error('"params" must be an array when provided');
  }
  return value;
}

export function requireNonEmptyString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" is required and must be a non-empty string`);
  }
  return value;
}
