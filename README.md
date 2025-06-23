# Notion API 轻量级客户端

这个项目提供了一个轻量级的 Notion API 客户端，可以在资源受限的环境（如 Termux）中运行，无需完整的浏览器环境。

## 特点

- 使用 `node-fetch` 代替 Playwright 浏览器自动化
- 轻量级设计，适合在移动设备和资源受限环境中运行
- 支持 Notion AI 的流式响应
- 兼容 OpenAI API 格式的请求和响应

## 安装

### 依赖项

确保安装以下依赖：

```bash
npm install
```

### 环境变量

创建 `.env` 文件，设置以下环境变量：

```
NOTION_COOKIE=your_notion_cookie_here
NOTION_SPACE_ID=optional_space_id
NOTION_ACTIVE_USER_HEADER=optional_user_id
PROXY_URL=optional_proxy_url
PROXY_AUTH_TOKEN=your_auth_token
PORT=7860
```

## 使用方法

### 启动服务

运行轻量级服务器：

```bash
npm start
```

服务器将在指定端口（默认 7860）启动。

如果需要使用原始的基于 Playwright 的版本（不推荐在 Termux 中使用）：

```bash
npm run original
```

### API 端点

- `GET /v1/models` - 获取可用模型列表
- `POST /v1/chat/completions` - 聊天完成端点
- `GET /health` - 健康检查

### 在 Termux 中运行

1. 安装 Termux 和 Node.js：
```bash
pkg update
pkg install nodejs
```

2. 克隆项目并安装依赖：
```bash
git clone https://github.com/yourusername/notion2api-nodejs.git
cd notion2api-nodejs
npm install
```

3. 设置环境变量并运行：
```bash
npm start
```

## 作为模块集成

你也可以将轻量级客户端作为模块导入到你自己的项目中：

```javascript
import {
  initialize,
  streamNotionResponse,
  buildNotionRequest,
  FETCHED_IDS_SUCCESSFULLY
} from './lightweight-client.js';

// 初始化客户端
await initialize();

// 检查是否成功获取 Notion IDs
if (FETCHED_IDS_SUCCESSFULLY) {
  // 构建请求
  const requestData = {
    notion_model: "openai-gpt-4.1",
    messages: [
      { role: "user", content: "你好，请介绍一下自己" }
    ]
  };
  
  const notionRequestBody = buildNotionRequest(requestData);
  
  // 获取响应流
  const stream = await streamNotionResponse(notionRequestBody);
  
  // 处理响应
  stream.on('data', chunk => {
    console.log(chunk.toString());
  });
}
```

## 故障排除

- 如果无法获取 Notion IDs，请确保提供了有效的 NOTION_COOKIE
- 对于网络问题，可以尝试设置 PROXY_URL
- 查看日志输出以获取详细的错误信息

## 依赖说明

- `node-fetch`: 用于发送 HTTP 请求
- `jsdom`: 提供 DOM API 的轻量级模拟
- `dotenv`: 加载环境变量
- `express`: Web 服务器框架
- `https-proxy-agent`: 支持 HTTPS 代理

## Cookie管理功能

本项目新增了Cookie管理功能，可以更方便地管理多个Notion Cookie，避免在.env文件中手动编辑长字符串。

### 使用方法

#### 1. 通过文件管理Cookie

在项目根目录创建一个`cookies.txt`文件，每行一个完整的Cookie字符串：

```
cookie1_string_here
cookie2_string_here
cookie3_string_here
```

然后在`.env`文件中设置：

```
COOKIE_FILE=cookies.txt
```

系统启动时会自动从该文件加载Cookie。

#### 2. 使用Cookie管理工具

项目提供了一个命令行工具来管理Cookie：

```bash
# 使用npm脚本运行
npm run cookie

# 或者全局安装后运行
npm link
notion-cookie
```

命令行工具支持以下功能：

- `help`: 显示帮助信息
- `list`: 列出所有已加载的Cookie
- `add`: 添加新的Cookie
- `validate`: 验证所有Cookie的有效性
- `remove`: 删除指定的Cookie
- `save`: 保存Cookie到文件
- `load`: 从文件加载Cookie
- `exit`: 退出程序

### Cookie轮询机制

系统会自动轮询使用所有有效的Cookie，当一个Cookie返回401错误（未授权）时，会自动将其标记为无效并切换到下一个Cookie。这样可以提高系统的可靠性和可用性。

### 文件格式支持

Cookie管理器支持两种文件格式：

1. 文本格式（.txt）：每行一个Cookie
2. JSON格式（.json）：包含Cookie数组的JSON文件

```json
{
  "cookies": [
    "cookie1_string_here",
    "cookie2_string_here"
  ],
  "updatedAt": "2023-08-01T12:00:00.000Z",
  "count": 2
}
```

或者简单的数组：

```json
[
  "cookie1_string_here",
  "cookie2_string_here"
]
``` 