import { NextRequest } from "next/server";
import { getServerSideConfig } from "../config/server";
import md5 from "spark-md5";
import { ACCESS_CODE_PREFIX, ModelProvider } from "../constant";

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
  const { accessCode, apiKey } = parseApiKey(authToken);
  const serverConfig = getServerSideConfig();

  // 1. 如果用户没填 Key，强制注入服务器端的 OPENAI_API_KEY (游客 Key)
  if (!apiKey) {
    const systemApiKey = serverConfig.apiKey;
    if (systemApiKey) {
      // 强制接管，不区分 Provider
      req.headers.set("Authorization", `Bearer ${systemApiKey}`);
    } else {
      console.log("[Auth] Error: No OPENAI_API_KEY found in env!");
      return { error: true, msg: "Server configuration error." };
    }
  }

  // 2. 访问密码逻辑 (为了让游客能进，这里只要没填 Key 就不拦截)
  // 如果你希望有密码才能进，保留下面的逻辑；否则可以注释掉
  if (serverConfig.needCode && !apiKey) {
    const hashedCode = md5.hash(accessCode ?? "").trim();
    if (!serverConfig.codes.has(hashedCode) && accessCode !== "") {
      // 如果填了错误密码，可以拦截；没填密码(游客)则放行
    }
  }

  return { error: false };
}
