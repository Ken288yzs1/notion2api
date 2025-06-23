import express from 'express';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import chalk from 'chalk';
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

// 日志配置
const logger = {
  info: (message) => console.log(chalk.blue(`[info] ${message}`)),
  error: (message) => console.error(chalk.red(`[error] ${message}`)),
  warning: (message) => console.warn(chalk.yellow(`[warn] ${message}`)),
  success: (message) => console.log(chalk.green(`[success] ${message}`)),
  request: (method, path, status, time) => {
    const statusColor = status >= 500 ? chalk.red : 
                        status >= 400 ? chalk.yellow : 
                        status >= 300 ? chalk.cyan : 
                        status >= 200 ? chalk.green : chalk.white;
    console.log(`${chalk.magenta(`[${method}]`)} - ${path} ${statusColor(status)} ${chalk.gray(`${time}ms`)}`);
  }
};

// 认证配置
const EXPECTED_TOKEN = process.env.PROXY_AUTH_TOKEN || "default_token";

// 创建Express应用
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  
  // 保存原始的 end 方法
  const originalEnd = res.end;
  
  // 重写 end 方法以记录请求完成时间
  res.end = function(...args) {
    const duration = Date.now() - start;
    logger.request(req.method, req.path, res.statusCode, duration);
    return originalEnd.apply(this, args);
  };
  
  next();
});

// 认证中间件
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: {
        message: "Authentication required. Please provide a valid Bearer token.",
        type: "authentication_error"
      }
    });
  }
  
  const token = authHeader.split(' ')[1];
  
  if (token !== EXPECTED_TOKEN) {
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
  // 返回可用模型列表
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
  try {
    // 检查是否成功初始化
    if (!INITIALIZED_SUCCESSFULLY) {
      return res.status(500).json({
        error: {
          message: "系统未成功初始化。请检查您的NOTION_COOKIE是否有效。",
          type: "server_error"
        }
      });
    }
    
    // 检查是否有可用的cookie
    if (cookieManager.getValidCount() === 0) {
      return res.status(500).json({
        error: {
          message: "没有可用的有效cookie。请检查您的NOTION_COOKIE配置。",
          type: "server_error"
        }
      });
    }
    
    // 验证请求数据
    const requestData = req.body;
    
    if (!requestData.messages || !Array.isArray(requestData.messages) || requestData.messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "Invalid request: 'messages' field must be a non-empty array.",
          type: "invalid_request_error"
        }
      });
    }
    
    // 构建Notion请求
    const notionRequestBody = buildNotionRequest(requestData);
    
    // 处理流式响应
    if (requestData.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      logger.info(`开始流式响应`);
      const stream = await streamNotionResponse(notionRequestBody);
      stream.pipe(res);
      
      // 处理客户端断开连接
      req.on('close', () => {
        stream.end();
      });
    } else {
      // 非流式响应
      // 创建一个内部流来收集完整响应
      logger.info(`开始非流式响应`);
      const chunks = [];
      const stream = await streamNotionResponse(notionRequestBody);
      
      return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          const chunkStr = chunk.toString();
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
              logger.error(`解析非流式响应块时出错: ${error}`);
            }
          }
        });
        
        stream.on('end', () => {
          const fullResponse = {
            id: `chatcmpl-${randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: requestData.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: chunks.join('')
                },
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: null,
              completion_tokens: null,
              total_tokens: null
            }
          };
          
          res.json(fullResponse);
          resolve();
        });
        
        stream.on('error', (error) => {
          logger.error(`非流式响应出错: ${error}`);
          reject(error);
        });
      });
    }
  } catch (error) {
    logger.error(`聊天完成端点错误: ${error}`);
    res.status(500).json({
      error: {
        message: `Internal server error: ${error.message}`,
        type: "server_error"
      }
    });
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

// 初始化并启动服务器
initialize().then(() => {
  app.listen(PORT, () => {
    logger.info(`服务已启动 - 端口: ${PORT}`);
    logger.info(`访问地址: http://localhost:${PORT}`);
    
    if (INITIALIZED_SUCCESSFULLY) {
      logger.success(`系统初始化状态: ✅`);
      logger.success(`可用cookie数量: ${cookieManager.getValidCount()}`);
    } else {
      logger.warning(`系统初始化状态: ❌`);
      logger.warning(`警告: 系统未成功初始化，API调用将无法正常工作`);
      logger.warning(`请检查NOTION_COOKIE配置是否有效`);
    }
  });
}).catch((error) => {
  logger.error(`初始化失败: ${error}`);
}); 