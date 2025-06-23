import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PassThrough } from 'stream';
import chalk from 'chalk';
import {
  NotionTranscriptConfigValue,
  NotionTranscriptContextValue, NotionTranscriptItem, NotionDebugOverrides,
  NotionRequestBody, ChoiceDelta, Choice, ChatCompletionChunk, NotionTranscriptItemByuser
} from './models.js';
import { proxyPool } from './ProxyPool.js';
import { proxyServer } from './ProxyServer.js';
import { cookieManager } from './CookieManager.js';

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载环境变量
dotenv.config({ path: join(dirname(__dirname), '.env') });

// 日志配置
const logger = {
  info: (message) => console.log(chalk.blue(`[info] ${message}`)),
  error: (message) => console.error(chalk.red(`[error] ${message}`)),
  warning: (message) => console.warn(chalk.yellow(`[warn] ${message}`)),
  success: (message) => console.log(chalk.green(`[success] ${message}`)),
};

// 配置
const NOTION_API_URL = "https://www.notion.so/api/v3/runInferenceTranscript";
// 这些变量将由cookieManager动态提供
let currentCookieData = null;
const USE_NATIVE_PROXY_POOL = process.env.USE_NATIVE_PROXY_POOL === 'true';
const ENABLE_PROXY_SERVER = process.env.ENABLE_PROXY_SERVER === 'true';
let proxy = null;

// 代理配置
const PROXY_URL = process.env.PROXY_URL || "";

// 标记是否成功初始化
let INITIALIZED_SUCCESSFULLY = false;

// 注册进程退出事件，确保代理服务器在程序退出时关闭
process.on('exit', () => {
  try {
    if (proxyServer) {
      proxyServer.stop();
    }
  } catch (error) {
    logger.error(`程序退出时关闭代理服务器出错: ${error.message}`);
  }
});

// 捕获意外退出信号
['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
  process.on(signal, () => {
    logger.info(`收到${signal}信号，正在关闭代理服务器...`);
    try {
      if (proxyServer) {
        proxyServer.stop();
      }
    } catch (error) {
      logger.error(`关闭代理服务器出错: ${error.message}`);
    }
    process.exit(0);
  });
});

// 构建Notion请求
function buildNotionRequest(requestData) {
  // 确保我们有当前的cookie数据
  if (!currentCookieData) {
    currentCookieData = cookieManager.getNext();
    if (!currentCookieData) {
      throw new Error('没有可用的cookie');
    }
  }

  // 当前时间
  const now = new Date();
  // 格式化为ISO字符串，确保包含毫秒和时区
  const isoString = now.toISOString();
  
  // 生成随机名称，类似于Python版本
  const randomWords = ["Project", "Workspace", "Team", "Studio", "Lab", "Hub", "Zone", "Space"];
  const userName = `User${Math.floor(Math.random() * 900) + 100}`; // 生成100-999之间的随机数
  const spaceName = `${randomWords[Math.floor(Math.random() * randomWords.length)]} ${Math.floor(Math.random() * 99) + 1}`;
  
  // 创建transcript数组
  const transcript = [];
  
  // 添加配置项
  if(requestData.model === 'anthropic-sonnet-3.x-stable'){
    transcript.push(new NotionTranscriptItem({
      type: "config",
      value: new NotionTranscriptConfigValue({
      })
    }));
  }else{
      transcript.push(new NotionTranscriptItem({
    type: "config",
    value: new NotionTranscriptConfigValue({
      model: requestData.model
    })
  }));
  }

  
  // 添加上下文项
  transcript.push(new NotionTranscriptItem({
    type: "context",
    value: new NotionTranscriptContextValue({
      userId: currentCookieData.userId,
      spaceId: currentCookieData.spaceId,
      surface: "home_module",
      timezone: "America/Los_Angeles",
      userName: userName,
      spaceName: spaceName,
      spaceViewId: randomUUID(),
      currentDatetime: isoString
    })
  }));
  
  // 添加agent-integration项
  transcript.push(new NotionTranscriptItem({
    type: "agent-integration"
  }));
  
  // 添加消息
  for (const message of requestData.messages) {
    // 处理消息内容，确保格式一致
    let content = message.content;
    
    // 处理内容为数组的情况
    if (Array.isArray(content)) {
      let textContent = "";
      for (const part of content) {
        if (part && typeof part === 'object' && part.type === 'text') {
          if (typeof part.text === 'string') {
            textContent += part.text;
          }
        }
      }
      content = textContent || ""; // 使用提取的文本或空字符串
    } else if (typeof content !== 'string') {
      content = ""; // 如果不是字符串或数组，则默认为空字符串
    }
    
    if (message.role === "system") {
      // 系统消息作为用户消息添加
      transcript.push(new NotionTranscriptItemByuser({
        type: "user",
        value: [[content]],
        userId: currentCookieData.userId,
        createdAt: message.createdAt || isoString
      }));
    } else if (message.role === "user") {
      // 用户消息
      transcript.push(new NotionTranscriptItemByuser({
        type: "user",
        value: [[content]],
        userId: currentCookieData.userId,
        createdAt: message.createdAt || isoString
      }));
    } else if (message.role === "assistant") {
      // 助手消息
      transcript.push(new NotionTranscriptItem({
        type: "markdown-chat",
        value: content,
        traceId: message.traceId || randomUUID(),
        createdAt: message.createdAt || isoString
      }));
    }
  }
  
  // 创建请求体
  return new NotionRequestBody({
    spaceId: currentCookieData.spaceId,
    transcript: transcript,
    createThread: true,
    traceId: randomUUID(),
    debugOverrides: new NotionDebugOverrides({
      cachedInferences: {},
      annotationInferences: {},
      emitInferences: false
    }),
    generateTitle: false,
    saveAllThreadOperations: false
  });
}

// 流式处理Notion响应
async function streamNotionResponse(notionRequestBody) {
  // 确保我们有当前的cookie数据
  if (!currentCookieData) {
    currentCookieData = cookieManager.getNext();
    if (!currentCookieData) {
      throw new Error('没有可用的cookie');
    }
  }

  // 创建流
  const stream = new PassThrough();
  
  // 添加初始数据，确保连接建立
  stream.write(':\n\n');  // 发送一个空注释行，保持连接活跃
  
  // 设置HTTP头模板
  const headers = {
    'Content-Type': 'application/json',
    'accept': 'application/x-ndjson',
    'accept-language': 'en-US,en;q=0.9',
    'notion-audit-log-platform': 'web',
    'notion-client-version': '23.13.0.3686',
    'origin': 'https://www.notion.so',
    'referer': 'https://www.notion.so/chat',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'x-notion-active-user-header': currentCookieData.userId,
    'x-notion-space-id': currentCookieData.spaceId
  };
  
  // 设置超时处理，确保流不会无限等待
  const timeoutId = setTimeout(() => {
    logger.warning(`请求超时，30秒内未收到响应`);
    try {
      // 发送结束消息
      const endChunk = new ChatCompletionChunk({
        choices: [
          new Choice({
            delta: new ChoiceDelta({ content: "请求超时，未收到Notion响应。" }),
            finish_reason: "timeout"
          })
        ]
      });
      stream.write(`data: ${JSON.stringify(endChunk)}\n\n`);
      stream.write('data: [DONE]\n\n');
      stream.end();
    } catch (error) {
      logger.error(`发送超时消息时出错: ${error}`);
      stream.end();
    }
  }, 30000); // 30秒超时
  
  // 启动fetch处理
  fetchNotionResponse(
    stream,
    notionRequestBody,
    headers,
    NOTION_API_URL,
    currentCookieData.cookie,
    timeoutId
  ).catch((error) => {
    logger.error(`流处理出错: ${error}`);
    clearTimeout(timeoutId);  // 清除超时计时器
    
    try {
      // 发送错误消息
      const errorChunk = new ChatCompletionChunk({
        choices: [
          new Choice({
            delta: new ChoiceDelta({ content: `处理请求时出错: ${error.message}` }),
            finish_reason: "error"
          })
        ]
      });
      stream.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      stream.write('data: [DONE]\n\n');
    } catch (e) {
      logger.error(`发送错误消息时出错: ${e}`);
    } finally {
      stream.end();
    }
  });
  
  return stream;
}

// 使用fetch调用Notion API并处理流式响应
async function fetchNotionResponse(chunkQueue, notionRequestBody, headers, notionApiUrl, notionCookie, timeoutId) {
  let responseReceived = false;
  let dom = null;
  
  try {
    // 创建JSDOM实例模拟浏览器环境
    dom = new JSDOM("", {
      url: "https://www.notion.so",
      referrer: "https://www.notion.so/chat",
      contentType: "text/html",
      includeNodeLocations: true,
      storageQuota: 10000000,
      pretendToBeVisual: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    });
    
    // 设置全局对象
    const { window } = dom;
    
    // 使用更安全的方式设置全局对象
    try {
      if (!global.window) {
        global.window = window;
      }
      
      if (!global.document) {
        global.document = window.document;
      }
      
      // 安全地设置navigator
      if (!global.navigator) {
        try {
          Object.defineProperty(global, 'navigator', {
            value: window.navigator,
            writable: true,
            configurable: true
          });
        } catch (navError) {
          logger.warning(`无法设置navigator: ${navError.message}，继续执行`);
          // 继续执行，不会中断流程
        }
      }
    } catch (globalError) {
      logger.warning(`设置全局对象时出错: ${globalError.message}`);
    }
    
    // 设置cookie
    document.cookie = notionCookie;
    
    // 创建fetch选项
    const fetchOptions = {
      method: 'POST',
      headers: {
        ...headers,
        'user-agent': window.navigator.userAgent,
        'Cookie': notionCookie
      },
      body: JSON.stringify(notionRequestBody),
    };
    
    // 添加代理配置（如果有）
    if (USE_NATIVE_PROXY_POOL) {
      proxy = proxyPool.getProxy();
      if (proxy !== null)
      {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        fetchOptions.agent = new HttpsProxyAgent(proxy.full);
        logger.info(`使用代理: ${proxy.full}`);
      }
      else{
        logger.warning(`没有可用代理`);
      }
    } else if(PROXY_URL) {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      fetchOptions.agent = new HttpsProxyAgent(PROXY_URL);
      logger.info(`使用代理: ${PROXY_URL}`);
    }
    let response = null;
    // 发送请求
    if (ENABLE_PROXY_SERVER){
      response = await fetch('http://127.0.0.1:10655/proxy', {
        method: 'POST',
        body: JSON.stringify({
          method: 'POST',
          url: notionApiUrl,
          headers: fetchOptions.headers,
          body: fetchOptions.body,
          stream:true
        }),
      });
    }else{
      response = await fetch(notionApiUrl, fetchOptions);
    }

    // 检查是否收到401错误（未授权）
    if (response.status === 401) {
      logger.error(`收到401未授权错误，cookie可能已失效`);
      // 标记当前cookie为无效
      cookieManager.markAsInvalid(currentCookieData.userId);
      // 尝试获取下一个cookie
      currentCookieData = cookieManager.getNext();
      
      if (!currentCookieData) {
        throw new Error('所有cookie均已失效，无法继续请求');
      }
      
      // 使用新cookie重新构建请求体
      const newRequestBody = buildNotionRequest({
        model: notionRequestBody.transcript[0]?.value?.model || '',
        messages: [] // 这里应该根据实际情况重构消息
      });
      
      // 使用新cookie重试请求
      return fetchNotionResponse(
        chunkQueue,
        newRequestBody,
        {
          ...headers,
          'x-notion-active-user-header': currentCookieData.userId,
          'x-notion-space-id': currentCookieData.spaceId
        },
        notionApiUrl,
        currentCookieData.cookie,
        timeoutId
      );
    }
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    // 处理流式响应
    if (!response.body) {
      throw new Error("Response body is null");
    }
    
    // 创建流读取器
    const reader = response.body;
    let buffer = '';
    
    // 处理数据块
    reader.on('data', (chunk) => {
      try {
        // 标记已收到响应
        if (!responseReceived) {
          responseReceived = true;
          logger.info(`已连接Notion API`);
          clearTimeout(timeoutId);  // 清除超时计时器
        }
        
        // 解码数据
        const text = chunk.toString('utf8');
        buffer += text;
        
        // 按行分割并处理完整的JSON对象
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后一行（可能不完整）
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const jsonData = JSON.parse(line);
            
            // 提取内容
            if (jsonData?.type === "markdown-chat" && typeof jsonData?.value === "string") {
              const content = jsonData.value;
              if (!content) continue;
              
              // 创建OpenAI格式的块
              const chunk = new ChatCompletionChunk({
                choices: [
                  new Choice({
                    delta: new ChoiceDelta({ content }),
                    finish_reason: null
                  })
                ]
              });
              
              // 添加到队列
              const dataStr = `data: ${JSON.stringify(chunk)}\n\n`;
              chunkQueue.write(dataStr);
            } else if (jsonData?.recordMap) {
              // 忽略recordMap响应
            } else {
              // 忽略其他类型响应
            }
          } catch (jsonError) {
            logger.error(`解析JSON出错: ${jsonError}`);
          }
        }
      } catch (error) {
        logger.error(`处理数据块出错: ${error}`);
      }
    });
    
    // 处理流结束
    reader.on('end', () => {
      try {
        logger.info(`响应完成`);
        if (cookieManager.getValidCount() > 1){
          // 尝试切换到下一个cookie
          currentCookieData = cookieManager.getNext();
          logger.info(`切换到下一个cookie: ${currentCookieData.userId}`);
        }
        
        // 如果没有收到任何响应，发送一个提示消息
        if (!responseReceived) {
          logger.warning(`未从Notion收到内容响应,请更换ip重试`);
          if (USE_NATIVE_PROXY_POOL) {
            proxyPool.removeProxy(proxy.ip, proxy.port);
          }
          
          const noContentChunk = new ChatCompletionChunk({
            choices: [
              new Choice({
                delta: new ChoiceDelta({ content: "未从Notion收到内容响应,请更换ip重试。" }),
                finish_reason: "no_content"
              })
            ]
          });
          chunkQueue.write(`data: ${JSON.stringify(noContentChunk)}\n\n`);
        }
        
        // 创建结束块
        const endChunk = new ChatCompletionChunk({
          choices: [
            new Choice({
              delta: new ChoiceDelta({ content: null }),
              finish_reason: "stop"
            })
          ]
        });
        
        // 添加到队列
        chunkQueue.write(`data: ${JSON.stringify(endChunk)}\n\n`);
        chunkQueue.write('data: [DONE]\n\n');
        
        // 清除超时计时器（如果尚未清除）
        if (timeoutId) clearTimeout(timeoutId);
        
        // 清理全局对象
        try {
          if (global.window) delete global.window;
          if (global.document) delete global.document;
          
          // 安全地删除navigator
          if (global.navigator) {
            try {
              delete global.navigator;
            } catch (navError) {
              // 如果无法删除，尝试将其设置为undefined
              try {
                Object.defineProperty(global, 'navigator', {
                  value: undefined,
                  writable: true,
                  configurable: true
                });
              } catch (defineError) {
                logger.warning(`无法清理navigator: ${defineError.message}`);
              }
            }
          }
        } catch (cleanupError) {
          logger.warning(`清理全局对象时出错: ${cleanupError.message}`);
        }
        
        // 结束流
        chunkQueue.end();
      } catch (error) {
        logger.error(`Error in stream end handler: ${error}`);
        if (timeoutId) clearTimeout(timeoutId);
        
        // 清理全局对象
        try {
          if (global.window) delete global.window;
          if (global.document) delete global.document;
          
          // 安全地删除navigator
          if (global.navigator) {
            try {
              delete global.navigator;
            } catch (navError) {
              // 如果无法删除，尝试将其设置为undefined
              try {
                Object.defineProperty(global, 'navigator', {
                  value: undefined,
                  writable: true,
                  configurable: true
                });
              } catch (defineError) {
                logger.warning(`无法清理navigator: ${defineError.message}`);
              }
            }
          }
        } catch (cleanupError) {
          logger.warning(`清理全局对象时出错: ${cleanupError.message}`);
        }
        
        chunkQueue.end();
      }
    });
    
    // 处理错误
    reader.on('error', (error) => {
      logger.error(`Stream error: ${error}`);
      if (timeoutId) clearTimeout(timeoutId);
      
      // 清理全局对象
      try {
        if (global.window) delete global.window;
        if (global.document) delete global.document;
        
        // 安全地删除navigator
        if (global.navigator) {
          try {
            delete global.navigator;
          } catch (navError) {
            // 如果无法删除，尝试将其设置为undefined
            try {
              Object.defineProperty(global, 'navigator', {
                value: undefined,
                writable: true,
                configurable: true
              });
            } catch (defineError) {
              logger.warning(`无法清理navigator: ${defineError.message}`);
            }
          }
        }
      } catch (cleanupError) {
        logger.warning(`清理全局对象时出错: ${cleanupError.message}`);
      }
      
      try {
        const errorChunk = new ChatCompletionChunk({
          choices: [
            new Choice({
              delta: new ChoiceDelta({ content: `流读取错误: ${error.message}` }),
              finish_reason: "error"
            })
          ]
        });
        chunkQueue.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        chunkQueue.write('data: [DONE]\n\n');
      } catch (e) {
        logger.error(`Error sending error message: ${e}`);
      } finally {
        chunkQueue.end();
      }
    });
  } catch (error) {
    logger.error(`Notion API请求失败: ${error}`);
    // 清理全局对象
    try {
      if (global.window) delete global.window;
      if (global.document) delete global.document;
      
      // 安全地删除navigator
      if (global.navigator) {
        try {
          delete global.navigator;
        } catch (navError) {
          // 如果无法删除，尝试将其设置为undefined
          try {
            Object.defineProperty(global, 'navigator', {
              value: undefined,
              writable: true,
              configurable: true
            });
          } catch (defineError) {
            logger.warning(`无法清理navigator: ${defineError.message}`);
          }
        }
      }
    } catch (cleanupError) {
      logger.warning(`清理全局对象时出错: ${cleanupError.message}`);
    }
    
    if (timeoutId) clearTimeout(timeoutId);
    if (chunkQueue) chunkQueue.end();
    
    // 确保在错误情况下也触发流结束
    try {
      if (!responseReceived && chunkQueue) {
        const errorChunk = new ChatCompletionChunk({
          choices: [
            new Choice({
              delta: new ChoiceDelta({ content: `Notion API请求失败: ${error.message}` }),
              finish_reason: "error"
            })
          ]
        });
        chunkQueue.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        chunkQueue.write('data: [DONE]\n\n');
      }
    } catch (e) {
      logger.error(`发送错误消息时出错: ${e}`);
    }
    
    throw error; // 重新抛出错误以便上层捕获
  }
}

// 应用初始化
async function initialize() {
  logger.info(`初始化Notion配置...`);
  
  // 启动代理服务器
  try {
    await proxyServer.start();
  } catch (error) {
    logger.error(`启动代理服务器失败: ${error.message}`);
  }
  
  // 初始化cookie管理器
  let initResult = false;
  
  // 检查是否配置了cookie文件
  const cookieFilePath = process.env.COOKIE_FILE;
  if (cookieFilePath) {
    logger.info(`检测到COOKIE_FILE配置: ${cookieFilePath}`);
    initResult = await cookieManager.loadFromFile(cookieFilePath);
    
    if (!initResult) {
      logger.error(`从文件加载cookie失败，尝试使用环境变量中的NOTION_COOKIE`);
    }
  }
  
  // 如果文件加载失败或未配置文件，尝试从环境变量加载
  if (!initResult) {
    const cookiesString = process.env.NOTION_COOKIE;
    if (!cookiesString) {
      logger.error(`错误: 未设置NOTION_COOKIE环境变量或COOKIE_FILE路径，应用无法正常工作`);
      logger.error(`请在.env文件中设置有效的NOTION_COOKIE值或COOKIE_FILE路径`);
      INITIALIZED_SUCCESSFULLY = false;
      return;
    }
    
    logger.info(`正在从环境变量初始化cookie管理器...`);
    initResult = await cookieManager.initialize(cookiesString);
    
    if (!initResult) {
      logger.error(`初始化cookie管理器失败，应用无法正常工作`);
      INITIALIZED_SUCCESSFULLY = false;
      return;
    }
  }
  
  // 获取第一个可用的cookie数据
  currentCookieData = cookieManager.getNext();
  if (!currentCookieData) {
    logger.error(`没有可用的cookie，应用无法正常工作`);
    INITIALIZED_SUCCESSFULLY = false;
    return;
  }
  
  logger.success(`成功初始化cookie管理器，共有 ${cookieManager.getValidCount()} 个有效cookie`);
  logger.info(`当前使用的cookie对应的用户ID: ${currentCookieData.userId}`);
  logger.info(`当前使用的cookie对应的空间ID: ${currentCookieData.spaceId}`);
  
  if (process.env.USE_NATIVE_PROXY_POOL === 'true') {
    logger.info(`正在初始化本地代理池...`);
    await proxyPool.initialize();
  }
  
  INITIALIZED_SUCCESSFULLY = true;
}

// 导出函数
export {
  initialize,
  streamNotionResponse,
  buildNotionRequest,
  INITIALIZED_SUCCESSFULLY
}; 