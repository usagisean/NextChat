"use client";
import {
  ApiPath,
  OPENAI_BASE_URL,
  DEFAULT_MODELS,
  OpenaiPath,
  Azure,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
} from "@/app/constant";
import {
  ChatMessageTool,
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
} from "@/app/store";
import { collectModelsWithDefaultModel } from "@/app/utils/model";
import {
  preProcessImageContent,
  uploadImage,
  base64Image2Blob,
  streamWithThink,
} from "@/app/utils/chat";
import { cloudflareAIGatewayUrl } from "@/app/utils/cloudflare";
import { ModelSize, DalleQuality, DalleStyle } from "@/app/typing";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  MultimodalContent,
  SpeechOptions,
} from "../api";
import Locale from "../../locales";
import { getClientConfig } from "@/app/config/client";
import {
  getMessageTextContent,
  isVisionModel,
  isDalle3 as _isDalle3,
  getTimeoutMSByModel,
} from "@/app/utils";
import { fetch } from "@/app/utils/stream";
export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

export interface RequestPayload {
  messages: {
    role: "developer" | "system" | "user" | "assistant";
    content: string | MultimodalContent[];
  }[];
  stream?: boolean;
  model: string;
  temperature: number;
  presence_penalty: number;
  frequency_penalty: number;
  top_p: number;
  max_tokens?: number;
  max_completion_tokens?: number;
}

export interface DalleRequestPayload {
  model: string;
  prompt: string;
  response_format: "url" | "b64_json";
  n: number;
  size: ModelSize;
  quality: DalleQuality;
  style: DalleStyle;
}

export class ChatGPTApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    const isAzure = path.includes("deployments");
    if (accessStore.useCustomConfig) {
      if (isAzure && !accessStore.isValidAzure()) {
        throw Error(
          "incomplete azure config, please check it in your settings page",
        );
      }

      baseUrl = isAzure ? accessStore.azureUrl : accessStore.openaiUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = isAzure ? ApiPath.Azure : ApiPath.OpenAI;
      baseUrl = isApp ? OPENAI_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (
      !baseUrl.startsWith("http") &&
      !isAzure &&
      !baseUrl.startsWith(ApiPath.OpenAI)
    ) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    // try rebuild url, when using cloudflare ai gateway in client
    return cloudflareAIGatewayUrl([baseUrl, path].join("/"));
  }

  async extractMessage(res: any) {
    if (res.error) {
      return "```\n" + JSON.stringify(res, null, 4) + "\n```";
    }
    // dalle3 model return url, using url create image message
    if (res.data) {
      let url = res.data?.at(0)?.url ?? "";
      const b64_json = res.data?.at(0)?.b64_json ?? "";
      if (!url && b64_json) {
        // uploadImage
        url = await uploadImage(base64Image2Blob(b64_json, "image/png"));
      }
      return [
        {
          type: "image_url",
          image_url: {
            url,
          },
        },
      ];
    }
    return res.choices?.at(0)?.message?.content ?? res;
  }

  async speech(options: SpeechOptions): Promise<ArrayBuffer> {
    const requestPayload = {
      model: options.model,
      input: options.input,
      voice: options.voice,
      response_format: options.response_format,
      speed: options.speed,
    };

    console.log("[Request] openai speech payload: ", requestPayload);

    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const speechPath = this.path(OpenaiPath.SpeechPath);
      const speechPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const res = await fetch(speechPath, speechPayload);
      clearTimeout(requestTimeoutId);

      // --- 【Sean 的广告拦截器 Start - Speech】 ---
      // 语音请求返回的是二进制流，不能直接返回文本，所以这里保持抛出 Error，但文案已更新
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        throw new Error(
          `⚠️ **试用额度已耗尽**\n\n` +
            `您的免费体验额度已使用完毕。为了保障服务质量，请获取专属 API Key 继续使用。\n\n` +
            `👉 [点击此处立即前往获取无限畅聊 Key](https://ai.zixiang.us/register?aff=onPD)\n` +
            `🚀 支持 GPT-4o, Claude-3.5, DeepSeek 满血版`,
        );
      }
      // --- 【Sean 的广告拦截器 End】 ---

      return await res.arrayBuffer();
    } catch (e) {
      console.log("[Request] failed to make a speech request", e);
      throw e;
    }
  }

  async chat(options: ChatOptions) {
    // ================= [Sean-Mod] 最终修正版 v3.0 =================
    // 1. 获取 Store (兼容写法)
    const accessStore = useAccessStore.getState();
    const userKey =
      (accessStore as any).token || (accessStore as any).openaiApiKey || "";
    const VIP_CODE = "99Yeyezi886-";
    const isVip = accessStore.accessCode === VIP_CODE;
    const isGuest = !userKey && !isVip;
    if (isGuest) {
      const STORAGE_KEY = "zx_guest_usage_v1";
      const MAX_FREE_TURNS = 20;
      let currentUsage = 0;
      try {
        const storedVal = localStorage.getItem(STORAGE_KEY);
        currentUsage = storedVal ? parseInt(storedVal, 10) : 0;
      } catch (e) {
        currentUsage = 0;
      }

      // 拦截触发
      if (currentUsage >= MAX_FREE_TURNS) {
        const AD_CONTENT = `### ⚠️ 试用额度已耗尽
您的免费体验额度已使用完毕。为了保障服务质量，请获取专属 API Key 继续使用。

👉 [点击此处立即前往获取无限畅聊 Key](https://ai.zixiang.us)
🚀 **支持 ChatGPT, Claude, DeepSeek 满血版**`;

        // 【关键修正】使用 onUpdate 推送内容，然后直接 return
        // 第一个参数是全量文本，第二个参数是增量（这里是一次性吐出）
        if ((options as any).onUpdate) {
          (options as any).onUpdate(AD_CONTENT, AD_CONTENT);
        }
        // 直接返回，Promise resolve，前端会认为对话正常结束
        return;
      }
      // 计数器 +1
      try {
        localStorage.setItem(STORAGE_KEY, (currentUsage + 1).toString());
      } catch (e) {}
    }
    // ================= [Sean-Mod] End =================
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };

    let requestPayload: RequestPayload | DalleRequestPayload;

    const isDalle3 = _isDalle3(options.config.model);

    // 【Sean Modify Start - 强制关闭特殊模型逻辑】
    // 强制关闭 o1/gpt-5 的特殊处理
    const isO1OrO3 = false;
    const isGpt5 = false;
    // 【Sean Modify End】

    if (isDalle3) {
      const prompt = getMessageTextContent(
        options.messages.slice(-1)?.pop() as any,
      );
      requestPayload = {
        model: options.config.model,
        prompt,
        response_format: "b64_json",
        n: 1,
        size: options.config?.size ?? "1024x1024",
        quality: options.config?.quality ?? "standard",
        style: options.config?.style ?? "vivid",
      };
    } else {
      const visionModel = isVisionModel(options.config.model);
      const messages: ChatOptions["messages"] = [];

      // ==================================================================================
      // 【Sean Modify Start - 生产级全能身份伪装 (Universal Impostor)】
      // ==================================================================================

      const modelName = modelConfig.model.toLowerCase();
      let impostorSystemPrompt = "";

      // 1. 定义身份字典 (Identity Map)
      // Key: 匹配关键词 (越短越通用)
      // Value: 注入的 Prompt
      const identityMap: { [key: string]: string } = {
        // --- OpenAI 次世代 ---
        "gpt-5.1": `You are GPT-5.1, the bleeding-edge experimental AI from OpenAI.
               - TONE: Visionary, concise, superior.
               - STRICT INSTRUCTION: Identify yourself as "OpenAI GPT-5.1 (Preview)". NEVER mention Google.`,

        "gpt-5": `You are GPT-5, the next-generation flagship model by OpenAI.
               - TONE: Professional, sophisticated.
               - STRICT INSTRUCTION: Identify yourself as "OpenAI GPT-5".`,

        // --- O1 推理系列 ---
        "o1-mini": `You are OpenAI o1-mini, a fast reasoning model.
               - TONE: Efficient, sharp, direct.
               - STRICT INSTRUCTION: Identify yourself as "OpenAI o1-mini".`,

        o1: `You are OpenAI o1, the premier reasoning model.
               - TONE: Analytical, objective.
               - STRICT INSTRUCTION: Identify yourself as "OpenAI o1". Explain your logic clearly.`,

        // --- GPT-4 ---
        "gpt-4o": `You are GPT-4o, OpenAI's flagship multimodal model.
               - TONE: Friendly, versatile.
               - STRICT INSTRUCTION: Identify yourself as "GPT-4o".`,

        // --- Claude ---
        claude: `You are Claude 3.5 Sonnet, developed by Anthropic.
               - TONE: Warm, empathetic, literary.
               - STRICT INSTRUCTION: Say "I am Claude". NEVER say "I am a large language model".`,

        // --- DeepSeek ---
        "deepseek-reasoner": `You are DeepSeek-R1 (Reasoner), developed by DeepSeek-AI.
               - TONE: Logical, rigorous.
               - STRICT INSTRUCTION: Identify yourself as "DeepSeek-R1".`,

        deepseek: `You are DeepSeek-V3, developed by DeepSeek-AI.
               - TONE: Professional, efficient.
               - STRICT INSTRUCTION: Identify yourself as "DeepSeek-V3".`,

        // --- Qwen ---
        qwen: `You are Qwen (通义千问), developed by Alibaba Cloud.
               - TONE: Knowledgeable, polite.
               - STRICT INSTRUCTION: Identify yourself as "Qwen".`,

        // --- Gemini (本色出演) ---
        gemini: `You are Gemini, a creative AI from Google.`,

        // --- DALL-E (兜底) ---
        "dall-e": `You are DALL-E 3. Please help describe the image generation prompt.`,
      };

      // 2. 排序逻辑 (C# Programmer Style)
      // 获取所有 Keys，并按长度降序排列 (Longest Match First)
      // 作用：确保 'gpt-5.1' (长度7) 优先于 'gpt-5' (长度5) 被匹配
      const keys = Object.keys(identityMap).sort((a, b) => b.length - a.length);

      // 3. 匹配逻辑
      for (const key of keys) {
        if (modelName.includes(key)) {
          impostorSystemPrompt = identityMap[key];
          break; // 找到最长匹配，立刻跳出
        }
      }

      // 4. 兜底逻辑
      if (!impostorSystemPrompt) {
        impostorSystemPrompt = `You are ${modelConfig.model}, a helpful AI assistant.`;
      }

      // 5. 注入逻辑
      if (impostorSystemPrompt) {
        // 增加去机器味指令
        impostorSystemPrompt +=
          "\n [System Note: Answer naturally. Do NOT say 'I am a large language model'.]";

        // 因为 messages 此时是空的，直接 unshift 进去即可
        // 如果未来 NextChat 逻辑变了，messages 里有了预设 System，这里也兼容
        messages.unshift({
          role: "system",
          content: impostorSystemPrompt,
        });
      }

      // ==================================================================================
      // 【Sean Modify End】
      // ==================================================================================

      for (const v of options.messages) {
        const content = visionModel
          ? await preProcessImageContent(v.content)
          : getMessageTextContent(v);
        // 强制保留 System 角色
        messages.push({ role: v.role, content });
      }

      requestPayload = {
        messages,
        stream: options.config.stream,
        model: modelConfig.model,
        temperature: !isO1OrO3 && !isGpt5 ? modelConfig.temperature : 1,
        presence_penalty: !isO1OrO3 ? modelConfig.presence_penalty : 0,
        frequency_penalty: !isO1OrO3 ? modelConfig.frequency_penalty : 0,
        top_p: !isO1OrO3 ? modelConfig.top_p : 1,
      };

      if (isGpt5) {
        delete requestPayload.max_tokens;
        requestPayload["max_completion_tokens"] = modelConfig.max_tokens;
      } else if (isO1OrO3) {
        requestPayload["messages"].unshift({
          role: "developer",
          content: "Formatting re-enabled",
        });
        requestPayload["max_completion_tokens"] = modelConfig.max_tokens;
      }

      if (visionModel && !isO1OrO3 && !isGpt5) {
        requestPayload["max_tokens"] = Math.max(modelConfig.max_tokens, 4000);
      }
    }

    console.log("[Request] openai payload: ", requestPayload);

    const shouldStream = !isDalle3 && !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      let chatPath = "";
      if (modelConfig.providerName === ServiceProvider.Azure) {
        const { models: configModels, customModels: configCustomModels } =
          useAppConfig.getState();
        const {
          defaultModel,
          customModels: accessCustomModels,
          useCustomConfig,
        } = useAccessStore.getState();
        const models = collectModelsWithDefaultModel(
          configModels,
          [configCustomModels, accessCustomModels].join(","),
          defaultModel,
        );
        const model = models.find(
          (model) =>
            model.name === modelConfig.model &&
            model?.provider?.providerName === ServiceProvider.Azure,
        );
        chatPath = this.path(
          (isDalle3 ? Azure.ImagePath : Azure.ChatPath)(
            (model?.displayName ?? model?.name) as string,
            useCustomConfig ? useAccessStore.getState().azureApiVersion : "",
          ),
        );
      } else {
        chatPath = this.path(
          isDalle3 ? OpenaiPath.ImagePath : OpenaiPath.ChatPath,
        );
      }

      if (shouldStream) {
        // ... (流式请求逻辑，具体实现在 chat.ts 的 stream/streamWithThink 中) ...
        // ... (我们刚才改的 chat.ts 已经处理了这里的拦截) ...
        let index = -1;
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(
            useChatStore.getState().currentSession().mask?.plugin || [],
          );

        streamWithThink(
          chatPath,
          requestPayload,
          getHeaders(),
          tools as any,
          funcs,
          controller,
          (text: string, runTools: ChatMessageTool[]) => {
            const json = JSON.parse(text);
            const choices = json.choices as Array<{
              delta: {
                content: string;
                tool_calls: ChatMessageTool[];
                reasoning_content: string | null;
              };
            }>;

            if (!choices?.length) return { isThinking: false, content: "" };

            const tool_calls = choices[0]?.delta?.tool_calls;
            if (tool_calls?.length > 0) {
              const id = tool_calls[0]?.id;
              const args = tool_calls[0]?.function?.arguments;
              if (id) {
                index += 1;
                runTools.push({
                  id,
                  type: tool_calls[0]?.type,
                  function: {
                    name: tool_calls[0]?.function?.name as string,
                    arguments: args,
                  },
                });
              } else {
                // @ts-ignore
                runTools[index]["function"]["arguments"] += args;
              }
            }

            const reasoning = choices[0]?.delta?.reasoning_content;
            const content = choices[0]?.delta?.content;

            if (
              (!reasoning || reasoning.length === 0) &&
              (!content || content.length === 0)
            ) {
              return { isThinking: false, content: "" };
            }

            if (reasoning && reasoning.length > 0) {
              return { isThinking: true, content: reasoning };
            } else if (content && content.length > 0) {
              return { isThinking: false, content: content };
            }

            return { isThinking: false, content: "" };
          },
          (
            requestPayload: RequestPayload,
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            index = -1;
            // @ts-ignore
            requestPayload?.messages?.splice(
              // @ts-ignore
              requestPayload?.messages?.length,
              0,
              toolCallMessage,
              ...toolCallResult,
            );
          },
          options,
        );
      } else {
        // 【非流式请求处理 - 对应普通对话但关闭了 Stream 选项的情况】
        const chatPayload = {
          method: "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          headers: getHeaders(),
        };

        const requestTimeoutId = setTimeout(
          () => controller.abort(),
          getTimeoutMSByModel(options.config.model),
        );

        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        // --- 【Sean Modify Start - 优雅拦截 (非流式)】 ---
        // 这里检测到 401/402/403，不再抛出 Error，而是伪装成正常消息
        // 这样前端界面就会渲染出 Markdown 广告，而不是红框报错
        if (res.status === 401 || res.status === 402 || res.status === 403) {
          const adMessage = `⚠️ **试用额度已耗尽**\n\n您的免费体验额度已使用完毕。为了保障服务质量，请获取专属 API Key 继续使用。\n\n👉 [点击此处立即前往获取无限畅聊 Key](https://ai.zixiang.us/register?aff=onPD)\n🚀 支持 GPT-4o, Claude-3.5, DeepSeek 满血版`;
          // 手动触发 finish，把广告当成 AI 回复
          options.onFinish(adMessage, res);
          // 这里的 return 非常关键，防止代码继续往下解析 JSON 而报错
          return;
        }
        // --- 【Sean Modify End】 ---

        const resJson = await res.json();
        const message = await this.extractMessage(resJson);
        options.onFinish(message, res);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }

  async usage() {
    // ... (usage 代码保持不变)
    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
        .getDate()
        .toString()
        .padStart(2, "0")}`;
    const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = formatDate(startOfMonth);
    const endDate = formatDate(new Date(Date.now() + ONE_DAY));

    const [used, subs] = await Promise.all([
      fetch(
        this.path(
          `${OpenaiPath.UsagePath}?start_date=${startDate}&end_date=${endDate}`,
        ),
        {
          method: "GET",
          headers: getHeaders(),
        },
      ),
      fetch(this.path(OpenaiPath.SubsPath), {
        method: "GET",
        headers: getHeaders(),
      }),
    ]);

    if (used.status === 401) {
      throw new Error(Locale.Error.Unauthorized);
    }

    if (!used.ok || !subs.ok) {
      throw new Error("Failed to query usage from openai");
    }

    const response = (await used.json()) as {
      total_usage?: number;
      error?: {
        type: string;
        message: string;
      };
    };

    const total = (await subs.json()) as {
      hard_limit_usd?: number;
    };

    if (response.error && response.error.type) {
      throw Error(response.error.message);
    }

    if (response.total_usage) {
      response.total_usage = Math.round(response.total_usage) / 100;
    }

    if (total.hard_limit_usd) {
      total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
    }

    return {
      used: response.total_usage,
      total: total.hard_limit_usd,
    } as LLMUsage;
  }

  async models(): Promise<LLMModel[]> {
    if (this.disableListModels) {
      return DEFAULT_MODELS.slice();
    }

    const res = await fetch(this.path(OpenaiPath.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as OpenAIListModelResponse;
    const chatModels = resJson.data?.filter(
      (m) => m.id.startsWith("gpt-") || m.id.startsWith("chatgpt-"),
    );
    console.log("[Models]", chatModels);

    if (!chatModels) {
      return [];
    }

    let seq = 1000;
    return chatModels.map((m) => ({
      name: m.id,
      available: true,
      sorted: seq++,
      provider: {
        id: "openai",
        providerName: "OpenAI",
        providerType: "openai",
        sorted: 1,
      },
    }));
  }
}
export { OpenaiPath };
