import { JSDOM } from 'jsdom';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 日志配置
const logger = {
  info: (message) => console.log(`\x1b[34m[info] ${message}\x1b[0m`),
  error: (message) => console.error(`\x1b[31m[error] ${message}\x1b[0m`),
  warning: (message) => console.warn(`\x1b[33m[warn] ${message}\x1b[0m`),
  success: (message) => console.log(`\x1b[32m[success] ${message}\x1b[0m`),
};

class CookieManager {
  constructor() {
    this.cookieEntries = []; // 存储cookie及其对应的ID
    this.currentIndex = 0;
    this.initialized = false;
    this.maxRetries = 3; // 最大重试次数
    this.proxyUrl = process.env.PROXY_URL || "";
  }

  /**
   * 从文件加载cookie
   * @param {string} filePath - cookie文件路径
   * @returns {Promise<boolean>} - 是否加载成功
   */
  async loadFromFile(filePath) {
    try {
      // 确保文件路径是绝对路径
      const absolutePath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(dirname(__dirname), filePath);
      
      logger.info(`从文件加载cookie: ${absolutePath}`);
      
      // 检查文件是否存在
      if (!fs.existsSync(absolutePath)) {
        logger.error(`Cookie文件不存在: ${absolutePath}`);
        return false;
      }
      
      // 读取文件内容
      const fileContent = fs.readFileSync(absolutePath, 'utf8');
      
      // 根据文件扩展名处理不同格式
      const ext = path.extname(absolutePath).toLowerCase();
      let cookieArray = [];
      
      if (ext === '.json') {
        // JSON格式
        try {
          const jsonData = JSON.parse(fileContent);
          if (Array.isArray(jsonData)) {
            cookieArray = jsonData;
          } else if (jsonData.cookies && Array.isArray(jsonData.cookies)) {
            cookieArray = jsonData.cookies;
          } else {
            logger.error('JSON文件格式错误，应为cookie数组或包含cookies数组的对象');
            return false;
          }
        } catch (error) {
          logger.error(`解析JSON文件失败: ${error.message}`);
          return false;
        }
      } else {
        // 文本格式，每行一个cookie
        cookieArray = fileContent
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));
      }
      
      logger.info(`从文件中读取了 ${cookieArray.length} 个cookie`);
      
      // 初始化cookie
      return await this.initialize(cookieArray.join('|'));
      
    } catch (error) {
      logger.error(`从文件加载cookie失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 初始化cookie管理器
   * @param {string} cookiesString - 以"|"分隔的cookie字符串
   * @returns {Promise<boolean>} - 是否初始化成功
   */
  async initialize(cookiesString) {
    if (!cookiesString) {
      logger.error('未提供cookie字符串');
      return false;
    }

    // 分割cookie字符串
    const cookieArray = cookiesString.split('|').map(c => c.trim()).filter(c => c);
    
    if (cookieArray.length === 0) {
      logger.error('没有有效的cookie');
      return false;
    }

    logger.info(`发现 ${cookieArray.length} 个cookie，开始获取对应的ID信息...`);

    // 清空现有条目
    this.cookieEntries = [];
    
    // 为每个cookie获取ID
    for (let i = 0; i < cookieArray.length; i++) {
      const cookie = cookieArray[i];
      logger.info(`正在处理第 ${i+1}/${cookieArray.length} 个cookie...`);
      
      const result = await this.fetchNotionIds(cookie);
      if (result.success) {
        this.cookieEntries.push({
          cookie,
          spaceId: result.spaceId,
          userId: result.userId,
          valid: true,
          lastUsed: 0 // 记录上次使用时间戳
        });
        logger.success(`第 ${i+1} 个cookie验证成功`);
      } else {
        if (result.status === 401) {
          logger.error(`第 ${i+1} 个cookie无效（401未授权），已跳过`);
        } else {
          logger.warning(`第 ${i+1} 个cookie验证失败: ${result.error}，已跳过`);
        }
      }
    }

    // 检查是否有有效的cookie
    if (this.cookieEntries.length === 0) {
      logger.error('没有有效的cookie，初始化失败');
      return false;
    }

    logger.success(`成功初始化 ${this.cookieEntries.length}/${cookieArray.length} 个cookie`);
    this.initialized = true;
    this.currentIndex = 0;
    return true;
  }

  /**
   * 保存cookie到文件
   * @param {string} filePath - 保存路径
   * @param {boolean} onlyValid - 是否只保存有效的cookie
   * @returns {boolean} - 是否保存成功
   */
  saveToFile(filePath, onlyValid = true) {
    try {
      // 确保文件路径是绝对路径
      const absolutePath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(dirname(__dirname), filePath);
      
      // 获取要保存的cookie
      const cookiesToSave = onlyValid 
        ? this.cookieEntries.filter(entry => entry.valid).map(entry => entry.cookie)
        : this.cookieEntries.map(entry => entry.cookie);
      
      // 根据文件扩展名选择保存格式
      const ext = path.extname(absolutePath).toLowerCase();
      
      if (ext === '.json') {
        // 保存为JSON格式
        const jsonData = {
          cookies: cookiesToSave,
          updatedAt: new Date().toISOString(),
          count: cookiesToSave.length
        };
        fs.writeFileSync(absolutePath, JSON.stringify(jsonData, null, 2), 'utf8');
      } else {
        // 保存为文本格式，每行一个cookie
        const content = cookiesToSave.join('\n');
        fs.writeFileSync(absolutePath, content, 'utf8');
      }
      
      logger.success(`已将 ${cookiesToSave.length} 个cookie保存到文件: ${absolutePath}`);
      return true;
    } catch (error) {
      logger.error(`保存cookie到文件失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 获取Notion的空间ID和用户ID
   * @param {string} cookie - Notion cookie
   * @returns {Promise<Object>} - 包含ID信息的对象
   */
  async fetchNotionIds(cookie, retryCount = 0) {
    if (!cookie) {
      return { success: false, error: '未提供cookie' };
    }

    try {
      // 创建JSDOM实例模拟浏览器环境
      const dom = new JSDOM("", {
        url: "https://www.notion.so",
        referrer: "https://www.notion.so/",
        contentType: "text/html",
        includeNodeLocations: true,
        storageQuota: 10000000,
        pretendToBeVisual: true,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
      });
      
      // 设置全局对象
      const { window } = dom;
      
      // 安全地设置全局对象
      if (!global.window) global.window = window;
      if (!global.document) global.document = window.document;
      
      // 设置navigator
      if (!global.navigator) {
        try {
          Object.defineProperty(global, 'navigator', {
            value: window.navigator,
            writable: true,
            configurable: true
          });
        } catch (navError) {
          logger.warning(`无法设置navigator: ${navError.message}，继续执行`);
        }
      }
      
      // 设置cookie
      document.cookie = cookie;
      
      // 创建fetch选项
      const fetchOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'accept': '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'notion-audit-log-platform': 'web',
          'notion-client-version': '23.13.0.3686',
          'origin': 'https://www.notion.so',
          'referer': 'https://www.notion.so/',
          'user-agent': window.navigator.userAgent,
          'Cookie': cookie
        },
        body: JSON.stringify({}),
      };
      
      // 添加代理配置（如果有）
      if (this.proxyUrl) {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        fetchOptions.agent = new HttpsProxyAgent(this.proxyUrl);
        logger.info(`使用代理: ${this.proxyUrl}`);
      }
      
      // 发送请求
      const response = await fetch("https://www.notion.so/api/v3/getSpaces", fetchOptions);
      
      // 检查响应状态
      if (response.status === 401) {
        return { success: false, status: 401, error: '未授权，cookie无效' };
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      
      // 提取用户ID
      const userIdKey = Object.keys(data)[0];
      if (!userIdKey) {
        throw new Error('无法从响应中提取用户ID');
      }
      
      const userId = userIdKey;
      
      // 提取空间ID
      const userRoot = data[userIdKey]?.user_root?.[userIdKey];
      const spaceViewPointers = userRoot?.value?.value?.space_view_pointers;
      
      if (!spaceViewPointers || !Array.isArray(spaceViewPointers) || spaceViewPointers.length === 0) {
        throw new Error('在响应中找不到space_view_pointers或spaceId');
      }
      
      const spaceId = spaceViewPointers[0].spaceId;
      
      if (!spaceId) {
        throw new Error('无法从space_view_pointers中提取spaceId');
      }
      
      // 清理全局对象
      this.cleanupGlobalObjects();
      
      return {
        success: true,
        userId,
        spaceId
      };
      
    } catch (error) {
      // 清理全局对象
      this.cleanupGlobalObjects();
      
      // 重试逻辑
      if (retryCount < this.maxRetries && error.message !== '未授权，cookie无效') {
        logger.warning(`获取Notion ID失败，正在重试 (${retryCount + 1}/${this.maxRetries}): ${error.message}`);
        return await this.fetchNotionIds(cookie, retryCount + 1);
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 清理全局对象
   */
  cleanupGlobalObjects() {
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
  }

  /**
   * 获取下一个可用的cookie及其ID
   * @returns {Object|null} - cookie及其对应的ID，如果没有可用cookie则返回null
   */
  getNext() {
    if (!this.initialized || this.cookieEntries.length === 0) {
      return null;
    }

    // 轮询选择下一个cookie
    const entry = this.cookieEntries[this.currentIndex];
    
    // 更新索引，实现轮询
    this.currentIndex = (this.currentIndex + 1) % this.cookieEntries.length;
    
    // 更新最后使用时间
    entry.lastUsed = Date.now();
    
    return {
      cookie: entry.cookie,
      spaceId: entry.spaceId,
      userId: entry.userId
    };
  }

  /**
   * 标记cookie为无效
   * @param {string} userId - 用户ID
   */
  markAsInvalid(userId) {
    const index = this.cookieEntries.findIndex(entry => entry.userId === userId);
    if (index !== -1) {
      this.cookieEntries[index].valid = false;
      logger.warning(`已将用户ID为 ${userId} 的cookie标记为无效`);
      
      // 过滤掉所有无效的cookie
      this.cookieEntries = this.cookieEntries.filter(entry => entry.valid);
      
      // 重置当前索引
      if (this.cookieEntries.length > 0) {
        this.currentIndex = 0;
      }
    }
  }

  /**
   * 获取有效cookie的数量
   * @returns {number} - 有效cookie的数量
   */
  getValidCount() {
    return this.cookieEntries.filter(entry => entry.valid).length;
  }

  /**
   * 获取所有cookie的状态信息
   * @returns {Array} - cookie状态数组
   */
  getStatus() {
    return this.cookieEntries.map((entry, index) => ({
      index,
      userId: entry.userId.substring(0, 8) + '...',
      spaceId: entry.spaceId.substring(0, 8) + '...',
      valid: entry.valid,
      lastUsed: entry.lastUsed ? new Date(entry.lastUsed).toLocaleString() : 'never'
    }));
  }
}

export const cookieManager = new CookieManager(); 