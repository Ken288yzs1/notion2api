import express from 'express';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pino from 'pino';
import pinoHttp from 'pino-http';

// 导入您自己的模块
import {
  ChatMessage, ChatCompletionRequest, Choice, ChoiceDelta, ChatCompletionChunk
} from './models.js';
import {
  initialize,
  streamNotionResponse,
  buildNotionRequest,
  INITIALIZED_SUCCESSFULLY
} from './lightweight-client.js';
import { proxyPool } from './ProxyPool.js';
import { cookieManager } from './CookieManager.js';

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载环境变量
dotenv.config({ path: join(dirname(__dirname), '.env') });

// --- 新的日志配置 (使用 pino) ---
// 在生产环境 (如 Render) 中，它会输出 JSON 格式的日志
// 在本地开发中 (当 NODE_ENV 不是 'production')，它会使用 pino-pretty 美化输出
const logger = pino({
  level: process.env.LOG_LEVEL || 'info', // 可以通过环境变量控制日志级别
  transport: process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

// 认证配置
const EXPECTED_TOKEN = process.env.PROXY_AUTH_TOKEN || "default_token";

// 创建Express应用
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- 新的请求日志中间件 (使用 pino-http) ---
// 它会自动记录每个请求的详细信息，并为每个请求附加一个唯一的ID
app.use(pinoHttp({ logger }));

// 认证中间件
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // req.log 是由 pino-http 添加的，它包含了请求ID
    req.log.warn('Authentication failed: Missing or malformed Bearer token.');
    return res.status(401).json({
      error: {
        message: "Authentication required. Please provide a valid Bearer token.",
        type: "authentication_error"
      }
    });
  }
  
  const token = authHeader.split(' ')[1];
  
  if (token !== EXPECTED_TOKEN) {
    req.log.warn('Authentication failed: Invalid token provided.');
    return res.status(401).json({
      error: {
        message: "Invalid authentication credentials",
        type: "authentication_error"
      }
    });
  }
  
  next();
}

// API路由

// 获取模型列表
app.get('/v1/models', authenticate, (req, res) => {
  const modelList = {
    data: [
      { id: "openai-gpt-4.1" },
      { id: "anthropic-opus-4" },
      { id: "anthropic-sonnet-4" },
      { id: "anthropic-sonnet-3.x-stable" }
    ]
  };
  
  res.json(modelList);
});

// 聊天完成端点
app.post('/v1/chat/completions', authenticate, async (req, res) => {
  // 使用 pino-http 提供的 req.log，它会自动包含请求ID
  req.log.info('Received new chat completion request.');
  
  try {
    if (!INITIALIZED_SUCCESSFULLY) {
      req.log.error('System not initialized. Cannot process request.');
      return res.status(500).json({
        error: { message: "系统未成功初始化。请检查您的NOTION_COOKIE是否有效。", type: "server_error" }
      });
    }
    
    if (cookieManager.getValidCount() === 0) {
      req.log.error('No valid cookies available. Cannot process request.');
      return res.status(500).json({
        error: { message: "没有可用的有效cookie。请检查您的NOTION_COOKIE配置。", type: "server_error" }
      });
    }
    
    const requestData = req.body;
    req.log.info({ model: requestData.model, stream: requestData.stream }, 'Processing request details.');
    
    if (!requestData.messages || !Array.isArray(requestData.messages) || requestData.messages.length === 0) {
      req.log.warn('Invalid request: messages field is missing or empty.');
      return res.status(400).json({
        error: { message: "Invalid request: 'messages' field must be a non-empty array.", type: "invalid_request_error" }
      });
    }
    
    const notionRequestBody = buildNotionRequest(requestData);
    req.log.debug({ notionRequest: notionRequestBody }, 'Built Notion request body.');
    
    if (requestData.stream) {
      res.setHeader('Content-Type', 'text-event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      req.log.info('Starting stream response.');
      const stream = await streamNotionResponse(notionRequestBody);

      stream.on('error', (streamError) => {
        // 关键：监听流本身可能发生的错误
        req.log.error(streamError, 'Error occurred within the Notion response stream.');
      });

      stream.pipe(res);
      
      req.on('close', () => {
        req.log.warn('Client disconnected, terminating stream.');
        stream.end();
      });
    } else {
      req.log.info('Starting non-stream response.');
      const chunks = [];
      const stream = await streamNotionResponse(notionRequestBody);
      
      return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          const chunkStr = chunk.toString();
          // 使用 trace 级别记录非常详细的日志，默认不显示
          req.log.trace({ chunk: chunkStr }, 'Received non-stream data chunk.');
          if (chunkStr.startsWith('data: ') && !chunkStr.includes('[DONE]')) {
            try {
              const dataJson = chunkStr.substring(6).trim();
              if (dataJson) {
                const chunkData = JSON.parse(dataJson);
                if (chunkData.choices && chunkData.choices[0].delta && chunkData.choices[0].delta.content) {
                  chunks.push(chunkData.choices[0].delta.content);
                }
              }
            } catch (error) {
              req.log.error(error, 'Failed to parse non-stream response chunk.');
            }
          }
        });
        
        stream.on('end', () => {
          req.log.info('Non-stream response finished. Assembling final response.');
          const fullResponse = {
            id: `chatcmpl-${randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: requestData.model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: chunks.join('') },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }
          };
          
          res.json(fullResponse);
          resolve();
        });
        
        stream.on('error', (error) => {
          req.log.error(error, 'Error during non-stream response processing.');
          if (!res.headersSent) {
            res.status(500).json({ error: { message: 'Stream processing failed' }});
          }
          reject(error);
        });
      });
    }
  } catch (error) {
    // pino 会自动处理 error 对象，并将其堆栈信息记录下来
    req.log.error(error, 'Caught a critical error in chat completions endpoint.');
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: `Internal server error: ${error.message}`, type: "server_error" }
      });
    }
  }
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    initialized: INITIALIZED_SUCCESSFULLY,
    valid_cookies: cookieManager.getValidCount()
  });
});

// Cookie状态查询端点
app.get('/cookies/status', authenticate, (req, res) => {
  res.json({
    total_cookies: cookieManager.getValidCount(),
    cookies: cookieManager.getStatus()
  });
});

// 启动服务器
const PORT = process.env.PORT || 7860;

initialize().then(() => {
  app.listen(PORT, () => {
    logger.info(`Server started successfully on port ${PORT}`);
    logger.info(`Listening at http://0.0.0.0:${PORT}`);
    
    if (INITIALIZED_SUCCESSFULLY) {
      logger.info(`System initialization status: OK`);
      logger.info(`Available cookies: ${cookieManager.getValidCount()}`);
    } else {
      logger.warn(`System initialization status: FAILED`);
      logger.warn(`Warning: System did not initialize successfully. API calls will fail.`);
      logger.warn(`Please check if your NOTION_COOKIE is valid.`);
    }
  });
}).catch((error) => {
  // 使用 fatal 级别记录导致应用无法启动的严重错误
  logger.fatal(error, `Initialization failed, application cannot start.`);
  process.exit(1); // 启动失败时退出
});
