import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import os from 'os';
import dotenv from 'dotenv';
import chalk from 'chalk';

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载环境变量
dotenv.config({ path: join(dirname(__dirname), '.env') });

// 日志配置
const logger = {
  info: (message) => console.log(chalk.blue(`[ProxyServer] ${message}`)),
  error: (message) => console.error(chalk.red(`[ProxyServer] ${message}`)),
  warning: (message) => console.warn(chalk.yellow(`[ProxyServer] ${message}`)),
  success: (message) => console.log(chalk.green(`[ProxyServer] ${message}`)),
};

class ProxyServer {
  constructor() {
    this.proxyProcess = null;
    this.platform = process.env.PROXY_SERVER_PLATFORM || 'auto';
    this.port = process.env.PROXY_SERVER_PORT || 10655;
    this.logPath = process.env.PROXY_SERVER_LOG_PATH || './proxy_server.log';
    this.enabled = process.env.ENABLE_PROXY_SERVER === 'true';
    this.proxyAuthToken = process.env.PROXY_AUTH_TOKEN || 'default_token';
    this.logStream = null;
  }

  // 获取当前系统平台
  detectPlatform() {
    if (this.platform !== 'auto') {
      return this.platform;
    }

    const platform = os.platform();
    const arch = os.arch();

    if (platform === 'win32') {
      return 'windows';
    } else if (platform === 'linux') {
      if (arch === 'arm64') {
        return 'android';
      } else {
        return 'linux';
      }
    } else if (platform === 'android') {
      return 'android';
    } else {
      logger.warning(`未知平台: ${platform}, ${arch}, 默认使用linux版本`);
      return 'linux';
    }
  }

  // 获取代理服务器可执行文件路径
  getProxyServerPath() {
    const platform = this.detectPlatform();
    const proxyDir = join(__dirname, 'proxy');

    switch (platform) {
      case 'windows':
        return join(proxyDir, 'chrome_proxy_server_windows_amd64.exe');
      case 'linux':
        return join(proxyDir, 'chrome_proxy_server_linux_amd64');
      case 'android':
        return join(proxyDir, 'chrome_proxy_server_android_arm64');
      default:
        logger.error(`不支持的平台: ${platform}`);
        return null;
    }
  }

  // 启动代理服务器
  async start() {
    if (!this.enabled) {
      logger.info('代理服务器未启用，跳过启动');
      return;
    }

    if (this.proxyProcess) {
      logger.warning('代理服务器已经在运行中');
      return;
    }

    const proxyServerPath = this.getProxyServerPath();
    if (!proxyServerPath) {
      logger.error('无法获取代理服务器路径');
      return;
    }

    try {
      // 确保可执行文件有执行权限（在Linux/Android上）
      if (this.detectPlatform() !== 'windows') {
        try {
          fs.chmodSync(proxyServerPath, 0o755);
        } catch (err) {
          logger.warning(`无法设置执行权限: ${err.message}`);
        }
      }

      // 创建日志文件
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
      
      // 修复 stdio 参数问题
      // 启动代理服务器进程
      this.proxyProcess = spawn(proxyServerPath, [
        '--port', this.port.toString(),
        '--token', this.proxyAuthToken
      ], {
        stdio: ['ignore', 'pipe', 'pipe'], // 使用pipe而不是直接传递流
        detached: false
      });

      // 将进程的输出重定向到日志文件
      if (this.proxyProcess.stdout) {
        this.proxyProcess.stdout.pipe(this.logStream);
      }
      
      if (this.proxyProcess.stderr) {
        this.proxyProcess.stderr.pipe(this.logStream);
      }

      // 设置进程事件处理
      this.proxyProcess.on('error', (err) => {
        logger.error(`代理服务器启动失败: ${err.message}`);
        this.proxyProcess = null;
        if (this.logStream) {
          this.logStream.end();
          this.logStream = null;
        }
      });

      this.proxyProcess.on('exit', (code, signal) => {
        logger.info(`代理服务器已退出，退出码: ${code}, 信号: ${signal}`);
        this.proxyProcess = null;
        if (this.logStream) {
          this.logStream.end();
          this.logStream = null;
        }
      });

      // 等待一段时间，确保服务器启动
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (this.proxyProcess && this.proxyProcess.exitCode === null) {
        logger.success(`代理服务器已启动，端口: ${this.port}, 日志文件: ${this.logPath}`);
        return true;
      } else {
        logger.error('代理服务器启动失败');
        if (this.logStream) {
          this.logStream.end();
          this.logStream = null;
        }
        return false;
      }
    } catch (error) {
      logger.error(`启动代理服务器时出错: ${error.message}`);
      if (this.logStream) {
        this.logStream.end();
        this.logStream = null;
      }
      return false;
    }
  }

  // 停止代理服务器
  stop() {
    if (!this.proxyProcess) {
      //logger.info('代理服务器已关闭');
      return;
    }

    try {
      // 在Windows上使用taskkill确保子进程也被终止
      if (this.detectPlatform() === 'windows' && this.proxyProcess.pid) {
        spawn('taskkill', ['/pid', this.proxyProcess.pid, '/f', '/t']);
      } else {
        // 在Linux/Android上使用kill信号
        this.proxyProcess.kill('SIGTERM');
      }

      logger.success('代理服务器已停止');
    } catch (error) {
      logger.error(`停止代理服务器时出错: ${error.message}`);
    } finally {
      this.proxyProcess = null;
      if (this.logStream) {
        this.logStream.end();
        this.logStream = null;
      }
    }
  }
}

// 创建单例
const proxyServer = new ProxyServer();

// 导出
export { proxyServer }; 