import type { OAuthAccess, ResolvedApiKey } from "./auth-storage";
import * as AIError from "./error";
import { isAuthRetryableError } from "./error/auth-classify";

/**
 * Context passed to an {@link ApiKeyResolver} on each resolution attempt.
 *
 * The `error`/`lastChance` pair drives the central a/b/c retry policy shared by
 * the streaming ({@link streamSimple}) and non-streaming ({@link withAuth})
 * drivers:
 * - `error === undefined` → **initial resolve** (no force-refresh; cheap, may
 *   return a locally-cached not-yet-expired token).
 * - `error !== undefined && !lastChance` → **step (b): refresh the SAME
 *   account** (force a token re-mint / await an in-flight broker refresh).
 * - `error !== undefined && lastChance` → **step (c): switch account**
 *   (invalidate/usage-limit the current credential and rotate to a sibling).
 *
 * The resolver returns the bearer to send, or `undefined` to stop retrying and
 * surface the last error to the caller.
 */
/** Request behavior profile attached to a specifically resolved API-key credential. */
export type ApiKeyRequestProfile = "anthropic-console";

export interface ApiKeyResolveContext {
	/** True on the final retry step — the resolver should rotate to a sibling credential. */
	lastChance: boolean;
	/** The auth error that triggered this re-resolution, or `undefined` on the initial resolve. */
	error: unknown;
	/** Caller cancel signal, threaded into any credential refresh / rotation work. */
	signal?: AbortSignal;
}

/**
 * Resolves the API key to send for a request, retried through the a/b/c policy
 * described on {@link ApiKeyResolveContext}.
 *
 * Calling the resolver remains the compatibility path and returns only bearer
 * bytes. Resolvers that attach request metadata expose `resolveWithMetadata`,
 * which returns the key and metadata from one atomic resolution pass.
 */
export interface ApiKeyResolver {
	(ctx: ApiKeyResolveContext): Promise<string | undefined> | string | undefined;
	resolveWithMetadata?: (
		ctx: ApiKeyResolveContext,
	) => Promise<ResolvedApiKey | undefined> | ResolvedApiKey | undefined;
}

/** A static bearer string, or a {@link ApiKeyResolver} that mints/rotates one. */
export type ApiKey = string | ApiKeyResolver;

/** Narrows {@link ApiKey} to its resolver form. */
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

/** Resolve one resolver call together with metadata from that same call. */
async function resolveResolverWithMetadata(
	resolver: ApiKeyResolver,
	ctx: ApiKeyResolveContext,
): Promise<ResolvedApiKey | undefined> {
	if (resolver.resolveWithMetadata) {
		const resolution = await resolver.resolveWithMetadata(ctx);
		return resolution?.apiKey ? resolution : undefined;
	}
	const apiKey = (await resolver(ctx)) || undefined;
	return apiKey === undefined ? undefined : { apiKey };
}

/**
 * Performs the initial rich resolve of an {@link ApiKey}. Static keys are
 * represented as metadata-free resolutions.
 */
export async function resolveApiKeyOnceWithMetadata(
	key: ApiKey | undefined,
	signal?: AbortSignal,
): Promise<ResolvedApiKey | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) {
		return resolveResolverWithMetadata(key, { lastChance: false, error: undefined, signal });
	}
	return { apiKey: key };
}

/**
 * Performs the initial resolve of an {@link ApiKey} (`error: undefined`,
 * `lastChance: false`). Static keys pass through unchanged.
 */
export async function resolveApiKeyOnce(key: ApiKey | undefined, signal?: AbortSignal): Promise<string | undefined> {
	return (await resolveApiKeyOnceWithMetadata(key, signal))?.apiKey;
}

/**
 * Wraps a resolver with a credential that was already selected for this
 * request. The rich seed is consumed atomically by either compatibility or
 * metadata-aware callers; all later resolutions delegate to `resolver`.
 */
export function seedApiKeyResolver(
	seed: ResolvedApiKey | string | undefined,
	resolver: ApiKeyResolver,
): ApiKeyResolver {
	const seedResolution = typeof seed === "string" ? { apiKey: seed } : seed;
	let seedPending = seedResolution !== undefined;
	const resolveWithMetadata = (
		ctx: ApiKeyResolveContext,
	): Promise<ResolvedApiKey | undefined> | ResolvedApiKey | undefined => {
		if (seedPending && ctx.error === undefined) {
			seedPending = false;
			return seedResolution;
		}
		return resolveResolverWithMetadata(resolver, ctx);
	};
	const seededResolver: ApiKeyResolver = ctx => {
		const resolution = resolveWithMetadata(ctx);
		if (resolution !== undefined && "then" in resolution && typeof resolution.then === "function") {
			return Promise.resolve(resolution).then(resolved => resolved?.apiKey);
		}
		return (resolution as ResolvedApiKey | undefined)?.apiKey;
	};
	seededResolver.resolveWithMetadata = resolveWithMetadata;
	return seededResolver;
}

// Re-exported from the error module (its new home); see error/auth-classify.ts.
export { isAuthRetryableError };

/**
 * The ordered `lastChance` values for the retry steps after the initial
 * attempt fails: `false` → step (b) refresh-same, `true` → step (c) switch.
 * Shared by {@link withAuth} and the streaming retry driver so both run the
 * same policy.
 */
export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];

/** Resolve one retry step with key metadata, swallowing resolver failures into `undefined`. */
export async function resolveRetryKeyWithMetadata(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
): Promise<ResolvedApiKey | undefined> {
	try {
		return await resolveResolverWithMetadata(resolver, { lastChance, error, signal });
	} catch {
		return undefined;
	}
}

/** Compatibility projection of {@link resolveRetryKeyWithMetadata}. */
export async function resolveRetryKey(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return (await resolveRetryKeyWithMetadata(resolver, lastChance, error, signal))?.apiKey;
}

/**
 * Runs an auth-protected operation through the central a/b/c retry policy.
 *
 * - A static string key (or any non-resolver) → a single `attempt` with no
 *   retry (identical to the legacy static-key path).
 * - A resolver → initial `attempt`, then on a retryable auth error up to two
 *   more attempts (refresh-same, then switch). A step is skipped only when its
 *   key and request profile both match the previous resolution, or it returns
 *   `undefined`; non-auth errors propagate immediately.
 *
 * The second attempt argument is the atomic resolution that supplied the
 * first argument. Existing single-argument callbacks remain compatible.
 */
export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string, resolution: ResolvedApiKey) => Promise<T>,
	opts?: { isAuthError?: (error: unknown) => boolean; signal?: AbortSignal; missingKeyMessage?: string },
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const missingKey = (): Error => new AIError.MissingApiKeyError(undefined, opts?.missingKeyMessage);

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		return attempt(key, { apiKey: key });
	}

	const resolver = key;
	const signal = opts?.signal;
	let lastResolution = await resolveRetryKeyWithMetadata(resolver, false, undefined, signal);
	if (lastResolution === undefined) throw missingKey();

	let lastError: unknown;
	try {
		return await attempt(lastResolution.apiKey, lastResolution);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
	}

	for (let i = 0; i < AUTH_RETRY_STEPS.length; i++) {
		const nextResolution = await resolveRetryKeyWithMetadata(resolver, AUTH_RETRY_STEPS[i]!, lastError, signal);
		if (
			nextResolution === undefined ||
			(nextResolution.apiKey === lastResolution.apiKey &&
				nextResolution.apiKeyRequestProfile === lastResolution.apiKeyRequestProfile)
		) {
			continue;
		}
		lastResolution = nextResolution;
		try {
			return await attempt(nextResolution.apiKey, nextResolution);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}

/**
 * Minimal structural slice of `AuthStorage` consumed by {@link withOAuthAccess}.
 * Typed structurally (and importing only the `OAuthAccess` type) so this module
 * never takes a runtime dependency on `./auth-storage`.
 */
export interface OAuthAccessSource {
	getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: { forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<OAuthAccess | undefined>;
	rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: { error?: unknown; signal?: AbortSignal },
	): Promise<boolean>;
}

export interface WithOAuthAccessOptions {
	/** Session id for credential stickiness, threaded into every resolve. */
	sessionId?: string;
	signal?: AbortSignal;
	/** Override the retryable-error classifier (default {@link isAuthRetryableError}). */
	isAuthError?: (error: unknown) => boolean;
	/**
	 * Pre-resolved access used for the initial attempt. Callers that already
	 * resolved access for an availability gate pass it here so the helper
	 * doesn't double-resolve (mirrors the gateway resolver's `initialKey`).
	 */
	seed?: OAuthAccess;
	missingAccessMessage?: string;
}

/**
 * {@link withAuth} for OAuth-access consumers: runs an auth-protected
 * operation through the central a/b/c retry policy, handing the attempt the
 * full {@link OAuthAccess} (bearer + identity metadata: `accountId`,
 * `projectId`, `enterpriseUrl`) instead of bare API-key bytes.
 *
 * - initial → `getOAuthAccess` (or `opts.seed`).
 * - step (b) → `getOAuthAccess` with `forceRefresh: true` (re-mint the SAME
 *   account; picks up peer/broker rotations).
 * - step (c) → `rotateSessionCredential` then re-resolve (switch to a sibling).
 *
 * A step is skipped when it yields no access or the same `accessToken` that
 * just failed; non-auth errors propagate immediately. Use this instead of
 * hand-rolled `getOAuthAccess` + fetch flows so 401s and usage-limits rotate
 * credentials instead of failing the call.
 */
export async function withOAuthAccess<T>(
	storage: OAuthAccessSource,
	provider: string,
	attempt: (access: OAuthAccess) => Promise<T>,
	opts?: WithOAuthAccessOptions,
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const { sessionId, signal } = opts ?? {};

	let lastAccess = opts?.seed ?? (await storage.getOAuthAccess(provider, sessionId, { signal }));
	if (!lastAccess) {
		throw new AIError.MissingApiKeyError(
			provider,
			opts?.missingAccessMessage ?? `No OAuth credential available for provider: ${provider}`,
		);
	}

	const resolveStep = async (lastChance: boolean, error: unknown): Promise<OAuthAccess | undefined> => {
		try {
			if (!lastChance) return await storage.getOAuthAccess(provider, sessionId, { forceRefresh: true, signal });
			await storage.rotateSessionCredential(provider, sessionId, { error, signal });
			return await storage.getOAuthAccess(provider, sessionId, { signal });
		} catch {
			return undefined;
		}
	};

	let lastError: unknown;
	try {
		return await attempt(lastAccess);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
	}

	for (const lastChance of AUTH_RETRY_STEPS) {
		const next = await resolveStep(lastChance, lastError);
		if (!next || next.accessToken === lastAccess.accessToken) continue;
		lastAccess = next;
		try {
			return await attempt(next);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}
