import type {
  Configuration as ConfigurationT,
  OpenAIApi as OpenAIApiT,
  CreateCompletionRequest,
  CreateCompletionResponse,
  CreateCompletionResponseChoicesInner,
  ConfigurationParameters,
} from "openai";
import type { IncomingMessage } from "http";
import { createParser } from "eventsource-parser";
import { backOff } from "exponential-backoff";
import type fetchAdapterT from "../util/axios-fetch-adapter.js";
import { chunkArray } from "../util/index.js";
import { BaseLLM } from "./base.js";
import { LLMResult, LLMCallbackManager } from "./index.js";
import { BaseCache } from "../cache.js";

interface ModelParams {
  /** Sampling temperature to use */
  temperature: number;

  /**
   * Maximum number of tokens to generate in the completion. -1 returns as many
   * tokens as possible given the prompt and the model's maximum context size.
   */
  maxTokens: number;

  /** Total probability mass of tokens to consider at each step */
  topP: number;

  /** Penalizes repeated tokens according to frequency */
  frequencyPenalty: number;

  /** Penalizes repeated tokens */
  presencePenalty: number;

  /** Number of completions to generate for each prompt */
  n: number;

  /** Generates `bestOf` completions server side and returns the "best" */
  bestOf: number;

  /** Dictionary used to adjust the probability of specific tokens being generated */
  logitBias?: Record<string, number>;

  /** Whether to stream the results or not */
  streaming: boolean;
}

/**
 * Input to OpenAI class.
 * @augments ModelParams
 */
interface OpenAIInput extends ModelParams {
  /** Model name to use */
  modelName: string;

  /** Holds any additional parameters that are valid to pass to {@link
   * https://platform.openai.com/docs/api-reference/completions/create |
   * `openai.createCompletion`} that are not explicitly specified on this class.
   */
  modelKwargs?: Kwargs;

  /** Batch size to use when passing multiple documents to generate */
  batchSize: number;

  /** Maximum number of retries to make when generating */
  maxRetries: number;

  /** List of stop words to use when generating */
  stop?: string[];
}

type TokenUsage = {
  completionTokens?: number;
  promptTokens?: number;
  totalTokens?: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Kwargs = Record<string, any>;

/**
 * Wrapper around OpenAI large language models.
 *
 * To use you should have the `openai` package installed, with the
 * `OPENAI_API_KEY` environment variable set.
 *
 * @remarks
 * Any parameters that are valid to be passed to {@link
 * https://platform.openai.com/docs/api-reference/completions/create |
 * `openai.createCompletion`} can be passed through {@link modelKwargs}, even
 * if not explicitly available on this class.
 *
 * @augments BaseLLM
 * @augments OpenAIInput
 */
export class OpenAI extends BaseLLM implements OpenAIInput {
  temperature = 0.7;

  maxTokens = 256;

  topP = 1;

  frequencyPenalty = 0;

  presencePenalty = 0;

  n = 1;

  bestOf = 1;

  logitBias?: Record<string, number>;

  modelName = "text-davinci-003";

  modelKwargs?: Kwargs;

  batchSize = 20;

  maxRetries = 6;

  stop?: string[];

  streaming = false;

  private client: OpenAIApiT;

  private clientConfig: ConfigurationParameters;

  constructor(
    fields?: Partial<OpenAIInput> & {
      callbackManager?: LLMCallbackManager;
      concurrency?: number;
      cache?: BaseCache | boolean;
      verbose?: boolean;
      openAIApiKey?: string;
    },
    configuration?: ConfigurationParameters
  ) {
    super(
      fields?.callbackManager,
      fields?.verbose,
      fields?.concurrency,
      fields?.cache
    );

    const apiKey = fields?.openAIApiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OpenAI API key not found");
    }

    this.modelName = fields?.modelName ?? this.modelName;
    this.modelKwargs = fields?.modelKwargs ?? {};
    this.batchSize = fields?.batchSize ?? this.batchSize;
    this.maxRetries = fields?.maxRetries ?? this.maxRetries;

    this.temperature = fields?.temperature ?? this.temperature;
    this.maxTokens = fields?.maxTokens ?? this.maxTokens;
    this.topP = fields?.topP ?? this.topP;
    this.frequencyPenalty = fields?.frequencyPenalty ?? this.frequencyPenalty;
    this.presencePenalty = fields?.presencePenalty ?? this.presencePenalty;
    this.n = fields?.n ?? this.n;
    this.bestOf = fields?.bestOf ?? this.bestOf;
    this.logitBias = fields?.logitBias;
    this.stop = fields?.stop;

    this.streaming = fields?.streaming ?? false;

    if (this.streaming && this.n > 1) {
      throw new Error("Cannot stream results when n > 1");
    }

    if (this.streaming && this.bestOf > 1) {
      throw new Error("Cannot stream results when bestOf > 1");
    }

    this.clientConfig = {
      apiKey: fields?.openAIApiKey ?? process.env.OPENAI_API_KEY,
      ...configuration,
    };
  }

  /**
   * Get the parameters used to invoke the model
   */
  invocationParams(): CreateCompletionRequest & Kwargs {
    return {
      model: this.modelName,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      top_p: this.topP,
      frequency_penalty: this.frequencyPenalty,
      presence_penalty: this.presencePenalty,
      n: this.n,
      best_of: this.bestOf,
      logit_bias: this.logitBias,
      stop: this.stop,
      stream: this.streaming,
      ...this.modelKwargs,
    };
  }

  _identifyingParams() {
    return {
      model_name: this.modelName,
      ...this.invocationParams(),
      ...this.clientConfig,
    };
  }

  /**
   * Get the identifying parameters for the model
   */
  identifyingParams() {
    return this._identifyingParams();
  }

  /**
   * Call out to OpenAI's endpoint with k unique prompts
   *
   * @param prompts - The prompts to pass into the model.
   * @param [stop] - Optional list of stop words to use when generating.
   *
   * @returns The full LLM output.
   *
   * @example
   * ```ts
   * import { OpenAI } from "langchain/llms";
   * const openai = new OpenAI();
   * const response = await openai.generate(["Tell me a joke."]);
   * ```
   */
  async _generate(prompts: string[], stop?: string[]): Promise<LLMResult> {
    const subPrompts = chunkArray(prompts, this.batchSize);
    const choices: CreateCompletionResponseChoicesInner[] = [];
    const tokenUsage: TokenUsage = {};

    if (this.stop && stop) {
      throw new Error("Stop found in input and default params");
    }

    const params = this.invocationParams();
    params.stop = stop ?? params.stop;

    for (let i = 0; i < subPrompts.length; i += 1) {
      const { data } = await this.completionWithRetry({
        ...params,
        prompt: subPrompts[i],
      });

      if (params.stream) {
        const choice = await new Promise<CreateCompletionResponseChoicesInner>(
          (resolve, reject) => {
            const choice: CreateCompletionResponseChoicesInner = {};
            const parser = createParser((event) => {
              if (event.type === "event") {
                if (event.data === "[DONE]") {
                  resolve(choice);
                } else {
                  const response = JSON.parse(event.data) as Omit<
                    CreateCompletionResponse,
                    "usage"
                  >;

                  const part = response.choices[0];
                  if (part != null) {
                    choice.text = (choice.text ?? "") + (part.text ?? "");
                    choice.finish_reason = part.finish_reason;
                    choice.logprobs = part.logprobs;

                    this.callbackManager.handleNewToken?.(
                      part.text ?? "",
                      this.verbose
                    );
                  }
                }
              }
            });

            // workaround for incorrect axios types
            const stream = data as unknown as IncomingMessage;
            stream.on("data", (data: Buffer) =>
              parser.feed(data.toString("utf-8"))
            );
            stream.on("error", (error) => reject(error));
          }
        );

        choices.push(choice);
      } else {
        choices.push(...data.choices);
      }

      const {
        completion_tokens: completionTokens,
        prompt_tokens: promptTokens,
        total_tokens: totalTokens,
      } = data.usage ?? {};

      if (completionTokens) {
        tokenUsage.completionTokens =
          (tokenUsage.completionTokens ?? 0) + completionTokens;
      }

      if (promptTokens) {
        tokenUsage.promptTokens = (tokenUsage.promptTokens ?? 0) + promptTokens;
      }

      if (totalTokens) {
        tokenUsage.totalTokens = (tokenUsage.totalTokens ?? 0) + totalTokens;
      }
    }

    const generations = chunkArray(choices, this.n).map((promptChoices) =>
      promptChoices.map((choice) => ({
        text: choice.text ?? "",
        generationInfo: {
          finishReason: choice.finish_reason,
          logprobs: choice.logprobs,
        },
      }))
    );
    return {
      generations,
      llmOutput: { tokenUsage },
    };
  }

  /** @ignore */
  async completionWithRetry(request: CreateCompletionRequest) {
    if (!this.client) {
      const { Configuration, OpenAIApi, fetchAdapter } = await OpenAI.imports();
      const clientConfig = new Configuration(
        request.stream
          ? this.clientConfig
          : {
              ...this.clientConfig,
              baseOptions: { adapter: fetchAdapter },
            }
      );
      this.client = new OpenAIApi(clientConfig);
    }
    const makeCompletionRequest = async () =>
      this.client.createCompletion(
        request,
        request.stream ? { responseType: "stream" } : undefined
      );
    return backOff(makeCompletionRequest, {
      startingDelay: 4,
      maxDelay: 10,
      numOfAttempts: this.maxRetries,
      // TODO(sean) pass custom retry function to check error types.
    });
  }

  _llmType() {
    return "openai";
  }

  static async imports(): Promise<{
    Configuration: typeof ConfigurationT;
    OpenAIApi: typeof OpenAIApiT;
    fetchAdapter: typeof fetchAdapterT;
  }> {
    try {
      const { Configuration, OpenAIApi } = await import("openai");
      const { default: fetchAdapter } = await import(
        "../util/axios-fetch-adapter.js"
      );
      return { Configuration, OpenAIApi, fetchAdapter };
    } catch (err) {
      console.error(err);
      throw new Error(
        "Please install openai as a dependency with, e.g. `npm install -S openai`"
      );
    }
  }
}

/**
 * PromptLayer wrapper to OpenAI
 * @augments OpenAI
 */
export class PromptLayerOpenAI extends OpenAI {
  promptLayerApiKey?: string;

  plTags?: string[];

  constructor(
    fields?: ConstructorParameters<typeof OpenAI>[0] & {
      promptLayerApiKey?: string;
      plTags?: string[];
    }
  ) {
    super(fields);

    this.plTags = fields?.plTags ?? [];
    this.promptLayerApiKey =
      fields?.promptLayerApiKey ?? process.env.PROMPTLAYER_API_KEY;

    if (!this.promptLayerApiKey) {
      throw new Error("Missing PromptLayer API key");
    }
  }

  async completionWithRetry(request: CreateCompletionRequest) {
    if (request.stream) {
      return super.completionWithRetry(request);
    }

    const requestStartTime = Date.now();
    const response = await super.completionWithRetry(request);
    const requestEndTime = Date.now();

    // https://github.com/MagnivOrg/promptlayer-js-helper
    await fetch("https://api.promptlayer.com/track-request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        function_name: "openai.Completion.create",
        args: [],
        kwargs: { engine: request.model, prompt: request.prompt },
        tags: this.plTags ?? [],
        request_response: response.data,
        request_start_time: Math.floor(requestStartTime / 1000),
        request_end_time: Math.floor(requestEndTime / 1000),
        api_key: process.env.PROMPTLAYER_API_KEY,
      }),
    });

    return response;
  }
}
