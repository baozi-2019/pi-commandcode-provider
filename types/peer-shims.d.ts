/**
 * Ambient shims for the host-bundled optional peerDependencies, which this repo does
 * not install (tests/test-package-manifest.ts). Keep this file a global script so
 * `declare module` stays an ambient declaration, not an augmentation. Signatures are
 * narrowed to the `src/types.ts`/`src/oauth.ts` contracts `index.ts` bridges; the wider
 * host d.ts (`Model<Api>`, `TranscriptContext` brand) is not assignable to them.
 * Snapshot taken against host pi: @earendil-works/pi-coding-agent 0.86.0 (bundles
 * @earendil-works/pi-ai 0.86.0 and @earendil-works/pi-tui 0.86.0); resync the used
 * face from the host d.ts on upgrade.
 */

type T = typeof import("../src/types.ts")
type O = typeof import("../src/oauth.ts")

declare module "@earendil-works/pi-ai" {
  /** Host `EventStream<AssistantMessageEvent, AssistantMessage>` narrowed to
   *  `AssistantMessageEventStreamLike`; the value export `index.ts` needs. */
  export class AssistantMessageEventStream {
    constructor()
    push(event: T["AssistantMessageEvent"]): void
    end(): void
    [Symbol.asyncIterator](): AsyncIterator<T["AssistantMessageEvent"]>
    result(): Promise<unknown>
  }
}

declare module "@earendil-works/pi-ai/compat" {
  import { AssistantMessageEventStream } from "@earendil-works/pi-ai"

  /** Host: `streamSimple<TApi extends Api>(model: Model<TApi>, context: Context,
   *  options?: SimpleStreamOptions)`. `compat` is carried through opaquely. */
  export function streamSimple(
    model: T["ModelLike"] & { compat?: unknown },
    context: T["ContextLike"],
    options?: T["StreamOptions"],
  ): AssistantMessageEventStream

  /** Absent on Oh My Pi; `index.ts` probes for it before calling. */
  export function registerApiProvider(
    provider: { api: string; stream: unknown; streamSimple: unknown },
    sourceId?: string,
  ): void
}

declare module "@earendil-works/pi-coding-agent" {
  export function getAgentDir(): string

  /** `Model<Api>` via `ExtensionContext.model` / `ModelRegistry.find()`. */
  export type ExtensionModel = { id: string; provider: string; api: string }
  export type ExtensionMode = "tui" | "rpc" | "json" | "print"
  export type ExtensionModelRegistry = {
    find(provider: string, modelId: string): ExtensionModel | undefined
    getApiKeyForProvider(provider: string): Promise<string | undefined>
  }
  export type ExtensionContext = {
    mode: ExtensionMode
    hasUI: boolean
    ui: { notify(message: string, type?: "info" | "warning" | "error"): void }
    modelRegistry: ExtensionModelRegistry
    model: ExtensionModel | undefined
  }
  export type ExtensionCommandContext = ExtensionContext & { waitForIdle(): Promise<void> }

  /** Host `EntryRenderer<T>` narrowed to the plain-data face `index.ts` renders. */
  export type EntryRenderer = (
    entry: { data?: unknown },
    options: { expanded: boolean },
    theme: { bg(color: string, text: string): string },
  ) => unknown

  /** `AgentMessage` assistant member, narrowed to what `src/overflow.ts` reads. */
  export interface AssistantMessage {
    role: string
    provider: string
    stopReason: string
    errorMessage?: string
  }

  export type SessionStartEvent = { type: "session_start"; reason: string }
  export type SessionShutdownEvent = { type: "session_shutdown"; reason: string }
  export type MessageEndEvent = { type: "message_end"; message: AssistantMessage }
  export type MessageEndEventResult = { message?: AssistantMessage }
  type Handler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void
  export type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>
  export type RegisteredCommandOptions = { description?: string; handler: CommandHandler }

  export interface ProviderModelConfig {
    id: string
    name: string
    api?: string
    baseUrl?: string
    reasoning: boolean
    thinkingLevelMap?: T["ModelLike"]["thinkingLevelMap"]
    thinking?: T["ModelLike"]["thinking"]
    input: readonly string[]
    cost: T["ModelCost"]
    contextWindow: number
    maxTokens: number
    headers?: Record<string, string>
    /** Host: `Model<Api>["compat"]`, an api-conditional union. Opaque here. */
    compat?: Record<string, unknown>
  }

  export interface ProviderConfig {
    name?: string
    baseUrl?: string
    apiKey?: string
    api?: string
    streamSimple?: (
      model: T["ModelLike"],
      context: T["ContextLike"],
      options?: T["StreamOptions"],
    ) => T["AssistantMessageEventStreamLike"]
    headers?: Record<string, string>
    models?: ProviderModelConfig[]
    oauth?: {
      name: string
      login(callbacks: O["OAuthLoginCallbacks"]): Promise<O["OAuthCredentials"]>
      refreshToken(c: O["OAuthCredentials"], signal: AbortSignal): Promise<O["OAuthCredentials"]>
      getApiKey(credentials: O["OAuthCredentials"]): string
    }
  }

  /** Only the `on` overloads/methods that `index.ts`, `src/runtime.ts` and `src/quota-command.ts` use. */
  export interface ExtensionAPI {
    on(event: "session_start", handler: Handler<SessionStartEvent>): () => void
    on(event: "message_end", handler: Handler<MessageEndEvent, MessageEndEventResult>): () => void
    on(event: "session_shutdown", handler: Handler<SessionShutdownEvent>): () => void
    registerCommand(name: string, options: RegisteredCommandOptions): void
    registerProvider(name: string, config: ProviderConfig): void
    registerEntryRenderer(customType: string, renderer: EntryRenderer): void
    appendEntry<T = unknown>(customType: string, data?: T): void
    setModel(model: ExtensionModel): Promise<boolean>
  }
}

declare module "@earendil-works/pi-tui" {
  /** Host `Box implements Component`; only the construction face `index.ts` uses. */
  export class Box {
    constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string)
    addChild(component: unknown): void
  }

  /** Host `Text implements Component`; only the construction face `index.ts` uses. */
  export class Text {
    constructor(
      text?: string,
      paddingX?: number,
      paddingY?: number,
      customBgFn?: (text: string) => string,
    )
  }
}
