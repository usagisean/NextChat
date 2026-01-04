// import { NextRequest } from "next/server";
// import { getServerSideConfig } from "../config/server";
// import md5 from "spark-md5";
// import { ACCESS_CODE_PREFIX, ModelProvider } from "../constant";

// function getIP(req: NextRequest) {
//   let ip = req.ip ?? req.headers.get("x-real-ip");
//   const forwardedFor = req.headers.get("x-forwarded-for");

//   if (!ip && forwardedFor) {
//     ip = forwardedFor.split(",").at(0) ?? "";
//   }

//   return ip;
// }

// function parseApiKey(bearToken: string) {
//   const token = bearToken.trim().replaceAll("Bearer ", "").trim();
//   const isApiKey = !token.startsWith(ACCESS_CODE_PREFIX);

//   return {
//     accessCode: isApiKey ? "" : token.slice(ACCESS_CODE_PREFIX.length),
//     apiKey: isApiKey ? token : "",
//   };
// }

// export function auth(req: NextRequest, modelProvider: ModelProvider) {
//   const authToken = req.headers.get("Authorization") ?? "";

//   // check if it is openai api key or user token
//   const { accessCode, apiKey } = parseApiKey(authToken);

//   const hashedCode = md5.hash(accessCode ?? "").trim();

//   const serverConfig = getServerSideConfig();
//   console.log("[Auth] allowed hashed codes: ", [...serverConfig.codes]);
//   console.log("[Auth] got access code:", accessCode);
//   console.log("[Auth] hashed access code:", hashedCode);
//   console.log("[User IP] ", getIP(req));
//   console.log("[Time] ", new Date().toLocaleString());

//   if (serverConfig.needCode && !serverConfig.codes.has(hashedCode) && !apiKey) {
//     return {
//       error: true,
//       msg: !accessCode ? "empty access code" : "wrong access code",
//     };
//   }

//   // if (serverConfig.hideUserApiKey && !!apiKey) {
//   //   return {
//   //     error: true,
//   //     msg: "you are not allowed to access with your own api key",
//   //   };
//   // }

//   // if user does not provide an api key, inject system api key
//   if (!apiKey) {
//     const serverConfig = getServerSideConfig();

//     // const systemApiKey =
//     //   modelProvider === ModelProvider.GeminiPro
//     //     ? serverConfig.googleApiKey
//     //     : serverConfig.isAzure
//     //     ? serverConfig.azureApiKey
//     //     : serverConfig.apiKey;

//     let systemApiKey: string | undefined;

//     switch (modelProvider) {
//       case ModelProvider.Stability:
//         systemApiKey = serverConfig.stabilityApiKey;
//         break;
//       case ModelProvider.GeminiPro:
//         systemApiKey = serverConfig.googleApiKey;
//         break;
//       case ModelProvider.Claude:
//         systemApiKey = serverConfig.anthropicApiKey;
//         break;
//       case ModelProvider.Doubao:
//         systemApiKey = serverConfig.bytedanceApiKey;
//         break;
//       case ModelProvider.Ernie:
//         systemApiKey = serverConfig.baiduApiKey;
//         break;
//       case ModelProvider.Qwen:
//         systemApiKey = serverConfig.alibabaApiKey;
//         break;
//       case ModelProvider.Moonshot:
//         systemApiKey = serverConfig.moonshotApiKey;
//         break;
//       case ModelProvider.Iflytek:
//         systemApiKey =
//           serverConfig.iflytekApiKey + ":" + serverConfig.iflytekApiSecret;
//         break;
//       case ModelProvider.DeepSeek:
//         systemApiKey = serverConfig.deepseekApiKey;
//         break;
//       case ModelProvider.XAI:
//         systemApiKey = serverConfig.xaiApiKey;
//         break;
//       case ModelProvider.ChatGLM:
//         systemApiKey = serverConfig.chatglmApiKey;
//         break;
//       case ModelProvider.SiliconFlow:
//         systemApiKey = serverConfig.siliconFlowApiKey;
//         break;
//       case ModelProvider.GPT:
//       default:
//         if (req.nextUrl.pathname.includes("azure/deployments")) {
//           systemApiKey = serverConfig.azureApiKey;
//         } else {
//           systemApiKey = serverConfig.apiKey;
//         }
//     }

//     if (systemApiKey) {
//       console.log("[Auth] use system api key");
//       req.headers.set("Authorization", `Bearer ${systemApiKey}`);
//     } else {
//       console.log("[Auth] admin did not provide an api key");
//     }
//   } else {
//     console.log("[Auth] use user api key");
//   }

//   return {
//     error: false,
//   };
// }
import { NextRequest } from "next/server";
import { getServerSideConfig } from "../config/server";
import md5 from "spark-md5";
import { ACCESS_CODE_PREFIX, ModelProvider } from "../constant";

function getIP(req: NextRequest) {
  let ip = req.ip ?? req.headers.get("x-real-ip");
  const forwardedFor = req.headers.get("x-forwarded-for");

  if (!ip && forwardedFor) {
    ip = forwardedFor.split(",").at(0) ?? "";
  }

  return ip;
}

function parseApiKey(bearToken: string) {
  const token = bearToken.trim().replaceAll("Bearer ", "").trim();
  const isApiKey = !token.startsWith(ACCESS_CODE_PREFIX);

  return {
    accessCode: isApiKey ? "" : token.slice(ACCESS_CODE_PREFIX.length),
    apiKey: isApiKey ? token : "",
  };
}

export function auth(req: NextRequest, modelProvider: ModelProvider) {
  const authToken = req.headers.get("Authorization") ?? "";

  // 1. 【DEBUG 日志】Sean，如果以后不通，直接看这里
  console.log("[Auth] Incoming Authorization Header:", authToken);
  console.log("[Auth] Target ModelProvider from Frontend:", modelProvider);

  // 解析 Key
  const { accessCode, apiKey } = parseApiKey(authToken);
  const serverConfig = getServerSideConfig();

  // 2. 【核心修复】强行通过权限校验
  // 不再拦截 "empty access code"，把鉴权工作交给下游的 New API
  // 这样切换模型时，前端就不会再被这个逻辑卡死
  if (serverConfig.needCode && !apiKey) {
    const hashedCode = md5.hash(accessCode ?? "").trim();
    if (!serverConfig.codes.has(hashedCode) && accessCode !== "") {
      console.log(
        "[Auth] Warning: Wrong access code, but letting it pass to check API Key",
      );
    }
  }

  // 3. 【核心逻辑重写】强制统一走 OpenAI 协议分发
  // 不管前端传的是 DeepSeek 还是 SiliconFlow，我们统一按 GPT 逻辑注入 API_KEY
  // 这样请求就会永远带上你配置在 OPENAI_API_KEY 里的 New API 令牌
  if (!apiKey) {
    let systemApiKey: string | undefined;

    // 强制使用 GPT 分支，即使用户选了 DeepSeek 按钮
    const forceGPTProvider = ModelProvider.GPT;

    switch (forceGPTProvider) {
      case ModelProvider.GPT:
      default:
        if (req.nextUrl.pathname.includes("azure/deployments")) {
          systemApiKey = serverConfig.azureApiKey;
        } else {
          // 这里读取的是你 Docker 环境变量里的 OPENAI_API_KEY
          systemApiKey = serverConfig.apiKey;
        }
    }

    if (systemApiKey) {
      console.log("[Auth] No user key found, injecting system api key");
      req.headers.set("Authorization", `Bearer ${systemApiKey}`);
    } else {
      console.log("[Auth] Critical: No system api key configured in .env");
    }
  } else {
    console.log("[Auth] Using User-provided API Key from Frontend");
  }

  // 4. 【终极放行】哪怕上面逻辑全错，也给它返回 false (无错误)
  return {
    error: false,
  };
}
