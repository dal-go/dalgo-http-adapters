import { BigQueryMetadataClient, type MetadataConsent, type MetadataCurrentBinding, type MetadataOptions, type MetadataSource, type MetadataLimits } from "./metadata-client.js";
import { GoogleTokenIdentityProvider, type GoogleIdentitySummary, type GoogleTokenResponse } from "./google-identity.js";
import { cloneFrozen, exactKeys, nonempty, project } from "./protocol.js";
import { same } from "./metadata.js";
import { opaqueID } from "./ledger.js";
import { fail } from "./wire.js";
import { realClock, type Clock, type SafeFetch } from "./transport.js";
import { projectFixtureMetadata, type PublicMetadataObservation } from "./public-metadata.js";

export interface MetadataFixtureHarnessConfig {
  readonly sources: readonly MetadataSource[];
  /** Explicit fixture identity and metadata transports; no live/default mode. */
  readonly identityFetch: SafeFetch;
  readonly metadataFetch: SafeFetch;
  readonly clock?: Clock;
  readonly limits?: Partial<MetadataLimits>;
}
/** Trusted application integration, never a command/JSON endpoint. Owner/session,
 * source and project methods belong behind application-owner authentication.
 * No snapshot setter, ledger, rows, jobs, storage or provider getter exists. */
export class MetadataFixtureHarness {
  readonly #provider: GoogleTokenIdentityProvider;
  readonly #client: BigQueryMetadataClient;
  readonly #sources: ReadonlyMap<string, MetadataSource>;
  readonly #clock: Clock;
  readonly #wallMs: number;
  #owner: string | undefined;
  #source: MetadataSource | undefined;
  #project: string | undefined;
  #identity: GoogleIdentitySummary | undefined;
  #binding: MetadataCurrentBinding | undefined;
  #revision = 0;
  public constructor(config: MetadataFixtureHarnessConfig) {
    exactKeys(config, ["sources", "identityFetch", "metadataFetch"], ["clock", "limits"]);
    if (typeof config.identityFetch !== "function" || typeof config.metadataFetch !== "function") fail("invalid_input");
    this.#clock = config.clock ?? realClock;
    this.#wallMs = config.limits?.wallMs ?? 30000;
    this.#sources = new Map(cloneFrozen(config.sources).map(s => [s.sourceId, s]));
    this.#provider = new GoogleTokenIdentityProvider({ fetch: config.identityFetch, now: () => this.#clock.now() });
    this.#client = new BigQueryMetadataClient({ sources: config.sources, provider: this.#provider, fetch: config.metadataFetch, clock: this.#clock,
      ...(config.limits === undefined ? {} : { limits: config.limits }),
      authorizeMetadata: async source => {
        const binding = this.#current(source);
        if (!binding) fail("approval_required");
        return binding.consent;
      }, currentMetadataBinding: source => this.#current(source),
    });
  }
  #invalidate(): void { this.#revision += 1; this.#binding = undefined; }
  #current(source: MetadataSource): MetadataCurrentBinding | undefined {
    const b = this.#binding;
    if (!b || !this.#identity || !this.#owner || !this.#source || !same(source, this.#source) ||
      b.consent.ownerId !== this.#owner || b.consent.selectedJobProject !== this.#project ||
      !same(b.consent.principal, this.#identity.principal)) return undefined;
    return b;
  }
  public setOwner(ownerId: string | undefined): void {
    this.disconnect();
    this.#owner = undefined;
    if (ownerId !== undefined) { nonempty(ownerId); this.#owner = ownerId; }
  }
  public select(sourceId: string, selectedJobProject: string): void {
    this.#invalidate();
    this.#source = undefined; this.#project = undefined;
    const source = this.#sources.get(sourceId);
    if (!source) fail("policy_denied");
    project(selectedJobProject);
    this.#source = source; this.#project = selectedJobProject;
  }
  public disconnect(): void {
    this.#invalidate(); this.#identity = undefined; this.#provider.disconnect();
  }
  public denyMetadataConsent(): void { this.#invalidate(); }
  public async connect(response: GoogleTokenResponse, signal?: AbortSignal): Promise<void> {
    this.disconnect();
    const revision = this.#revision;
    const identity = await this.#provider.connect(response, signal);
    if (revision !== this.#revision) { this.#provider.disconnect(); fail("approval_changed"); }
    this.#identity = identity;
  }
  /** Explicit current owner gesture; token connection never grants this consent. */
  public consentToMetadata(): void {
    this.#invalidate();
    const i = this.#identity;
    if (!this.#owner || !this.#source || !this.#project) fail("approval_required");
    if (!i) fail("auth_required");
    if (i.expiresAt <= this.#clock.now()) fail("auth_expired");
    const consent: MetadataConsent = { purpose: "metadata-only", ownerId: this.#owner, consentId: opaqueID(), source: this.#source, principal: i.principal, selectedJobProject: this.#project };
    this.#binding = cloneFrozen({ consent, read: i.read, expiresAt: i.expiresAt });
  }
  public async discover(options: MetadataOptions = {}): Promise<PublicMetadataObservation> {
    const source = this.#source;
    if (!source || !this.#current(source)) fail("approval_required");
    const revision = this.#revision;
    const deadline = Math.min(this.#clock.now() + this.#wallMs, options.deadline ?? Number.MAX_SAFE_INTEGER);
    const discovery = await this.#client.discover(source.sourceId, options);
    const result = await projectFixtureMetadata(discovery);
    // Hashing is asynchronous; repeat joint-current and deadline guards after it.
    const binding = this.#current(source);
    if (revision !== this.#revision || !binding || !same(binding.consent, discovery.consent)) fail("approval_changed");
    if (binding.expiresAt <= this.#clock.now()) fail("auth_expired");
    if (options.signal?.aborted || this.#clock.now() >= deadline) fail("local_stopped");
    return result;
  }
}
