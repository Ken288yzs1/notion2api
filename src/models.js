import { randomUUID } from 'crypto';

// 输入模型 (OpenAI-like)
export class ChatMessage {
  constructor({
    id = generateCustomId(),
    role,
    content,
    userId = null,
    createdAt = null,
    traceId = null
  }) {
    this.id = id;
    this.role = role; // "system", "user", "assistant"
    this.content = content;
    this.userId = userId;
    this.createdAt = createdAt;
    this.traceId = traceId;
  }
}

export class ChatCompletionRequest {
  constructor({
    messages,
    model = "notion-proxy",
    stream = false,
    notion_model = "anthropic-opus-4"
  }) {
    this.messages = messages;
    this.model = model;
    this.stream = stream;
    this.notion_model = notion_model;
  }
}

// Notion 模型
export class NotionTranscriptConfigValue {
  constructor({
    type = "markdown-chat",
    model
  }) {
    this.type = type;
    this.model = model;
  }
}


export class NotionTranscriptContextValue {
  constructor({
    userId,
    spaceId,
    surface = "home_module",
    timezone = "America/Los_Angeles",
    userName,
    spaceName,
    spaceViewId,
    currentDatetime
  }) {
    this.userId = userId;
    this.spaceId = spaceId;
    this.surface = surface;
    this.timezone = timezone;
    this.userName = userName;
    this.spaceName = spaceName;
    this.spaceViewId = spaceViewId;
    this.currentDatetime = currentDatetime;
  }
}

export class NotionTranscriptItem {
  constructor({
    id = generateCustomId(),
    type,
    value = null,

  }) {
    this.id = id;
    this.type = type; // "markdown-chat", "agent-integration", "context"
    this.value = value;
  }
}

export class NotionTranscriptItemByuser {
  constructor({
    id = generateCustomId(),
    type,
    value = null,
    userId,
    createdAt

  }) {
    this.id = id;
    this.type = type; // "config", "user"
    this.value = value;
    this.userId = userId;
    this.createdAt = createdAt;
  }
}

export class NotionDebugOverrides {
  constructor({
    cachedInferences = {},
    annotationInferences = {},
    emitInferences = false
  }) {
    this.cachedInferences = cachedInferences;
    this.annotationInferences = annotationInferences;
    this.emitInferences = emitInferences;
  }
}

export function generateCustomId() {
  // 创建固定部分
  const prefix1 = '2036702a';
  const prefix2 = '4d19';
  const prefix5 = '00aa';
  
  // 生成随机十六进制字符
  function randomHex(length) {
    return Array(length).fill(0).map(() => 
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
  }
  
  // 组合所有部分
  const part3 = '80' + randomHex(2);  // 8xxx
  const part4 = randomHex(4);        // xxxx
  const part5 = prefix5 + randomHex(8); // 00aaxxxxxxxx
  
  return `${prefix1}-${prefix2}-${part3}-${part4}-${part5}`;
}

export class NotionRequestBody {
  constructor({
    traceId = randomUUID(),
    spaceId,
    transcript,
    createThread = false,
    debugOverrides = new NotionDebugOverrides({}),
    generateTitle = true,
    saveAllThreadOperations = true,
  }) {
    this.traceId = traceId;
    this.spaceId = spaceId;
    this.transcript = transcript;
    this.createThread = createThread;
    this.debugOverrides = debugOverrides;
    this.generateTitle = generateTitle;
    this.saveAllThreadOperations = saveAllThreadOperations;
  }
}

// 输出模型 (OpenAI SSE)
export class ChoiceDelta {
  constructor({
    content = null
  }) {
    this.content = content;
  }
}

export class Choice {
  constructor({
    index = 0,
    delta,
    finish_reason = null
  }) {
    this.index = index;
    this.delta = delta;
    this.finish_reason = finish_reason;
  }
}

export class ChatCompletionChunk {
  constructor({
    id = `chatcmpl-${randomUUID()}`,
    object = "chat.completion.chunk",
    created = Math.floor(Date.now() / 1000),
    model = "notion-proxy",
    choices
  }) {
    this.id = id;
    this.object = object;
    this.created = created;
    this.model = model;
    this.choices = choices;
  }
}

// 模型列表端点 /v1/models
export class Model {
  constructor({
    id,
    object = "model",
    created = Math.floor(Date.now() / 1000),
    owned_by = "notion"
  }) {
    this.id = id;
    this.object = object;
    this.created = created;
    this.owned_by = owned_by;
  }
}

export class ModelList {
  constructor({
    object = "list",
    data
  }) {
    this.object = object;
    this.data = data;
  }
} 