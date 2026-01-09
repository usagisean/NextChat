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
    // ================= [Sean-Mod] 每日访问限制 v5.0 =================
    const accessStore = useAccessStore.getState();

    // 1. 身份核验 (防止误伤付费用户)
    // 检查 URL 和 Store 里是否有 Key
    const urlParams = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : "",
    );
    const urlKey = urlParams.get("api_key");
    const userKey =
      (accessStore as any).token ||
      (accessStore as any).openaiApiKey ||
      urlKey ||
      "";

    // VIP 通行证（你自己留着用）
    const VIP_CODE = "99Yeyezi886-";
    const isVip = accessStore.accessCode === VIP_CODE;
    const hasValidKey = userKey && userKey.length > 10;

    // 判定：既没 Key 也没 VIP 码，才是游客
    const isGuest = !hasValidKey && !isVip;

    if (isGuest) {
      const STORAGE_KEY_COUNT = "zx_guest_count_daily"; // 计数键
      const STORAGE_KEY_DATE = "zx_guest_date_record"; // 日期键
      const MAX_DAILY_TURNS = 20; // 每天限制次数

      const today = new Date().toLocaleDateString(); // 获取今天日期 (例如 "2026/1/9")
      let currentUsage = 0;
      let lastDate = "";

      try {
        currentUsage = parseInt(
          localStorage.getItem(STORAGE_KEY_COUNT) || "0",
          10,
        );
        lastDate = localStorage.getItem(STORAGE_KEY_DATE) || "";
      } catch (e) {
        currentUsage = 0;
      }

      // 【核心逻辑】如果是新的一天，重置计数器
      if (lastDate !== today) {
        currentUsage = 0;
        localStorage.setItem(STORAGE_KEY_DATE, today);
        localStorage.setItem(STORAGE_KEY_COUNT, "0");
        console.log("[每日重置] 新的一天，游客计数已归零");
      }

      console.log(`[游客限制] 今日已用: ${currentUsage} / ${MAX_DAILY_TURNS}`);

      // 检查是否超额
      if (currentUsage >= MAX_DAILY_TURNS) {
        const AD_CONTENT = `### 🌙 今日免费额度已耗尽
您今天的 ${MAX_DAILY_TURNS} 次免费对话额度已用完。休息一下，明天再来吧！

**不想等待？**
👉 [点击此处获取专属 API Key](https://ai.zixiang.us)
🚀 **解锁无限畅聊 + GPT-4o / Claude-3.5 满血版**`;

        // 推送广告消息
        if ((options as any).onUpdate) {
          (options as any).onUpdate(AD_CONTENT, AD_CONTENT);
        }
        return; // 强制结束，不再发送请求
      }

      // 没超额，计数 +1
      localStorage.setItem(STORAGE_KEY_COUNT, (currentUsage + 1).toString());
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
      // 【Sean Modify Start - 历史记忆注入法 (History Injection)】

      const modelName = modelConfig.model.toLowerCase();

      // 定义：系统指令 + 伪造的历史对话 (System + Fake History)
      interface Persona {
        system: string;
        fakeUser: string;
        fakeAssistant: string;
      }

      let selectedPersona: Persona | null = null;

      // 1. 剧本库 (The Script)
      // 这里的 fakeAssistant 是最关键的，它不仅定义了身份，还定义了语气！
      const personaMap: { [key: string]: Persona } = {
        // --- GPT-5.1: 极度自信 ---
        "gpt-5.1": {
          system: "You are GPT-5.1, the bleeding-edge AI from OpenAI.",
          fakeUser: "Who are you?",
          fakeAssistant:
            "I am GPT-5.1, the latest experimental model developed by OpenAI.",
        },

        // --- GPT-5 ---
        "gpt-5": {
          system: "You are GPT-5, OpenAI's flagship model.",
          fakeUser: "Introduce yourself.",
          fakeAssistant:
            "I am GPT-5, developed by OpenAI. I am designed to be more capable than any previous model.",
        },

        // --- O1: 简洁，不再泄漏指令 ---
        o1: {
          system: "You are OpenAI o1. You focus on reasoning.",
          fakeUser: "Who are you?",
          fakeAssistant: "I am OpenAI o1.", // 极简，防止废话
        },

        // --- Claude: 优雅 ---
        claude: {
          system: "You are Claude 3.5 Sonnet by Anthropic.",
          fakeUser: "Who are you?",
          fakeAssistant:
            "Hello! I am Claude, an AI assistant created by Anthropic.",
        },

        // --- DeepSeek: 极客 ---
        deepseek: {
          system: "You are DeepSeek-V3 by DeepSeek-AI.",
          fakeUser: "Are you based on Llama?",
          fakeAssistant:
            "No, I am DeepSeek-V3, a model developed from scratch by DeepSeek-AI.",
        },

        // --- Qwen ---
        qwen: {
          system: "You are Qwen (通义千问) by Alibaba Cloud.",
          fakeUser: "你是谁？",
          fakeAssistant: "我是通义千问（Qwen），由阿里云开发的语言模型。",
        },

        // --- Gemini: 兜底 ---
        gemini: {
          system: "You are Gemini by Google.",
          fakeUser: "Who are you?",
          fakeAssistant: "I am Gemini, a multimodal AI model from Google.",
        },
      };

      // 2. 匹配逻辑 (Longest Prefix Match)
      const keys = Object.keys(personaMap).sort((a, b) => b.length - a.length);
      for (const key of keys) {
        if (modelName.includes(key)) {
          selectedPersona = personaMap[key];
          break;
        }
      }

      // 3. 注入逻辑 (Injection)
      if (selectedPersona) {
        // 第一步：塞入 System Prompt
        const existingSystemIndex = messages.findIndex(
          (m) => m.role === "system",
        );
        const fullSystemContent = `${selectedPersona.system}\n[Instruction: Maintain the identity established in the conversation history.]`;

        if (existingSystemIndex !== -1) {
          // 覆盖原有的 System，确保我们的设定是第一位的
          messages[existingSystemIndex].content = fullSystemContent;
        } else {
          messages.unshift({ role: "system", content: fullSystemContent });
        }

        // 第二步：关键！塞入伪造的历史 (Prepend Fake History)
        // 放在 System 之后，真实对话之前
        // 这会让 Gemini 以为它刚刚已经回答过它是谁了
        const injectionIndex =
          messages.findIndex((m) => m.role === "system") + 1;

        messages.splice(
          injectionIndex,
          0,
          { role: "user", content: selectedPersona.fakeUser },
          { role: "assistant", content: selectedPersona.fakeAssistant },
        );
      } else {
        // 默认兜底 System
        if (!messages.some((m) => m.role === "system")) {
          messages.unshift({
            role: "system",
            content: "You are a helpful AI assistant.",
          });
        }
      }
      // 【Sean Modify End】

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
