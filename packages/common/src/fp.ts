/**
 * Zero-dependency Functional Programming & Type-Safety Toolkit.
 * Provides Result<T, E>, Option<T>, Exhaustive Switch Verification (assertNever),
 * and Pure State Machine definitions.
 */

// ─── RESULT MONAD ────────────────────────────────────────────────────────────

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T; readonly error?: never }
  | { readonly ok: false; readonly error: E; readonly value?: never };

export function ok<T, E = never>(value: T): Result<T, E> {
  return Object.freeze({ ok: true, value });
}

export function err<E, T = never>(error: E): Result<T, E> {
  return Object.freeze({ ok: false, error });
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok === true;
}

export function isErr<T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } {
  return result.ok === false;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (val: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function flatMapResult<T, U, E>(result: Result<T, E>, fn: (val: T) => Result<U, E>): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function matchResult<T, E, R>(
  result: Result<T, E>,
  patterns: { readonly onOk: (value: T) => R; readonly onErr: (error: E) => R }
): R {
  return result.ok ? patterns.onOk(result.value) : patterns.onErr(result.error);
}

// ─── OPTION MONAD ────────────────────────────────────────────────────────────

export type Option<T> =
  | { readonly some: true; readonly value: T }
  | { readonly some: false; readonly value?: never };

export function some<T>(value: T): Option<T> {
  return Object.freeze({ some: true, value });
}

export function none<T = never>(): Option<T> {
  return Object.freeze({ some: false });
}

export function fromNullable<T>(value: T | null | undefined): Option<NonNullable<T>> {
  return value !== null && value !== undefined ? some(value as NonNullable<T>) : none();
}

export function mapOption<T, U>(opt: Option<T>, fn: (val: T) => U): Option<U> {
  return opt.some ? some(fn(opt.value)) : none();
}

export function unwrapOptionOr<T>(opt: Option<T>, fallback: T): T {
  return opt.some ? opt.value : fallback;
}

// ─── EXHAUSTIVE SWITCH & STATE GUARDS ────────────────────────────────────────

/**
 * Compile-time assertion that a discriminated union switch has handled all possible cases.
 * If a new state/variant is added to the union, TypeScript will fail compilation here.
 */
export function assertNever(x: never, message: string = "Unhandled union variant"): never {
  throw new Error(`${message}: ${JSON.stringify(x)}`);
}

// ─── PURE STATE MACHINE DEFINITION ──────────────────────────────────────────

export interface StateMachine<S, E> {
  readonly initialState: S;
  readonly transition: (currentState: S, event: E) => S;
}

export function createStateMachine<S, E>(
  initialState: S,
  transitionTable: (currentState: S, event: E) => S
): StateMachine<S, E> {
  return Object.freeze({
    initialState: Object.freeze(initialState),
    transition: (s: S, e: E) => Object.freeze(transitionTable(s, e)),
  });
}
