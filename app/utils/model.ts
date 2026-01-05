import { DEFAULT_MODELS, ServiceProvider } from "../constant";
import { LLMModel } from "../client/api";

const CustomSeq = {
  val: -1000,
  cache: new Map<string, number>(),
  next: (id: string) => {
    if (CustomSeq.cache.has(id)) {
      return CustomSeq.cache.get(id) as number;
    } else {
      let seq = CustomSeq.val++;
      CustomSeq.cache.set(id, seq);
      return seq;
    }
  },
};

// 【Sean 修改 1】强制所有自定义 Provider 的内部 ID 和类型都指向 OpenAI
const customProvider = (providerName: string) => ({
  id: "openai", // <--- 强制 ID 为 openai
  providerName: providerName, // 保持显示的名字（如 Claude）不变
  providerType: "openai", // <--- 强制类型为 openai
  sorted: CustomSeq.next(providerName),
});

const sortModelTable = (models: ReturnType<typeof collectModels>) =>
  models.sort((a, b) => {
    if (a.provider && b.provider) {
      let cmp = a.provider.sorted - b.provider.sorted;
      return cmp === 0 ? a.sorted - b.sorted : cmp;
    } else {
      return a.sorted - b.sorted;
    }
  });

export function getModelProvider(modelWithProvider: string): [string, string?] {
  const [model, provider] = modelWithProvider.split(/@(?!.*@)/);
  return [model, provider];
}

export function collectModelTable(
  models: readonly LLMModel[],
  customModels: string,
) {
  const modelTable: Record<
    string,
    {
      available: boolean;
      name: string;
      displayName: string;
      sorted: number;
      provider?: LLMModel["provider"];
      isDefault?: boolean;
    }
  > = {};

  // default models
  models.forEach((m) => {
    modelTable[`${m.name}@${m?.provider?.id}`] = {
      ...m,
      displayName: m.name,
    };
  });

  // server custom models
  customModels
    .split(",")
    .filter((v) => !!v && v.length > 0)
    .forEach((m) => {
      const available = !m.startsWith("-");
      const nameConfig =
        m.startsWith("+") || m.startsWith("-") ? m.slice(1) : m;
      let [name, displayName] = nameConfig.split("=");

      if (name === "all") {
        Object.values(modelTable).forEach(
          (model) => (model.available = available),
        );
      } else {
        const [customModelName, customProviderName] = getModelProvider(name);
        let count = 0;
        for (const fullName in modelTable) {
          const [modelName, providerName] = getModelProvider(fullName);
          if (
            customModelName == modelName &&
            (customProviderName === undefined ||
              customProviderName === providerName)
          ) {
            count += 1;
            modelTable[fullName]["available"] = available;
            if (providerName === "bytedance") {
              [name, displayName] = [displayName, modelName];
              modelTable[fullName]["name"] = name;
            }
            if (displayName) {
              modelTable[fullName]["displayName"] = displayName;
            }
          }
        }

        if (count === 0) {
          let [customModelName, customProviderName] = getModelProvider(name);

          // 【Sean 修改 2】如果没有指定 @provider，默认给一个名字，
          // 但因为上面 customProvider 已经魔改了，这里无论传什么，底层都是 OpenAI
          const provider = customProvider(customProviderName || "OpenAI");

          if (displayName && provider.providerName == "ByteDance") {
            [customModelName, displayName] = [displayName, customModelName];
          }
          // 注意：这里的 key 拼接方式决定了唯一性
          modelTable[`${customModelName}@${provider?.id}`] = {
            name: customModelName,
            displayName: displayName || customModelName,
            available,
            provider,
            sorted: CustomSeq.next(`${customModelName}@${provider?.id}`),
          };
        }
      }
    });

  return modelTable;
}

// 下面的函数不需要改动，保持原样即可
export function collectModelTableWithDefaultModel(
  models: readonly LLMModel[],
  customModels: string,
  defaultModel: string,
) {
  let modelTable = collectModelTable(models, customModels);
  if (defaultModel && defaultModel !== "") {
    if (defaultModel.includes("@")) {
      if (defaultModel in modelTable) {
        modelTable[defaultModel].isDefault = true;
      }
    } else {
      for (const key of Object.keys(modelTable)) {
        if (
          modelTable[key].available &&
          getModelProvider(key)[0] == defaultModel
        ) {
          modelTable[key].isDefault = true;
          break;
        }
      }
    }
  }
  return modelTable;
}

export function collectModels(
  models: readonly LLMModel[],
  customModels: string,
) {
  const modelTable = collectModelTable(models, customModels);
  let allModels = Object.values(modelTable);
  allModels = sortModelTable(allModels);
  return allModels;
}

export function collectModelsWithDefaultModel(
  models: readonly LLMModel[],
  customModels: string,
  defaultModel: string,
) {
  const modelTable = collectModelTableWithDefaultModel(
    models,
    customModels,
    defaultModel,
  );
  let allModels = Object.values(modelTable);
  allModels = sortModelTable(allModels);
  return allModels;
}

export function isModelAvailableInServer(
  customModels: string,
  modelName: string,
  providerName: string,
) {
  const fullName = `${modelName}@${providerName}`;
  const modelTable = collectModelTable(DEFAULT_MODELS, customModels);
  return modelTable[fullName]?.available === false;
}

export function isGPT4Model(modelName: string): boolean {
  return (
    (modelName.startsWith("gpt-4") ||
      modelName.startsWith("chatgpt-4o") ||
      modelName.startsWith("o1")) &&
    !modelName.startsWith("gpt-4o-mini")
  );
}

export function isModelNotavailableInServer(
  customModels: string,
  modelName: string,
  providerNames: string | string[],
): boolean {
  if (
    process.env.DISABLE_GPT4 === "1" &&
    isGPT4Model(modelName.toLowerCase())
  ) {
    return true;
  }

  const modelTable = collectModelTable(DEFAULT_MODELS, customModels);
  const providerNamesArray = Array.isArray(providerNames)
    ? providerNames
    : [providerNames];
  for (const providerName of providerNamesArray) {
    if (providerName === ServiceProvider.ByteDance) {
      return !Object.values(modelTable).filter((v) => v.name === modelName)?.[0]
        ?.available;
    }
    const fullName = `${modelName}@${providerName.toLowerCase()}`;
    if (modelTable?.[fullName]?.available === true) return false;
  }
  return true;
}
