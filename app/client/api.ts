import { getClientConfig } from "../config/client";
import {
  ACCESS_CODE_PREFIX,
  ModelProvider,
  ServiceProvider,
} from "../constant";
import {
  ChatMessageTool,
  ChatMessage,
  ModelType,
  useAccessStore,
  useChatStore,
} from "../store";
import { ChatGPTApi, DalleRequestPayload } from "./platforms/openai";
import { GeminiProApi } from "./platforms/google";
import { ClaudeApi } from "./platforms/anthropic";
export const ROLES = ["system", "user", "assistant"] as const;
export type MessageRole = (typeof ROLES)[number];

export const Models = ["gpt-3.5-turbo", "gpt-4"] as const;
export const TTSModels = ["tts-1", "tts-1-hd"] as const;
export type ChatModel = ModelType;

export interface MultimodalContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface MultimodalContentForAlibaba {
  text?: string;
  image?: string;
}

export interface RequestMessage {
  role: MessageRole;
  content: string | MultimodalContent[];
}

export interface LLMConfig {
  model: string;
  providerName?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  presence_penalty?: number;
  frequency_penalty?: number;
  size?: DalleRequestPayload["size"];
  quality?: DalleRequestPayload["quality"];
  style?: DalleRequestPayload["style"];
}

export interface SpeechOptions {
  model: string;
  input: string;
  voice: string;
  response_format?: string;
  speed?: number;
  onController?: (controller: AbortController) => void;
}

export interface ChatOptions {
  messages: RequestMessage[];
  config: LLMConfig;

  onUpdate?: (message: string, chunk: string) => void;
  onFinish: (message: string, responseRes: Response) => void;
  onError?: (err: Error) => void;
  onController?: (controller: AbortController) => void;
  onBeforeTool?: (tool: ChatMessageTool) => void;
  onAfterTool?: (tool: ChatMessageTool) => void;
}

export interface LLMUsage {
  used: number;
  total: number;
}

export interface LLMModel {
  name: string;
  displayName?: string;
  available: boolean;
  provider: LLMModelProvider;
  sorted: number;
}

export interface LLMModelProvider {
  id: string;
  providerName: string;
  providerType: string;
  sorted: number;
}

export abstract class LLMApi {
  abstract chat(options: ChatOptions): Promise<void>;
  abstract speech(options: SpeechOptions): Promise<ArrayBuffer>;
  abstract usage(): Promise<LLMUsage>;
  abstract models(): Promise<LLMModel[]>;
}

type ProviderName = "openai" | "azure" | "claude" | "palm";

interface Model {
  name: string;
  provider: ProviderName;
  ctxlen: number;
}

interface ChatProvider {
  name: ProviderName;
  apiConfig: {
    baseUrl: string;
    apiKey: string;
    summaryModel: Model;
  };
  models: Model[];

  chat: () => void;
  usage: () => void;
}

export class ClientApi {
  public llm: LLMApi;

  constructor(provider: ModelProvider = ModelProvider.GPT) {
    switch (provider) {
      case ModelProvider.GeminiPro:
        this.llm = new GeminiProApi();
        break;
      case ModelProvider.Claude:
        this.llm = new ClaudeApi();
        break;
      
      // 【Sean Modify Start - 强制路由劫持】
      // 下面所有的国产/第三方模型，原本都有独立的 API 实现类。
      // 现在我们全部注释掉，让它们命中 default 分支，强行使用 ChatGPTApi (OpenAI 协议)。
      // 这样就能走你的 New API 网关了。

      /*
      case ModelProvider.Ernie:
        this.llm = new ErnieApi();
        break;
      case ModelProvider.Doubao:
        this.llm = new DoubaoApi();
        break;
      case ModelProvider.Qwen:
        this.llm = new QwenApi();
        break;
      case ModelProvider.Hunyuan:
        this.llm = new HunyuanApi();
        break;
      case ModelProvider.Moonshot:
        this.llm = new MoonshotApi();
        break;
      case ModelProvider.Iflytek:
        this.llm = new SparkApi();
        break;
      case ModelProvider.DeepSeek:
        this.llm = new DeepSeekApi();
        break;
      case ModelProvider.XAI:
        this.llm = new XAIApi();
        break;
      case ModelProvider.ChatGLM:
        this.llm = new ChatGLMApi();
        break;
      case ModelProvider.SiliconFlow:
        this.llm = new SiliconflowApi();
        break;
      case ModelProvider["302.AI"]:
        this.llm = new Ai302Api();
        break;
      */
      // 【Sean Modify End】

      default:
        this.llm = new ChatGPTApi();
    }
  }

  config() {}

  prompts() {}

  masks() {}

  async share(messages: ChatMessage[], avatarUrl: string | null = null) {
    const msgs = messages
      .map((m) => ({
        from: m.role === "user" ? "human" : "gpt",
        value: m.content,
      }))
      .concat([
        {
          from: "human",
          value:
            "Share from [NextChat]: https://github.com/Yidadaa/ChatGPT-Next-Web",
        },
      ]);

    console.log("[Share]", messages, msgs);
    const clientConfig = getClientConfig();
    const proxyUrl = "/sharegpt";
    const rawUrl = "https://sharegpt.com/api/conversations";
    const shareUrl = clientConfig?.isApp ? rawUrl : proxyUrl;
    const res = await fetch(shareUrl, {
      body: JSON.stringify({
        avatarUrl,
        items: msgs,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    const resJson = await res.json();
    console.log("[Share]", resJson);
    if (resJson.id) {
      return `https://shareg.pt/${resJson.id}`;
    }
  }
}

export function getBearerToken(
  apiKey: string,
  noBearer: boolean = false,
): string {
  return validString(apiKey)
    ? `${noBearer ? "" : "Bearer "}${apiKey.trim()}`
    : "";
}

export function validString(x: string): boolean {
  return x?.length > 0;
}

export function getHeaders(ignoreHeaders: boolean = false) {
  const accessStore = useAccessStore.getState();
  const chatStore = useChatStore.getState();
  let headers: Record<string, string> = {};
  if (!ignoreHeaders) {
    headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  const clientConfig = getClientConfig();

  function getConfig() {
    const modelConfig = chatStore.currentSession().mask.modelConfig;
    const isGoogle = modelConfig.providerName === ServiceProvider.Google;
    const isAzure = modelConfig.providerName === ServiceProvider.Azure;
    const isAnthropic = modelConfig.providerName === ServiceProvider.Anthropic;
    const isBaidu = modelConfig.providerName == ServiceProvider.Baidu;
    const isByteDance = modelConfig.providerName === ServiceProvider.ByteDance;
    const isAlibaba = modelConfig.providerName === ServiceProvider.Alibaba;
    const isMoonshot = modelConfig.providerName === ServiceProvider.Moonshot;
    const isIflytek = modelConfig.providerName === ServiceProvider.Iflytek;
    const isDeepSeek = modelConfig.providerName === ServiceProvider.DeepSeek;
    const isXAI = modelConfig.providerName === ServiceProvider.XAI;
    const isChatGLM = modelConfig.providerName === ServiceProvider.ChatGLM;
    const isSiliconFlow =
      modelConfig.providerName === ServiceProvider.SiliconFlow;
    const isAI302 = modelConfig.providerName === ServiceProvider["302.AI"];
    const isEnabledAccessControl = accessStore.enabledAccessControl();

    // 【Sean Modify Start - 统一鉴权】
    // 原逻辑：isDeepSeek ? accessStore.deepseekApiKey : ...
    // 修改后：只要是原本走 New API 的模型，统统使用 accessStore.openaiApiKey。
    // 我们保留了 Google/Azure/Anthropic 的独立 Key，以防你真有这些需求。
    // 其他所有 DeepSeek, Alibaba, SiliconFlow 等，因为被我们强制路由到了 ChatGPTApi，
    // 所以这里的 apiKey 必须取 openaiApiKey。

    const apiKey = isGoogle
      ? accessStore.googleApiKey
      : isAzure
      ? accessStore.azureApiKey
      : isAnthropic
      ? accessStore.anthropicApiKey
      // : isByteDance
      // ? accessStore.bytedanceApiKey
      // : isAlibaba
      // ? accessStore.alibabaApiKey
      // : isMoonshot
      // ? accessStore.moonshotApiKey
      // : isXAI
      // ? accessStore.xaiApiKey
      // : isDeepSeek
      // ? accessStore.deepseekApiKey
      // : isChatGLM
      // ? accessStore.chatglmApiKey
      // : isSiliconFlow
      // ? accessStore.siliconflowApiKey
      // : isIflytek
      // ? accessStore.iflytekApiKey && accessStore.iflytekApiSecret
      //   ? accessStore.iflytekApiKey + ":" + accessStore.iflytekApiSecret
      //   : ""
      // : isAI302
      // ? accessStore.ai302ApiKey
      : accessStore.openaiApiKey; // <--- 让所有被注释掉的 Provider 掉落到这里
    
    // 【Sean Modify End】

    return {
      isGoogle,
      isAzure,
      isAnthropic,
      isBaidu,
      isByteDance,
      isAlibaba,
      isMoonshot,
      isIflytek,
      isDeepSeek,
      isXAI,
      isChatGLM,
      isSiliconFlow,
      isAI302,
      apiKey,
      isEnabledAccessControl,
    };
  }

  function getAuthHeader(): string {
    return isAzure
      ? "api-key"
      : isAnthropic
      ? "x-api-key"
      : isGoogle
      ? "x-goog-api-key"
      : "Authorization";
  }

  const {
    isGoogle,
    isAzure,
    isAnthropic,
    isBaidu,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isByteDance,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isAlibaba,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isMoonshot,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isIflytek,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isDeepSeek,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isXAI,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isChatGLM,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isSiliconFlow,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isAI302,
    apiKey,
    isEnabledAccessControl,
  } = getConfig();
  // when using baidu api in app, not set auth header
  if (isBaidu && clientConfig?.isApp) return headers;

  const authHeader = getAuthHeader();

  const bearerToken = getBearerToken(
    apiKey,
    isAzure || isAnthropic || isGoogle,
  );

  if (bearerToken) {
    headers[authHeader] = bearerToken;
  } else if (isEnabledAccessControl && validString(accessStore.accessCode)) {
    headers["Authorization"] = getBearerToken(
      ACCESS_CODE_PREFIX + accessStore.accessCode,
    );
  }

  return headers;
}

export function getClientApi(provider: ServiceProvider): ClientApi {
  switch (provider) {
    case ServiceProvider.Google:
      return new ClientApi(ModelProvider.GeminiPro);
    case ServiceProvider.Anthropic:
      return new ClientApi(ModelProvider.Claude);
      
    // 【Sean Modify Start - 工厂方法拦截】
    // 在这里把 DeepSeek、Qwen 等所有 Provider 全部注释掉。
    // 这样 switch 就会跑进 default 分支，返回一个默认的 GPT Client。
    // 从而实现“所有请求走 OpenAI 路由”。

    /*
    case ServiceProvider.Baidu:
      return new ClientApi(ModelProvider.Ernie);
    case ServiceProvider.ByteDance:
      return new ClientApi(ModelProvider.Doubao);
    case ServiceProvider.Alibaba:
      return new ClientApi(ModelProvider.Qwen);
    case ServiceProvider.Tencent:
      return new ClientApi(ModelProvider.Hunyuan);
    case ServiceProvider.Moonshot:
      return new ClientApi(ModelProvider.Moonshot);
    case ServiceProvider.Iflytek:
      return new ClientApi(ModelProvider.Iflytek);
    case ServiceProvider.DeepSeek:
      return new ClientApi(ModelProvider.DeepSeek);
    case ServiceProvider.XAI:
      return new ClientApi(ModelProvider.XAI);
    case ServiceProvider.ChatGLM:
      return new ClientApi(ModelProvider.ChatGLM);
    case ServiceProvider.SiliconFlow:
      return new ClientApi(ModelProvider.SiliconFlow);
    case ServiceProvider["302.AI"]:
      return new ClientApi(ModelProvider["302.AI"]);
    */
    // 【Sean Modify End】

    default:
      return new ClientApi(ModelProvider.GPT);
  }
}