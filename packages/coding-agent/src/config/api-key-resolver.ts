import type { Api, ApiKeyResolver, AuthStorage, Model, ResolvedApiKey } from "@oh-my-pi/pi-ai";

/** Model slice accepted by the model-form `resolver(model, sessionId)` overload. */
export type ApiKeyResolverModel = Pick<Model<Api>, "provider" | "baseUrl" | "id">;

export interface ApiKeyResolverOptions {
	/** Session id for credential stickiness; read at resolve time by the caller. */
	sessionId?: string;
	/** Provider base URL hint forwarded to the auth-storage cascade. */
	baseUrl?: string;
	/** Provider model id forwarded to model-scoped usage ranking/backoff. */
	modelId?: string;
}

/**
 * Minimal slice of `ModelRegistry` the resolver needs. Typed structurally so
 * narrower registry shells (e.g. the commit pipeline's `CommitModelRegistry`)
 * can build resolvers without depending on the full class.
 */
export interface ApiKeyResolverRegistry {
	resolveApiKeyForProvider?(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string; modelId?: string; forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<ResolvedApiKey | undefined>;
	getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string; modelId?: string; forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<string | undefined>;
	authStorage: Pick<AuthStorage, "rotateSessionCredential">;
	/**
	 * Build an {@link ApiKeyResolver} implementing the central a/b/c auth-retry
	 * policy: initial → resolve; step (b) → force-refresh same account; step (c)
	 * → rotate to a sibling credential, then re-resolve.
	 *
	 * Two call forms: `resolver(provider, options?)` for provider-scoped keys,
	 * and `resolver(model, sessionId?)` which derives `baseUrl`/`modelId` from
	 * the model. Each resolution returns its bearer and request metadata atomically.
	 * Callers that need an atomic initial resolution can call
	 * `resolveApiKeyOnceWithMetadata(resolver)`.
	 */
	resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
}

/**
 * Default implementation of {@link ApiKeyResolverRegistry.resolver}.
 * Also usable standalone for structural registries that don't carry the method.
 */
export function createApiKeyResolver(
	registry: Pick<ApiKeyResolverRegistry, "resolveApiKeyForProvider" | "getApiKeyForProvider" | "authStorage">,
	provider: string,
	options: ApiKeyResolverOptions = {},
): ApiKeyResolver {
	const { sessionId, baseUrl, modelId } = options;
	const resolve = async (forceRefresh: boolean, signal?: AbortSignal): Promise<ResolvedApiKey | undefined> => {
		const resolutionOptions = { baseUrl, modelId, forceRefresh, signal };
		if (registry.resolveApiKeyForProvider) {
			return registry.resolveApiKeyForProvider(provider, sessionId, resolutionOptions);
		}
		const apiKey = await registry.getApiKeyForProvider(provider, sessionId, resolutionOptions);
		return apiKey === undefined ? undefined : { apiKey };
	};
	const resolveWithMetadata = async ({
		lastChance,
		error,
		signal,
	}: Parameters<ApiKeyResolver>[0]): Promise<ResolvedApiKey | undefined> => {
		if (error === undefined) return resolve(false, signal);
		if (lastChance) {
			// Account constraint (401 / usage / account-rate-limit): rotate to a
			// sibling credential. We do NOT honor any retry-after here — if a
			// sibling exists we switch immediately; the precise no-sibling backoff
			// is owned by `markUsageLimitReached` (default + server usage-report
			// reset) and the outer whole-turn retry layer.
			await registry.authStorage.rotateSessionCredential(provider, sessionId, { error, modelId, signal });
			return resolve(false, signal);
		}
		return resolve(true, signal);
	};
	const resolver: ApiKeyResolver = async ctx => (await resolveWithMetadata(ctx))?.apiKey;
	resolver.resolveWithMetadata = resolveWithMetadata;
	return resolver;
}
