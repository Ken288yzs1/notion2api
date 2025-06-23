#!/usr/bin/env node

import { cookieManager } from './CookieManager.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import readline from 'readline';
import chalk from 'chalk';

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载环境变量
dotenv.config({ path: join(dirname(__dirname), '.env') });

// 日志配置
const logger = {
  info: (message) => console.log(chalk.blue(`[信息] ${message}`)),
  error: (message) => console.error(chalk.red(`[错误] ${message}`)),
  warning: (message) => console.warn(chalk.yellow(`[警告] ${message}`)),
  success: (message) => console.log(chalk.green(`[成功] ${message}`)),
};

// 创建readline接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// 默认cookie文件路径
const DEFAULT_COOKIE_FILE = 'cookies.txt';

let isSaveCookie = false;
let isAddCookie = false;

// 显示帮助信息
function showHelp() {
  console.log(chalk.cyan('Notion Cookie 管理工具'));
  console.log(chalk.cyan('===================='));
  console.log('');
  console.log('可用命令:');
  console.log('  help      - 显示此帮助信息');
  console.log('  list      - 列出所有cookie');
  console.log('  add       - 添加新的cookie');
  console.log('  validate  - 验证所有cookie');
  console.log('  remove    - 删除指定cookie');
  console.log('  save      - 保存cookie到文件');
  console.log('  load      - 从文件加载cookie');
  console.log('  exit      - 退出程序');
  console.log('');
}

// 列出所有cookie
async function listCookies() {
  if (!cookieManager.initialized || cookieManager.getValidCount() === 0) {
    logger.warning('没有可用的cookie，请先加载或添加cookie');
    return;
  }

  const status = cookieManager.getStatus();
  console.log(chalk.cyan('\nCookie 列表:'));
  console.log(chalk.cyan('==========='));
  
  status.forEach((entry, idx) => {
    const validMark = entry.valid ? chalk.green('✓') : chalk.red('✗');
    console.log(`${idx + 1}. ${validMark} 用户ID: ${entry.userId}, 空间ID: ${entry.spaceId}, 上次使用: ${entry.lastUsed}`);
  });
  
  console.log(`\n共有 ${status.length} 个cookie，${cookieManager.getValidCount()} 个有效\n`);
}

// 添加新cookie
async function addCookie() {
  return new Promise((resolve) => {
    rl.question(chalk.yellow('请输入Notion cookie: '), async (cookie) => {
      if (!cookie || cookie.trim() === '') {
        logger.error('Cookie不能为空');
        resolve();
        return;
      }
      
      logger.info('正在验证cookie...');
      const result = await cookieManager.fetchNotionIds(cookie.trim());
      
      if (result.success) {
        // 如果cookie管理器尚未初始化，先初始化
        if (!cookieManager.initialized) {
          await cookieManager.initialize(cookie.trim());
        } else {
          // 已初始化，直接添加到现有条目
          cookieManager.cookieEntries.push({
            cookie: cookie.trim(),
            spaceId: result.spaceId,
            userId: result.userId,
            valid: true,
            lastUsed: 0
          });
        }
        isAddCookie = true;
        logger.success(`Cookie添加成功! 用户ID: ${result.userId}, 空间ID: ${result.spaceId}`);

      } else {
        logger.error(`Cookie验证失败: ${result.error}`);
      }
      
      resolve();
    });
  });
}

// 验证所有cookie
async function validateCookies() {
  if (!cookieManager.initialized || cookieManager.cookieEntries.length === 0) {
    logger.warning('没有可用的cookie，请先加载或添加cookie');
    return;
  }
  
  logger.info('开始验证所有cookie...');
  
  const originalEntries = [...cookieManager.cookieEntries];
  cookieManager.cookieEntries = [];
  
  for (let i = 0; i < originalEntries.length; i++) {
    const entry = originalEntries[i];
    logger.info(`正在验证第 ${i+1}/${originalEntries.length} 个cookie...`);
    
    const result = await cookieManager.fetchNotionIds(entry.cookie);
    if (result.success) {
      cookieManager.cookieEntries.push({
        cookie: entry.cookie,
        spaceId: result.spaceId,
        userId: result.userId,
        valid: true,
        lastUsed: entry.lastUsed || 0
      });
      logger.success(`第 ${i+1} 个cookie验证成功`);
    } else {
      logger.error(`第 ${i+1} 个cookie验证失败: ${result.error}`);
    }
  }
  
  logger.info(`验证完成，共 ${originalEntries.length} 个cookie，${cookieManager.cookieEntries.length} 个有效`);
}

// 删除指定cookie
async function removeCookie() {
  if (!cookieManager.initialized || cookieManager.cookieEntries.length === 0) {
    logger.warning('没有可用的cookie，请先加载或添加cookie');
    return;
  }
  
  // 先列出所有cookie
  await listCookies();
  
  return new Promise((resolve) => {
    rl.question(chalk.yellow('请输入要删除的cookie编号: '), (input) => {
      const index = parseInt(input) - 1;
      
      if (isNaN(index) || index < 0 || index >= cookieManager.cookieEntries.length) {
        logger.error('无效的编号');
        resolve();
        return;
      }
      
      const removed = cookieManager.cookieEntries.splice(index, 1)[0];
      logger.success(`已删除编号 ${index + 1} 的cookie (用户ID: ${removed.userId.substring(0, 8)}...)`);
      
      // 重置当前索引
      if (cookieManager.cookieEntries.length > 0) {
        cookieManager.currentIndex = 0;
      }
      
      resolve();
    });
  });
}

// 保存cookie到文件
async function saveCookies() {
  if (!cookieManager.initialized || cookieManager.cookieEntries.length === 0) {
    logger.warning('没有可用的cookie，请先加载或添加cookie');
    return;
  }
  
  return new Promise((resolve) => {
    rl.question(chalk.yellow(`请输入保存文件路径 (默认: ${DEFAULT_COOKIE_FILE}): `), (filePath) => {
      const path = filePath.trim() || DEFAULT_COOKIE_FILE;
      
      rl.question(chalk.yellow('是否只保存有效的cookie? (y/n, 默认: y): '), (onlyValidInput) => {
        const onlyValid = onlyValidInput.toLowerCase() !== 'n';
        
        const success = cookieManager.saveToFile(path, onlyValid);
        if (success) {
          logger.success(`Cookie已保存到文件: ${path}`);
          isSaveCookie = true;
        }
        
        resolve();
      });
    });
  });
}

// 从文件加载cookie
async function loadCookies() {
  return new Promise((resolve) => {
    rl.question(chalk.yellow(`请输入cookie文件路径 (默认: ${DEFAULT_COOKIE_FILE}): `), async (filePath) => {
      const path = filePath.trim() || DEFAULT_COOKIE_FILE;
      
      logger.info(`正在从文件加载cookie: ${path}`);
      const success = await cookieManager.loadFromFile(path);
      
      if (success) {
        logger.success(`成功从文件加载cookie，共 ${cookieManager.getValidCount()} 个有效cookie`);
      } else {
        logger.error(`从文件加载cookie失败`);
      }
      
      resolve();
    });
  });
}

// 主函数
async function main() {
  // 显示欢迎信息
  console.log(chalk.cyan('\nNotion Cookie 管理工具'));
  console.log(chalk.cyan('====================\n'));
  
  // 检查是否有环境变量中的cookie
  const envCookie = process.env.NOTION_COOKIE;
  if (envCookie) {
    logger.info('检测到环境变量中的NOTION_COOKIE，正在初始化...');
    await cookieManager.initialize(envCookie);
  }
  
  // 检查是否有环境变量中的cookie文件
  const envCookieFile = process.env.COOKIE_FILE;
  if (envCookieFile && !cookieManager.initialized) {
    logger.info(`检测到环境变量中的COOKIE_FILE: ${envCookieFile}，正在加载...`);
    await cookieManager.loadFromFile(envCookieFile);
  }
  
  // 如果没有cookie，检查默认文件
  if (!cookieManager.initialized && fs.existsSync(DEFAULT_COOKIE_FILE)) {
    logger.info(`检测到默认cookie文件: ${DEFAULT_COOKIE_FILE}，正在加载...`);
    await cookieManager.loadFromFile(DEFAULT_COOKIE_FILE);
  }
  
  showHelp();
  
  // 命令循环
  while (true) {
    const command = await new Promise((resolve) => {
      rl.question(chalk.green('> '), (cmd) => {
        resolve(cmd.trim().toLowerCase());
      });
    });
    
    switch (command) {
      case 'help':
        showHelp();
        break;
      case 'list':
        await listCookies();
        break;
      case 'add':
        await addCookie();
        break;
      case 'validate':
        await validateCookies();
        break;
      case 'remove':
        await removeCookie();
        break;
      case 'save':
        await saveCookies();
        break;
      case 'load':
        await loadCookies();
        break;
      case 'exit':
      case 'quit':
      case 'q':
        logger.info('感谢使用，再见!');
        rl.close();
        process.exit(0);
      default:
        logger.error(`未知命令: ${command}`);
        logger.info('输入 "help" 查看可用命令');
    }
  }
}

// 启动程序
main().catch((error) => {
  logger.error(`程序出错: ${error.message}`);
  process.exit(1);
}); 