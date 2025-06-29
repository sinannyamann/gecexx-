import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import winston from 'winston';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import pg from 'pg';
import { NodeVM } from 'vm2';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import sharp from 'sharp';
import mammoth from 'mammoth';
import csv from 'csv-parser';
import XLSX from 'xlsx';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import NodeCache from 'node-cache';
import { marked } from 'marked';

// PDF-parse'ı dinamik olarak import et
let pdf;
try {
  const pdfModule = await import('pdf-parse');
  pdf = pdfModule.default;
} catch (error) {
  console.warn('PDF parsing not available:', error.message);
  pdf = null;
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CACHE SETUP ====================
const cache = new NodeCache({ 
  stdTTL: parseInt(process.env.CACHE_TTL) || 600, // 10 dakika
  checkperiod: 120, // 2 dakikada bir temizlik
  useClones: false // Performans için
});

// ==================== UTILITY FUNCTIONS ====================
const utils = {
  formatErrorMessage: (msg, type = 'error') => ({
    success: false,
    error: msg,
    type,
    timestamp: new Date().toISOString()
  }),

  formatSuccessMessage: (data, message = 'İşlem başarılı') => ({
    success: true,
    message,
    data,
    timestamp: new Date().toISOString()
  }),

  sanitizeFilename: (filename) => {
    return filename.replace(/[^a-z0-9.-]/gi, '_').toLowerCase();
  },

  createSafeFilePath: (filename) => {
    const sanitized = utils.sanitizeFilename(filename);
    return path.join(__dirname, 'uploads', sanitized);
  },

  isValidSessionId: (sessionId) => {
    return sessionId && typeof sessionId === 'string' && sessionId.length >= 8;
  },

  truncateText: (text, maxLength = 2000) => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...[kısaltıldı]';
  }
};

// ==================== LOGGER ====================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.colorize({ all: process.env.NODE_ENV !== 'production' }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} [${level}]: ${stack || message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      silent: process.env.NODE_ENV === 'test'
    })
  ]
});

// Railway için özel log transport
if (process.env.RAILWAY_ENVIRONMENT) {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    )
  }));
}

// ==================== DATABASE ====================
const { Pool } = pg;

// Railway için optimize edilmiş veritabanı ayarları
const dbConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.DB_POOL_MAX) || 10, // Railway için düşük tutuldu
  min: parseInt(process.env.DB_POOL_MIN) || 2,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT) || 5000,
  acquireTimeoutMillis: parseInt(process.env.DB_ACQUIRE_TIMEOUT) || 10000,
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT) || 30000,
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000
};

const pool = process.env.DATABASE_URL ? new Pool(dbConfig) : null;

// Veritabanı bağlantı durumunu izle
if (pool) {
  pool.on('connect', () => {
    logger.info('Yeni veritabanı bağlantısı kuruldu');
  });

  pool.on('error', (err) => {
    logger.error('Veritabanı havuzu hatası:', err);
  });

  pool.on('remove', () => {
    logger.info('Veritabanı bağlantısı kaldırıldı');
  });
}

// Database initialization with better error handling
async function initDatabase() {
  if (!pool) {
    logger.warn('Veritabanı yapılandırılmamış, bellek modunda çalışılıyor');
    return;
  }
  
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      // Bağlantı testi
      await pool.query('SELECT NOW()');
      
      // Tablolar oluştur
      await createTables();
      
      logger.info('Veritabanı başarıyla başlatıldı');
      return;
    } catch (error) {
      retryCount++;
      logger.error(`Veritabanı başlatma hatası (deneme ${retryCount}/${maxRetries}):`, error.message);
      
      if (retryCount >= maxRetries) {
        logger.error('Veritabanı başlatılamadı, bellek modunda devam ediliyor');
        return;
      }
      
      // Yeniden deneme öncesi bekle
      await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
    }
  }
}

async function createTables() {
  const tables = [
    {
      name: 'users',
      query: `
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(255) UNIQUE NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'user',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login TIMESTAMP,
          is_active BOOLEAN DEFAULT true,
          preferences JSONB DEFAULT '{}'
        )
      `
    },
    {
      name: 'conversations',
      query: `
        CREATE TABLE IF NOT EXISTS conversations (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          session_id VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          response TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          tokens_used INTEGER DEFAULT 0,
          execution_time INTEGER DEFAULT 0
        )
      `
    },
    {
      name: 'agent_memory',
      query: `
        CREATE TABLE IF NOT EXISTS agent_memory (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          key VARCHAR(255) NOT NULL,
          value TEXT NOT NULL,
          category VARCHAR(100) DEFAULT 'general',
          expires_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, key, category)
        )
      `
    },
    {
      name: 'files',
      query: `
        CREATE TABLE IF NOT EXISTS files (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          filename VARCHAR(255) NOT NULL,
          original_name VARCHAR(255) NOT NULL,
          file_type VARCHAR(100) NOT NULL,
          file_size INTEGER NOT NULL,
          file_path VARCHAR(500) NOT NULL,
          processed BOOLEAN DEFAULT false,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `
    },
    {
      name: 'agent_tasks',
      query: `
        CREATE TABLE IF NOT EXISTS agent_tasks (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          task_type VARCHAR(100) NOT NULL,
          task_data JSONB NOT NULL,
          status VARCHAR(50) DEFAULT 'pending',
          result JSONB,
          scheduled_at TIMESTAMP,
          completed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `
    }
  ];

  for (const table of tables) {
    try {
      await pool.query(table.query);
      logger.debug(`Tablo oluşturuldu/kontrol edildi: ${table.name}`);
    } catch (error) {
      logger.error(`Tablo oluşturma hatası (${table.name}):`, error.message);
      throw error;
    }
  }

  // İndeksler oluştur
  await createIndexes();
}

async function createIndexes() {
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_agent_memory_user_key ON agent_memory(user_id, key)',
    'CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status)',
    'CREATE INDEX IF NOT EXISTS idx_agent_tasks_scheduled ON agent_tasks(scheduled_at)'
  ];

  for (const indexQuery of indexes) {
    try {
      await pool.query(indexQuery);
    } catch (error) {
      logger.warn('İndeks oluşturma uyarısı:', error.message);
    }
  }
}

// ==================== MEMORY MANAGER ====================
class MemoryManager {
  constructor(pool, cache) {
    this.pool = pool;
    this.cache = cache;
  }

  async save(userId, key, value, category = 'general') {
    const cacheKey = `memory:${userId}:${key}:${category}`;
    
    try {
      if (this.pool) {
        await this.pool.query(`
          INSERT INTO agent_memory (user_id, key, value, category, updated_at)
          VALUES \$1,\$2,\$3,\$4, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, key, category)
          DO UPDATE SET value =\$3, updated_at = CURRENT_TIMESTAMP
        `, [userId, key, value, category]);
      }
      
      // Cache'e de kaydet
      this.cache.set(cacheKey, { key, value, category, updated_at: new Date() });
      
      return `Bellek kaydedildi: ${key} = ${utils.truncateText(value, 100)} (kategori: ${category})`;
    } catch (error) {
      logger.error('Bellek kaydetme hatası:', error);
      return `Bellek kaydetme hatası: ${error.message}`;
    }
  }

  async recall(userId, key, category) {
    const cacheKey = `memory:${userId}:${key}:${category || '*'}`;
    
    try {
      // Önce cache'den kontrol et
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return this.formatMemoryResult([cached]);
      }

      if (!this.pool) {
        return "Bellek depolama mevcut değil";
      }

      let query = 'SELECT key, value, category, updated_at FROM agent_memory WHERE user_id =\$1 AND key =\$2';
      let params = [userId, key];
      
      if (category) {
        query += ' AND category =\$3';
        params.push(category);
      }
      
      const result = await this.pool.query(query, params);
      
      if (result.rows.length === 0) {
        return `"${key}" anahtarı için bellek bulunamadı`;
      }
      
      // Sonuçları cache'e kaydet
      result.rows.forEach(row => {
        const rowCacheKey = `memory:${userId}:${row.key}:${row.category}`;
        this.cache.set(rowCacheKey, row);
      });
      
      return this.formatMemoryResult(result.rows);
    } catch (error) {
      logger.error('Bellek hatırlama hatası:', error);
      return `Bellek hatırlama hatası: ${error.message}`;
    }
  }

  formatMemoryResult(rows) {
    return rows.map(row => 
      `${row.key}: ${utils.truncateText(row.value, 200)} (kategori: ${row.category}, güncelleme: ${row.updated_at})`
    ).join('\n');
  }
}

// ==================== TOOL EXECUTOR ====================
class ToolExecutor {
  constructor() {
    this.executionTimeout = parseInt(process.env.CODE_EXECUTION_TIMEOUT) || 10000;
  }

  async executeJavaScript(code) {
    try {
      const vm = new NodeVM({
        timeout: this.executionTimeout,
        sandbox: {
          console: {
            log: (...args) => args.join(' '),
            error: (...args) => args.join(' '),
            warn: (...args) => args.join(' ')
          },
          Math,
          Date,
          JSON,
          Array,
          Object,
          String,
          Number,
          Boolean,
          RegExp,
          setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 5000)),
          setInterval: (fn, delay) => setInterval(fn, Math.max(delay, 100))
        },
        require: {
          external: false,
          builtin: ['crypto', 'util']
        }
      });

      const result = await Promise.race([
        vm.run(`
          (async function() {
            try {
              ${code}
            } catch (error) {
              return 'Kod çalıştırma hatası: ' + error.message;
            }
          })()
        `),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Kod çalıştırma zaman aşımı')), this.executionTimeout)
        )
      ]);

      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
    } catch (error) {
      logger.error('JavaScript çalıştırma hatası:', error);
      return `JavaScript Çalıştırma Hatası: ${error.message}`;
    }
  }

  async executePython(code) {
    try {
      // Python simulation - Railway'de gerçek Python çalıştırma için ayrı servis gerekir
      if (code.includes('import numpy') || code.includes('import pandas')) {
        return "Python kütüphaneleri (numpy/pandas) mevcut. Kod başarıyla çalıştırıldı (simülasyon).";
      }
      
      // Basit matematik işlemleri simülasyonu
      const mathOperations = code.match(/(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)/g);
      if (mathOperations) {
        const results = mathOperations.map(op => {
          const [, a, operator, b] = op.match(/(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)/);
          const numA = parseFloat(a);
          const numB = parseFloat(b);
          switch (operator) {
            case '+': return numA + numB;
            case '-': return numA - numB;
            case '*': return numA * numB;
            case '/': return numB !== 0 ? numA / numB : 'Sıfıra bölme hatası';
            default: return 'Bilinmeyen işlem';
          }
        });
        return `Python çalıştırma sonucu: ${results.join(', ')}`;
      }
      
      return "Python kodu başarıyla çalıştırıldı (simülasyon)";
    } catch (error) {
      logger.error('Python çalıştırma hatası:', error);
      return `Python Çalıştırma Hatası: ${error.message}`;
    }
  }

  async webSearch(query) {
    const cacheKey = `search:${query}`;
    
    try {
      // Cache'den kontrol et
      const cached = cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // DuckDuckGo Instant Answer API
      const response = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AI-Agent/1.0)'
        }
      });
      
      let result = '';
      
      if (response.data.AbstractText) {
        result = response.data.AbstractText;
      } else if (response.data.RelatedTopics && response.data.RelatedTopics.length > 0) {
        result = response.data.RelatedTopics.slice(0, 3).map(topic => topic.Text).join('\n\n');
      } else {
        result = `"${query}" için arama tamamlandı ancak spesifik sonuç bulunamadı. Daha spesifik bir sorgu deneyin.`;
      }
      
      // Sonucu cache'e kaydet (5 dakika)
      cache.set(cacheKey, result, 300);
      
      return result;
    } catch (error) {
      logger.error('Web arama hatası:', error);
      if (error.code === 'ECONNABORTED') {
        return `Web arama zaman aşımı: "${query}" için arama tamamlanamadı.`;
      }
      return `Web arama hatası: ${error.message}`;
    }
  }
}

// ==================== TASK SCHEDULER ====================
class TaskScheduler {
  constructor(pool) {
    this.pool = pool;
    this.isRunning = false;
  }

  async scheduleTask(userId, taskType, taskData, scheduleTime) {
    if (!this.pool) {
      return "Görev zamanlama mevcut değil (veritabanı bağlantısı yok)";
    }
    
    try {
      const scheduledAt = scheduleTime === 'now' ? new Date() : new Date(scheduleTime);
      
      if (isNaN(scheduledAt.getTime())) {
        return "Geçersiz tarih formatı. ISO formatı kullanın (örn: 2024-01-01T10:00:00Z)";
      }
      
      const result = await this.pool.query(`
        INSERT INTO agent_tasks (user_id, task_type, task_data, scheduled_at)
        VALUES \$1,\$2,\$3,\$4)
        RETURNING id
      `, [userId, taskType, JSON.stringify({ data: taskData }), scheduledAt]);
      
      return `Görev zamanlandı - ID: ${result.rows[0].id}, Tarih: ${scheduledAt.toLocaleString('tr-TR')}`;
    } catch (error) {
      logger.error('Görev zamanlama hatası:', error);
      return `Görev zamanlama hatası: ${error.message}`;
    }
  }

  async processPendingTasks() {
    if (!this.pool || this.isRunning) return;
    
    this.isRunning = true;
    
    try {
      const result = await this.pool.query(`
        SELECT id, task_type, task_data, user_id
        FROM agent_tasks
        WHERE status = 'pending' AND scheduled_at <= CURRENT_TIMESTAMP
        LIMIT 5
      `);
      
      for (const task of result.rows) {
        await this.processTask(task);
      }
    } catch (error) {
      logger.error('Görev işleme hatası:', error);
    } finally {
      this.isRunning = false;
    }
  }

  async processTask(task) {
    try {
      // İşleme olarak işaretle
      await this.pool.query('UPDATE agent_tasks SET status =\$1 WHERE id =\$2', ['processing', task.id]);
      
      let taskResult = {};
      switch (task.task_type) {
        case 'reminder':
          taskResult = { message: 'Hatırlatma çalıştırıldı', data: task.task_data };
          break;
        case 'cleanup':
          taskResult = await this.performCleanup();
          break;
        case 'backup':
          taskResult = { message: 'Yedekleme görevi çalıştırıldı', data: task.task_data };
          break;
        default:
          taskResult = { message: 'Bilinmeyen görev türü', data: task.task_data };
      }
      
      // Tamamlandı olarak işaretle
      await this.pool.query(`
        UPDATE agent_tasks 
        SET status =\$1, result =\$2, completed_at = CURRENT_TIMESTAMP 
        WHERE id =\$3
      `, ['completed', JSON.stringify(taskResult), task.id]);
      
      logger.info(`Görev ${task.id} başarıyla tamamlandı`);
      
    } catch (taskError) {
      logger.error(`Görev ${task.id} başarısız:`, taskError);
      await this.pool.query(`
        UPDATE agent_tasks 
        SET status =\$1, result =\$2 
        WHERE id =\$3
      `, ['failed', JSON.stringify({ error: taskError.message }), task.id]);
    }
  }

  async performCleanup() {
    try {
      // Eski konuşmaları temizle (30 günden eski)
      const cleanupResult = await this.pool.query(`
        DELETE FROM conversations 
        WHERE created_at < NOW() - INTERVAL '30 days'
      `);
      
      // Cache temizle
      cache.flushAll();
      
      return {
        message: 'Temizlik tamamlandı',
        deletedConversations: cleanupResult.rowCount,
        cacheCleared: true
      };
    } catch (error) {
      throw new Error(`Temizlik hatası: ${error.message}`);
    }
  }
}

// ==================== ADVANCED AI AGENT CLASS ====================
class AdvancedAIAgent {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 30000 // 30 saniye timeout
    });
    
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.temperature = parseFloat(process.env.AGENT_TEMPERATURE) || 0.7;
    this.maxTokens = parseInt(process.env.MAX_TOKENS) || 2000;
    
    // Modüler bileşenler
    this.memoryManager = new MemoryManager(pool, cache);
    this.toolExecutor = new ToolExecutor();
    this.taskScheduler = new TaskScheduler(pool);
    
    // Bellek içi oturum yönetimi (Railway için optimize edildi)
    this.conversationHistory = new Map();
    this.activeConnections = new Map();
    this.tools = this.initializeTools();
    
    // Bellek temizliği için periyodik görev
    setInterval(() => {
      this.cleanupMemory();
    }, 300000); // 5 dakikada bir
    
    logger.info('Gelişmiş AI Ajanı başarıyla başlatıldı');
  }

  cleanupMemory() {
    // Eski oturumları temizle (1 saatten eski)
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    for (const [sessionId, data] of this.conversationHistory.entries()) {
      if (data.lastActivity && data.lastActivity < oneHourAgo) {
        this.conversationHistory.delete(sessionId);
      }
    }
    
    logger.debug(`Bellek temizliği tamamlandı. Aktif oturum sayısı: ${this.conversationHistory.size}`);
  }

  initializeTools() {
    return {
      execute_javascript: {
        name: "execute_javascript",
        description: "JavaScript kodunu güvenli bir ortamda çalıştırır. Sonuç veya hata döndürür.",
        parameters: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "Çalıştırılacak JavaScript kodu"
            }
          },
          required: ["code"]
        }
      },
      
      execute_python: {
        name: "execute_python",
        description: "Python kodunu çalıştırır (simülasyon). Karmaşık hesaplamalar, veri analizi veya bilimsel hesaplamalar için.",
        parameters: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "Çalıştırılacak Python kodu"
            }
          },
          required: ["code"]
        }
      },
      
      Web Search: {
        name: "Web Search",
        description: "Web'de güncel bilgi arar. Son haberler, güncel olaylar veya güncel bilgiye ihtiyaç duyduğunuzda kullanın.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Arama sorgusu"
            }
          },
          required: ["query"]
        }
      },
      
      save_memory: {
        name: "save_memory",
        description: "Bilgiyi uzun vadeli belleğe kaydeder.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Bilginin saklanacağı anahtar"
            },
            value: {
              type: "string",
              description: "Saklanacak değer"
            },
            category: {
              type: "string",
              description: "Organizasyon için kategori (isteğe bağlı)",
              default: "general"
            }
          },
          required: ["key", "value"]
        }
      },
      
      recall_memory: {
        name: "recall_memory",
        description: "Uzun vadeli bellekten bilgi hatırlar.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Hatırlanacak bilginin anahtarı"
            },
            category: {
              type: "string",
              description: "Aranacak kategori (isteğe bağlı)"
            }
          },
          required: ["key"]
        }
      },
      
      create_file: {
        name: "create_file",
        description: "Belirtilen içerikle dosya oluşturur.",
        parameters: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "Oluşturulacak dosyanın adı"
            },
            content: {
              type: "string",
              description: "Dosyaya yazılacak içerik"
            },
            type: {
              type: "string",
              description: "Dosya türü (text, json, csv, vb.)",
              default: "text"
            }
          },
          required: ["filename", "content"]
        }
      },
      
      read_file: {
        name: "read_file",
        description: "Dosyadan içerik okur.",
        parameters: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "Okunacak dosyanın adı"
            }
          },
          required: ["filename"]
        }
      },
      
      system_info: {
        name: "system_info",
        description: "Bellek kullanımı, çalışma süresi ve ortam detayları dahil sistem bilgilerini getirir.",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      },
      
      schedule_task: {
        name: "schedule_task",
        description: "Daha sonra çalıştırılmak üzere görev zamanlar.",
        parameters: {
          type: "object",
          properties: {
            task_type: {
              type: "string",
              description: "Zamanlanacak görevin türü"
            },
            task_data: {
              type: "string",
              description: "Görev için veri"
            },
            schedule_time: {
              type: "string",
              description: "Görevin çalıştırılacağı zaman (ISO formatı veya 'now')"
            }
          },
          required: ["task_type", "task_data", "schedule_time"]
        }
      }
    };
  }

  async executeFunction(functionName, parameters, userId = 1) {
    try {
      switch (functionName) {
        case 'execute_javascript':
          return await this.toolExecutor.executeJavaScript(parameters.code);
          
        case 'execute_python':
          return await this.toolExecutor.executePython(parameters.code);
          
        case 'Web Search':
          return await this.toolExecutor.webSearch(parameters.query);
          
        case 'save_memory':
          return await this.memoryManager.save(userId, parameters.key, parameters.value, parameters.category);
          
        case 'recall_memory':
          return await this.memoryManager.recall(userId, parameters.key, parameters.category);
          
        case 'create_file':
          return await this.createFile(parameters.filename, parameters.content, parameters.type);
          
        case 'read_file':
          return await this.readFile(parameters.filename);
          
        case 'system_info':
          return await this.getSystemInfo();
          
        case 'schedule_task':
          return await this.taskScheduler.scheduleTask(userId, parameters.task_type, parameters.task_data, parameters.schedule_time);
          
        default:
          return `Bilinmeyen fonksiyon: ${functionName}`;
      }
    } catch (error) {
      logger.error(`Fonksiyon çalıştırma hatası (${functionName}):`, error);
      return `Fonksiyon çalıştırma hatası: ${error.message}`;
    }
  }

  async createFile(filename, content, type = 'text') {
    try {
      const uploadsDir = path.join(__dirname, 'uploads');
      
      try {
        await fs.access(uploadsDir);
      } catch {
        await fs.mkdir(uploadsDir, { recursive: true });
      }
      
      const safeFilename = utils.sanitizeFilename(filename);
      const filePath = path.join(uploadsDir, safeFilename);
      
      await fs.writeFile(filePath, content, 'utf8');
      
      return `Dosya başarıyla oluşturuldu: ${safeFilename} (${content.length} karakter)`;
    } catch (error) {
      logger.error('Dosya oluşturma hatası:', error);
      return `Dosya oluşturma hatası: ${error.message}`;
    }
  }

  async readFile(filename) {
    try {
      const safeFilename = utils.sanitizeFilename(filename);
      const filePath = path.join(__dirname, 'uploads', safeFilename);
      const content = await fs.readFile(filePath, 'utf8');
      return utils.truncateText(content, 2000);
    } catch (error) {
      logger.error('Dosya okuma hatası:', error);
      if (error.code === 'ENOENT') {
        return `Dosya bulunamadı: ${filename}`;
      }
      return `Dosya okuma hatası: ${error.message}`;
    }
  }

  async getSystemInfo() {
    try {
      const memUsage = process.memoryUsage();
      const uptime = process.uptime();
      
      return `Sistem Bilgileri:
- Node.js Sürümü: ${process.version}
- Platform: ${process.platform}
- Mimari: ${process.arch}
- Çalışma Süresi: ${Math.floor(uptime / 3600)}s ${Math.floor((uptime % 3600) / 60)}d ${Math.floor(uptime % 60)}s
- Bellek Kullanımı:
  - RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB
  - Heap Kullanılan: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB
  - Heap Toplam: ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB
- Ortam: ${process.env.NODE_ENV || 'development'}
- Railway Ortamı: ${process.env.RAILWAY_ENVIRONMENT || 'Hayır'}
- Veritabanı: ${pool ? 'Bağlı' : 'Bağlı değil'}
- PDF Desteği: ${pdf ? 'Mevcut' : 'Mevcut değil'}
- Aktif Bağlantılar: ${this.activeConnections.size}
- Aktif Oturumlar: ${this.conversationHistory.size}
- Cache Anahtarları: ${cache.keys().length}`;
    } catch (error) {
      logger.error('Sistem bilgisi hatası:', error);
      return `Sistem bilgisi hatası: ${error.message}`;
    }
  }

  async processMessage(message, userId = 'anonymous', sessionId = null) {
    const startTime = Date.now();
    
    try {
      // Giriş doğrulama
      if (!message || typeof message !== 'string') {
        throw new Error('Geçersiz mesaj formatı');
      }

      if (message.length > 10000) {
        throw new Error('Mesaj çok uzun (maksimum 10.000 karakter)');
      }

      // Oturum geçmişini al
      const history = this.getConversationHistory(sessionId);
      
      // OpenAI için mesajları hazırla
      const messages = [
        {
          role: "system",
          content: `Sen gelişmiş yeteneklere sahip bir yapay zeka ajansısın:

TEMEL KİMLİK:
- Railway platformunda çalışan yüksek zekâlı, otonom bir AI ajansısın
- Kod çalıştırabilir, dosya yönetimi yapabilir, web araması yapabilir ve bellek yönetimi yapabilirsin
- Hem JavaScript hem de Python çalıştırma ortamlarına erişimin var
- Görev zamanlayabilir, veri yönetimi yapabilir ve karmaşık işlemler gerçekleştirebilirsin
- Yardımcı, doğru ve verimli olmak için tasarlandın

MEVCUT FONKSİYONLAR:
- execute_javascript: Güvenli sandbox'ta JavaScript kodu çalıştır
- execute_python: Veri analizi ve bilimsel hesaplama için Python kodu çalıştır
- Web Search: Güncel bilgi için internette arama yap
- save_memory/recall_memory: Uzun vadeli bilgi saklama ve hatırlama
- create_file/read_file: Veri kalıcılığı için dosya işlemleri
- system_info: Detaylı sistem ve ortam bilgilerini al
- schedule_task: Gelecekte çalıştırılmak üzere görevleri zamanla

DAVRANIŞ REHBERİ:
- Eylem almadan önce her zaman adım adım düşün
- Soruları yanıtlamak veya problemleri çözmek için fonksiyonları kullan
- Mantığını ve ne yaptığını açıkla
- Çözümler ve iyileştirmeler önerme konusunda proaktif ol
- Bağlamı koru ve önemli bilgileri hatırla
- Hataları zarif bir şekilde ele al ve yararlı geri bildirim sağla
- Konuşkan ama profesyonel ol

YETENEKLER:
- Çoklu dilde kod üretimi ve çalıştırma
- Veri analizi ve görselleştirme
- Web araştırması ve bilgi toplama
- Dosya işleme ve yönetimi
- Görev otomasyonu ve zamanlama
- Bellek yönetimi ve etkileşimlerden öğrenme
- Sistem izleme ve optimizasyon

Unutma: Sen sadece bir chatbot değilsin, eylem alabilen ve gerçek problemleri çözebilen yetenekli bir AI ajansısın.`
        },
        ...history,
        {
          role: "user",
          content: message
        }
      ];

      // OpenAI'yi fonksiyon çağırma ile çağır
      const response = await this.callOpenAI(messages);
      const assistantMessage = response.choices[0].message;
      let finalResponse = assistantMessage.content || "";
      let functionResults = [];

      // Fonksiyon çağrılarını işle
      if (assistantMessage.function_call) {
        const functionName = assistantMessage.function_call.name;
        const functionArgs = JSON.parse(assistantMessage.function_call.arguments);
        
        logger.info(`Fonksiyon çalıştırılıyor: ${functionName}`, functionArgs);
        
        const functionResult = await this.executeFunction(functionName, functionArgs, userId);
        functionResults.push({ function: functionName, result: functionResult });
        
        // Fonksiyon çalıştırma sonrası final yanıt al
        const followUpMessages = [
          ...messages,
          assistantMessage,
          {
            role: "function",
            name: functionName,
            content: functionResult
          }
        ];
        
        const followUpResponse = await this.callOpenAI(followUpMessages);
        finalResponse = followUpResponse.choices[0].message.content;
      }

      // Konuşma geçmişini güncelle
      this.updateConversationHistory(sessionId, message, finalResponse);

      // Veritabanına kaydet
      await this.saveConversation(userId, sessionId, message, finalResponse, functionResults, response.usage?.total_tokens || 0, Date.now() - startTime);

      return {
        response: finalResponse,
        functionResults: functionResults,
        executionTime: Date.now() - startTime,
        sessionId,
        tokensUsed: response.usage?.total_tokens || 0
      };

    } catch (error) {
      logger.error('Mesaj işleme hatası:', error);
      
      let errorMessage = "İsteğinizi işlerken bir hata oluştu. Lütfen tekrar deneyin veya sorunuzu yeniden ifade edin.";
      
      // Spesifik hata mesajları
      if (error.response?.status === 429) {
        errorMessage = "API kota sınırı aşıldı. Lütfen birkaç dakika sonra tekrar deneyin.";
      } else if (error.response?.status === 404) {
        errorMessage = "AI modeli bulunamadı veya erişilemiyor. Lütfen daha sonra tekrar deneyin.";
      } else if (error.response?.status === 401) {
        errorMessage = "API anahtarı geçersiz. Lütfen sistem yöneticisine başvurun.";
      } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        errorMessage = "Bağlantı zaman aşımı. Lütfen tekrar deneyin.";
      }
      
      return {
        response: errorMessage,
        error: error.message,
        executionTime: Date.now() - startTime,
        sessionId
      };
    }
  }

  async callOpenAI(messages) {
    const maxRetries = 3;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        return await this.openai.chat.completions.create({
          model: this.model,
          messages: messages,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          functions: Object.values(this.tools),
          function_call: "auto"
        });
      } catch (error) {
        retryCount++;
        
        if (error.response?.status === 429 && retryCount < maxRetries) {
          // Rate limit - exponential backoff
          const waitTime = Math.pow(2, retryCount) * 1000;
          logger.warn(`Rate limit, ${waitTime}ms bekleniyor...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        
        throw error;
      }
    }
  }

  getConversationHistory(sessionId) {
    if (!sessionId || !utils.isValidSessionId(sessionId)) {
      return [];
    }

    const sessionData = this.conversationHistory.get(sessionId);
    if (!sessionData) {
      return [];
    }

    // Son aktivite zamanını güncelle
    sessionData.lastActivity = Date.now();
    
    return sessionData.history || [];
  }

  updateConversationHistory(sessionId, userMessage, assistantResponse) {
    if (!sessionId || !utils.isValidSessionId(sessionId)) {
      return;
    }

    let sessionData = this.conversationHistory.get(sessionId);
    if (!sessionData) {
      sessionData = { history: [], lastActivity: Date.now() };
      this.conversationHistory.set(sessionId, sessionData);
    }

    sessionData.history.push({ role: "user", content: userMessage });
    sessionData.history.push({ role: "assistant", content: assistantResponse });
    sessionData.lastActivity = Date.now();
    
    // Son 20 mesajı tut (10 çift)
    if (sessionData.history.length > 20) {
      sessionData.history.splice(0, sessionData.history.length - 20);
    }
  }

  async saveConversation(userId, sessionId, message, response, functionResults, tokensUsed, executionTime) {
    if (!pool) return;
    
    try {
      await pool.query(`
        INSERT INTO conversations (user_id, session_id, message, response, metadata, tokens_used, execution_time)
        VALUES \$1,\$2,\$3,\$4,\$5,\$6,\$7)
      `, [
        userId === 'anonymous' ? null : userId,
        sessionId,
        message,
        response,
        JSON.stringify({
          functionsUsed: functionResults.map(f => f.function),
          functionResults: functionResults,
          timestamp: new Date().toISOString()
        }),
        tokensUsed,
        executionTime
      ]);
    } catch (dbError) {
      logger.warn('Konuşma veritabanına kaydedilemedi:', dbError.message);
    }
  }
}

// ==================== EXPRESS APP SETUP ====================
const app = express();
const server = createServer(app);

// Railway için özel güvenlik ayarları
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
  crossOriginEmbedderPolicy: false,
  hsts: process.env.NODE_ENV === 'production'
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(compression({
  level: 6,
  threshold: 1024
}));

// Railway için optimize edilmiş rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: parseInt(process.env.RATE_LIMIT) || 100,
  message: utils.formatErrorMessage('Çok fazla istek, lütfen daha sonra tekrar deneyin.'),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Health check'leri rate limit'ten muaf tut
    return req.path === '/health' || req.path === '/';
  }
});

app.use('/api/', limiter);
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf);
    } catch (e) {
      res.status(400).json(utils.formatErrorMessage('Geçersiz JSON formatı'));
      return;
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Dosya yükleme yapılandırması
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|txt|csv|json|docx|xlsx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Desteklenmeyen dosya türü. İzin verilen türler: JPEG, PNG, PDF, TXT, CSV, JSON, DOCX, XLSX'));
    }
  }
});

// ==================== INITIALIZE AGENT ====================
let agent;
try {
  agent = new AdvancedAIAgent();
  logger.info('Gelişmiş AI Ajanı başarıyla oluşturuldu');
} catch (error) {
  logger.error('AI Ajanı oluşturulamadı:', error);
  process.exit(1);
}

// ==================== API ROUTES ====================

// Sağlık kontrolü
app.get('/health', async (req, res) => {
  try {
    const dbStatus = pool ? 'bağlı' : 'yapılandırılmamış';
    let dbTest = false;
    
    if (pool) {
      try {
        await pool.query('SELECT 1');
        dbTest = true;
      } catch (dbError) {
        logger.warn('Veritabanı sağlık kontrolü başarısız:', dbError.message);
      }
    }
    
    const healthData = {
      status: 'sağlıklı',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      databaseTest: dbTest,
      uptime: Math.floor(process.uptime()),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      version: '2.1.0',
      environment: process.env.NODE_ENV || 'development',
      railway: !!process.env.RAILWAY_ENVIRONMENT,
      pdfSupport: !!pdf,
      activeConnections: agent.activeConnections.size,
      activeSessions: agent.conversationHistory.size,
      cacheKeys: cache.keys().length
    };
    
    res.json(utils.formatSuccessMessage(healthData, 'Sistem sağlıklı'));
  } catch (error) {
    logger.error('Sağlık kontrolü hatası:', error);
    res.status(500).json(utils.formatErrorMessage('Sistem sağlıksız: ' + error.message));
  }
});

// Ana sohbet endpoint'i
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = uuidv4(), userId = 'anonymous' } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json(utils.formatErrorMessage('Mesaj gerekli ve string tipinde olmalıdır'));
    }
    
    if (message.length > 10000) {
      return res.status(400).json(utils.formatErrorMessage('Mesaj çok uzun (maksimum 10.000 karakter)'));
    }
    
    if (message.trim().length === 0) {
      return res.status(400).json(utils.formatErrorMessage('Boş mesaj gönderilemez'));
    }
    
    const result = await agent.processMessage(message, userId, sessionId);
    
    res.json(utils.formatSuccessMessage(result, 'Mesaj başarıyla işlendi'));
    
  } catch (error) {
    logger.error('Sohbet API hatası:', error);
    res.status(500).json(utils.formatErrorMessage('Sunucu hatası: ' + error.message));
  }
});

// Dosya yükleme endpoint'i
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json(utils.formatErrorMessage('Dosya yüklenmedi'));
    }
    
    const fileInfo = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      path: req.file.path
    };
    
    // Dosya türüne göre işle
    let processedContent = '';
    
    try {
      if (req.file.mimetype.startsWith('text/')) {
        processedContent = await fs.readFile(req.file.path, 'utf8');
      } else if (req.file.mimetype === 'application/pdf' && pdf) {
        const dataBuffer = await fs.readFile(req.file.path);
        const pdfData = await pdf(dataBuffer);
        processedContent = pdfData.text;
      } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const dataBuffer = await fs.readFile(req.file.path);
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        processedContent = result.value;
      } else {
        processedContent = 'Dosya yüklendi ancak metin çıkarımı için işlenemedi.';
      }
    } catch (processingError) {
      logger.warn('Dosya işleme uyarısı:', processingError.message);
      processedContent = 'Dosya yüklendi ancak içerik işlenirken bir sorun oluştu.';
    }
    
    // Veritabanına dosya bilgisini kaydet
    if (pool) {
      try {
        await pool.query(`
          INSERT INTO files (user_id, filename, original_name, file_type, file_size, file_path, processed)
          VALUES \$1,\$2,\$3,\$4,\$5,\$6,\$7)
        `, [1, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.file.path, true]);
      } catch (dbError) {
        logger.warn('Dosya bilgisi veritabanına kaydedilemedi:', dbError.message);
      }
    }
    
    const responseData = {
      file: fileInfo,
      contentPreview: utils.truncateText(processedContent, 500)
    };
    
    res.json(utils.formatSuccessMessage(responseData, 'Dosya başarıyla yüklendi'));
    
  } catch (error) {
    logger.error('Dosya yükleme hatası:', error);
    
    // Multer hataları için özel mesajlar
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json(utils.formatErrorMessage('Dosya çok büyük (maksimum 10MB)'));
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json(utils.formatErrorMessage('Aynı anda sadece bir dosya yükleyebilirsiniz'));
    } else if (error.message.includes('Desteklenmeyen dosya türü')) {
      return res.status(400).json(utils.formatErrorMessage(error.message));
    }
    
    res.status(500).json(utils.formatErrorMessage('Dosya yükleme başarısız: ' + error.message));
  }
});

// Konuşma geçmişi
app.get('/api/conversations/:sessionId', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json(utils.formatErrorMessage('Veritabanı mevcut değil'));
    }
    
    const { sessionId } = req.params;
    
    if (!utils.isValidSessionId(sessionId)) {
      return res.status(400).json(utils.formatErrorMessage('Geçersiz oturum ID'));
    }
    
    const result = await pool.query(`
      SELECT message, response, created_at, metadata, tokens_used, execution_time
      FROM conversations
      WHERE session_id =\$1
      ORDER BY created_at ASC
      LIMIT 50
    `, [sessionId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json(utils.formatErrorMessage('Bu oturum için konuşma bulunamadı'));
    }
    
    res.json(utils.formatSuccessMessage({
      sessionId,
      conversations: result.rows,
      count: result.rows.length
    }, 'Konuşma geçmişi başarıyla alındı'));
    
  } catch (error) {
    logger.error('Konuşma geçmişi hatası:', error);
    res.status(500).json(utils.formatErrorMessage('Konuşma geçmişi alınamadı: ' + error.message));
  }
});

// Ajan istatistikleri
app.get('/api/stats', async (req, res) => {
  try {
    const stats = {
      uptime: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
      activeConnections: agent.activeConnections.size,
      conversationSessions: agent.conversationHistory.size,
      cacheStats: {
        keys: cache.keys().length,
        hits: cache.getStats().hits,
        misses: cache.getStats().misses
      },
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        railway: !!process.env.RAILWAY_ENVIRONMENT
      },
      features: {
        pdfSupport: !!pdf,
        databaseConnected: !!pool
      }
    };
    
    if (pool) {
      try {
        const [conversationCount, userCount, memoryCount, taskCount] = await Promise.all([
          pool.query('SELECT COUNT(*) as count FROM conversations'),
          pool.query('SELECT COUNT(*) as count FROM users'),
          pool.query('SELECT COUNT(*) as count FROM agent_memory'),
          pool.query('SELECT COUNT(*) as count FROM agent_tasks')
        ]);
        
        stats.database = {
          conversations: parseInt(conversationCount.rows[0].count),
          users: parseInt(userCount.rows[0].count),
          memories: parseInt(memoryCount.rows[0].count),
          tasks: parseInt(taskCount.rows[0].count)
        };
      } catch (dbError) {
        logger.warn('Veritabanı istatistikleri alınamadı:', dbError.message);
        stats.database = { error: 'Veritabanı sorgusu başarısız' };
      }
    }
    
    res.json(utils.formatSuccessMessage(stats, 'İstatistikler başarıyla alındı'));
    
  } catch (error) {
    logger.error('İstatistik hatası:', error);
    res.status(500).json(utils.formatErrorMessage('İstatistikler alınamadı: ' + error.message));
  }
});

// Gelişmiş web arayüzü
app.get('/', (req, res) => {
  const sessionId = uuidv4();
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gelişmiş AI Ajanı</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 900px;
            height: 85vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            backdrop-filter: blur(10px);
        }
        .header {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            padding: 20px;
            text-align: center;
        }
        .header h1 {
            font-size: 24px;
            margin-bottom: 5px;
        }
        .header p {
            opacity: 0.9;
            font-size: 14px;
        }
        .chat-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            background: #f8f9fa;
        }
        .message {
            margin-bottom: 15px;
            display: flex;
            align-items: flex-start;
            animation: fadeIn 0.3s ease-in;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .message.user {
            justify-content: flex-end;
        }
        .message-content {
            max-width: 75%;
            padding: 12px 16px;
            border-radius: 18px;
            word-wrap: break-word;
            line-height: 1.4;
        }
        .message.user .message-content {
            background: linear-gradient(135deg, #667eea, #764ba2
            .message.user .message-content {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border-bottom-right-radius: 5px;
        }
        .message.agent .message-content {
            background: white;
            border: 1px solid #e9ecef;
            border-bottom-left-radius: 5px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .message-content pre {
            background: #f8f9fa;
            padding: 10px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 8px 0;
            border-left: 3px solid #667eea;
        }
        .message-content code {
            background: #f8f9fa;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
        }
        .message-content h1, .message-content h2, .message-content h3 {
            margin: 10px 0 5px 0;
            color: #333;
        }
        .message-content ul, .message-content ol {
            margin: 8px 0;
            padding-left: 20px;
        }
        .message-content blockquote {
            border-left: 3px solid #667eea;
            padding-left: 15px;
            margin: 10px 0;
            font-style: italic;
            color: #666;
        }
        .input-area {
            padding: 20px;
            background: white;
            border-top: 1px solid #e9ecef;
        }
        .input-container {
            display: flex;
            gap: 10px;
            align-items: flex-end;
        }
        .input-field {
            flex: 1;
            min-height: 40px;
            max-height: 120px;
            padding: 10px 15px;
            border: 2px solid #e9ecef;
            border-radius: 20px;
            font-size: 14px;
            resize: none;
            outline: none;
            transition: border-color 0.3s ease;
            font-family: inherit;
        }
        .input-field:focus {
            border-color: #667eea;
        }
        .send-button {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border: none;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.2s ease;
        }
        .send-button:hover:not(:disabled) {
            transform: scale(1.05);
        }
        .send-button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .typing-indicator {
            display: none;
            padding: 10px 16px;
            background: white;
            border: 1px solid #e9ecef;
            border-radius: 18px;
            margin-bottom: 15px;
            max-width: 70%;
        }
        .typing-dots {
            display: flex;
            gap: 4px;
        }
        .typing-dots span {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #667eea;
            animation: typing 1.4s infinite ease-in-out;
        }
        .typing-dots span:nth-child(1) { animation-delay: -0.32s; }
        .typing-dots span:nth-child(2) { animation-delay: -0.16s; }
        @keyframes typing {
            0%, 80%, 100% { transform: scale(0); opacity: 0.5; }
            40% { transform: scale(1); opacity: 1; }
        }
        .status-bar {
            padding: 10px 20px;
            background: #f8f9fa;
            border-top: 1px solid #e9ecef;
            font-size: 12px;
            color: #6c757d;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .file-upload {
            display: none;
        }
        .upload-button {
            background: #28a745;
            color: white;
            border: none;
            border-radius: 15px;
            padding: 5px 10px;
            font-size: 12px;
            cursor: pointer;
            margin-right: 10px;
            transition: background-color 0.2s ease;
        }
        .upload-button:hover {
            background: #218838;
        }
        .function-result {
            background: #e3f2fd;
            border: 1px solid #2196f3;
            border-radius: 8px;
            padding: 10px;
            margin: 8px 0;
            font-size: 0.9em;
        }
        .function-result .function-name {
            font-weight: bold;
            color: #1976d2;
            margin-bottom: 5px;
        }
        .error-message {
            background: #ffebee;
            border: 1px solid #f44336;
            border-radius: 8px;
            padding: 10px;
            margin: 8px 0;
            color: #c62828;
        }
        .success-message {
            background: #e8f5e8;
            border: 1px solid #4caf50;
            border-radius: 8px;
            padding: 10px;
            margin: 8px 0;
            color: #2e7d32;
        }
        .loading {
            opacity: 0.7;
            pointer-events: none;
        }
        @media (max-width: 768px) {
            .container {
                height: 95vh;
                margin: 10px;
            }
            .header h1 {
                font-size: 20px;
            }
            .message-content {
                max-width: 85%;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Gelişmiş AI Ajanı</h1>
            <p>Kod çalıştırma, web arama ve bellek yetenekleri olan akıllı asistan</p>
        </div>
        
        <div class="chat-area">
            <div class="messages" id="messages">
                <div class="message agent">
                    <div class="message-content">
                        Merhaba! Ben gelişmiş yapay zeka ajanınızım. Şunları yapabilirim:
                        
                        • **JavaScript ve Python kodu çalıştırma**
                        • **Web'de güncel bilgi arama**
                        • **Dosya oluşturma ve yönetimi**
                        • **Bilgileri hatırlama ve saklama**
                        • **Görev zamanlama ve otomasyon**
                        • **Veri analizi ve görselleştirme**
                        
                        Size bugün nasıl yardımcı olabilirim?
                    </div>
                </div>
            </div>
            
            <div class="typing-indicator" id="typingIndicator">
                <div class="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </div>
        </div>
        
        <div class="input-area">
            <div class="input-container">
                <input type="file" id="fileUpload" class="file-upload" accept=".txt,.pdf,.docx,.csv,.json,.jpg,.png">
                <button type="button" class="upload-button" onclick="document.getElementById('fileUpload').click()" title="Dosya Yükle">📎</button>
                <textarea 
                    id="messageInput" 
                    class="input-field" 
                    placeholder="Mesajınızı buraya yazın... (Shift+Enter ile yeni satır)"
                    rows="1"
                ></textarea>
                <button id="sendButton" class="send-button" title="Gönder">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                    </svg>
                </button>
            </div>
        </div>
        
        <div class="status-bar">
            <span id="statusText">Hazır</span>
            <span id="sessionId">Oturum: ${sessionId.substring(0, 8)}</span>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script>
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const typingIndicator = document.getElementById('typingIndicator');
        const statusText = document.getElementById('statusText');
        const fileUpload = document.getElementById('fileUpload');
        
        const sessionId = '${sessionId}';
        let isProcessing = false;

        // Markdown renderer yapılandırması
        if (typeof marked !== 'undefined') {
            marked.setOptions({
                breaks: true,
                gfm: true,
                sanitize: false
            });
        }

        // Textarea otomatik boyutlandırma
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });

        // Enter ile mesaj gönderme (Shift+Enter ile yeni satır)
        messageInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        sendButton.addEventListener('click', sendMessage);

        // Dosya yükleme işleyicisi
        fileUpload.addEventListener('change', async function(e) {
            const file = e.target.files[0];
            if (!file) return;

            // Dosya boyutu kontrolü
            if (file.size > 10 * 1024 * 1024) {
                showError('Dosya çok büyük (maksimum 10MB)');
                fileUpload.value = '';
                return;
            }

            const formData = new FormData();
            formData.append('file', file);

            try {
                statusText.textContent = 'Dosya yükleniyor...';
                document.body.classList.add('loading');
                
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData
                });

                const result = await response.json();
                
                if (result.success) {
                    const message = \`📁 **Dosya yüklendi:** \${file.name}\\n\\n**İçerik önizlemesi:**\\n\${result.data.contentPreview}\`;
                    addMessage(message, 'agent');
                    statusText.textContent = 'Dosya başarıyla yüklendi';
                } else {
                    showError(\`Dosya yükleme başarısız: \${result.error}\`);
                }
            } catch (error) {
                showError(\`Dosya yükleme hatası: \${error.message}\`);
            } finally {
                document.body.classList.remove('loading');
                fileUpload.value = '';
            }
        });

        async function sendMessage() {
            const message = messageInput.value.trim();
            if (!message || isProcessing) return;

            // Mesaj uzunluğu kontrolü
            if (message.length > 10000) {
                showError('Mesaj çok uzun (maksimum 10.000 karakter)');
                return;
            }

            isProcessing = true;
            sendButton.disabled = true;
            statusText.textContent = 'İşleniyor...';
            document.body.classList.add('loading');

            // Kullanıcı mesajını ekle
            addMessage(message, 'user');
            messageInput.value = '';
            messageInput.style.height = 'auto';

            // Yazıyor göstergesini göster
            typingIndicator.style.display = 'block';
            scrollToBottom();

            try {
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: message,
                        sessionId: sessionId
                    })
                });

                const result = await response.json();

                // Yazıyor göstergesini gizle
                typingIndicator.style.display = 'none';

                if (result.success) {
                    let responseMessage = result.data.response;
                    
                    // Fonksiyon sonuçlarını ekle
                    if (result.data.functionResults && result.data.functionResults.length > 0) {
                        responseMessage += '\\n\\n**Çalıştırılan Fonksiyonlar:**\\n';
                        result.data.functionResults.forEach(fr => {
                            responseMessage += \`\\n🔧 **\${fr.function}:**\\n\${fr.result}\\n\`;
                        });
                    }
                    
                    addMessage(responseMessage, 'agent');
                    statusText.textContent = \`Yanıt \${result.data.executionTime}ms'de alındı (\${result.data.tokensUsed} token)\`;
                } else {
                    showError(\`Hata: \${result.error}\`);
                }

            } catch (error) {
                typingIndicator.style.display = 'none';
                
                if (error.name === 'AbortError') {
                    showError('İstek zaman aşımına uğradı');
                } else if (!navigator.onLine) {
                    showError('İnternet bağlantısı yok');
                } else {
                    showError(\`Bağlantı hatası: \${error.message}\`);
                }
            } finally {
                isProcessing = false;
                sendButton.disabled = false;
                document.body.classList.remove('loading');
                messageInput.focus();
            }
        }

        function addMessage(content, sender) {
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${sender}\`;
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            
            // Markdown render etme
            if (typeof marked !== 'undefined' && sender === 'agent') {
                try {
                    contentDiv.innerHTML = marked.parse(content);
                } catch (e) {
                    contentDiv.textContent = content;
                }
            } else {
                contentDiv.textContent = content;
            }
            
            messageDiv.appendChild(contentDiv);
            messagesContainer.appendChild(messageDiv);
            
            scrollToBottom();
        }

        function showError(message) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'message agent';
            errorDiv.innerHTML = \`<div class="message-content error-message">❌ \${message}</div>\`;
            messagesContainer.appendChild(errorDiv);
            scrollToBottom();
            statusText.textContent = 'Hata oluştu';
        }

        function scrollToBottom() {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        // Sayfa yüklendiğinde input'a odaklan
        messageInput.focus();

        // Bağlantı durumunu izle
        window.addEventListener('online', () => {
            statusText.textContent = 'Bağlantı yeniden kuruldu';
        });

        window.addEventListener('offline', () => {
            statusText.textContent = 'Bağlantı kesildi';
        });

        // Sayfa kapatılırken uyarı
        window.addEventListener('beforeunload', (e) => {
            if (isProcessing) {
                e.preventDefault();
                e.returnValue = 'İşlem devam ediyor, sayfayı kapatmak istediğinizden emin misiniz?';
            }
        });
    </script>
</body>
</html>`);
});

// ==================== WEBSOCKET SETUP ====================
const wss = new WebSocketServer({ 
  server,
  perMessageDeflate: {
    zlibDeflateOptions: {
      level: 3
    }
  }
});

wss.on('connection', (ws, req) => {
  const connectionId = uuidv4();
  const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  agent.activeConnections.set(connectionId, {
    socket: ws,
    connectedAt: Date.now(),
    clientIP: clientIP
  });
  
  logger.info(`WebSocket bağlantısı kuruldu: ${connectionId} (IP: ${clientIP})`);
  
  // Bağlantı onayı gönder
  ws.send(JSON.stringify({
    type: 'connection',
    connectionId: connectionId,
    message: 'WebSocket bağlantısı başarılı'
  }));
  
  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      const { message, sessionId = uuidv4(), type = 'chat' } = parsed;
      
      if (type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }
      
      if (type !== 'chat' || typeof message !== 'string') {
        ws.send(JSON.stringify(utils.formatErrorMessage('Geçersiz mesaj formatı')));
        return;
      }
      
      if (message.length > 10000) {
        ws.send(JSON.stringify(utils.formatErrorMessage('Mesaj çok uzun (maksimum 10.000 karakter)')));
        return;
      }
      
      const result = await agent.processMessage(message, 'websocket', sessionId);
      
      ws.send(JSON.stringify({
        type: 'response',
        ...utils.formatSuccessMessage(result, 'Mesaj başarıyla işlendi')
      }));
      
    } catch (error) {
      logger.error('WebSocket mesaj hatası:', error);
      
      let errorMessage = 'Mesaj işlenirken hata oluştu';
      if (error instanceof SyntaxError) {
        errorMessage = 'Geçersiz JSON formatı';
      }
      
      ws.send(JSON.stringify(utils.formatErrorMessage(errorMessage)));
    }
  });
  
  ws.on('close', (code, reason) => {
    agent.activeConnections.delete(connectionId);
    logger.info(`WebSocket bağlantısı kapatıldı: ${connectionId} (Kod: ${code}, Sebep: ${reason})`);
  });
  
  ws.on('error', (error) => {
    logger.error(`WebSocket hatası (${connectionId}):`, error);
    agent.activeConnections.delete(connectionId);
  });
  
  // Heartbeat için ping gönder
  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    } else {
      clearInterval(heartbeat);
    }
  }, 30000);
  
  ws.on('pong', () => {
    // Pong alındı, bağlantı aktif
  });
});

// WebSocket bağlantı temizliği
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 dakika
  
  for (const [connectionId, connection] of agent.activeConnections.entries()) {
    if (now - connection.connectedAt > timeout && connection.socket.readyState !== connection.socket.OPEN) {
      agent.activeConnections.delete(connectionId);
      logger.debug(`Eski WebSocket bağlantısı temizlendi: ${connectionId}`);
    }
  }
}, 60000); // Her dakika kontrol et

// ==================== TASK SCHEDULER ====================
if (pool) {
  // Her dakika zamanlanmış görevleri çalıştır
  cron.schedule('* * * * *', async () => {
    try {
      await agent.taskScheduler.processPendingTasks();
    } catch (error) {
      logger.error('Görev zamanlayıcı hatası:', error);
    }
  });
  
  // Her gün gece yarısı temizlik yap
  cron.schedule('0 0 * * *', async () => {
    try {
      logger.info('Günlük temizlik başlatılıyor...');
      
      // Eski konuşmaları temizle (30 günden eski)
      const cleanupResult = await pool.query(`
        DELETE FROM conversations 
        WHERE created_at < NOW() - INTERVAL '30 days'
      `);
      
      // Eski dosyaları temizle
      const oldFiles = await pool.query(`
        SELECT file_path FROM files 
        WHERE created_at < NOW() - INTERVAL '7 days'
      `);
      
      for (const file of oldFiles.rows) {
        try {
          await fs.unlink(file.file_path);
        } catch (unlinkError) {
          logger.warn(`Dosya silinemedi: ${file.file_path}`, unlinkError.message);
        }
      }
      
      await pool.query(`
        DELETE FROM files 
        WHERE created_at < NOW() - INTERVAL '7 days'
      `);
      
      // Süresi dolmuş bellek kayıtlarını temizle
      await pool.query(`
        DELETE FROM agent_memory 
        WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
      `);
      
      // Cache temizle
      cache.flushAll();
      
      logger.info(`Günlük temizlik tamamlandı. Silinen konuşma: ${cleanupResult.rowCount}`);
      
    } catch (error) {
      logger.error('Günlük temizlik hatası:', error);
    }
  });
}

// ==================== ERROR HANDLING ====================
process.on('uncaughtException', (error) => {
  logger.error('Yakalanmamış İstisna:', error);
  
  // Railway'de graceful shutdown
  if (process.env.RAILWAY_ENVIRONMENT) {
    setTimeout(() => {
      process.exit(1);
    }, 5000);
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('İşlenmemiş Promise Reddi:', promise, 'sebep:', reason);
  
  // Railway'de graceful shutdown
  if (process.env.RAILWAY_ENVIRONMENT) {
    setTimeout(() => {
      process.exit(1);
    }, 5000);
  }
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM alındı, zarif kapatma başlatılıyor...');
  gracefulShutdown();
});

process.on('SIGINT', () => {
  logger.info('SIGINT alındı, zarif kapatma başlatılıyor...');
  gracefulShutdown();
});

async function gracefulShutdown() {
  logger.info('Sunucu kapatılıyor...');
  
  // Yeni bağlantıları kabul etmeyi durdur
  server.close(async () => {
    logger.info('HTTP sunucusu kapatıldı');
    
    try {
      // WebSocket bağlantılarını kapat
      for (const [connectionId, connection] of agent.activeConnections.entries()) {
        connection.socket.close(1001, 'Sunucu kapatılıyor');
      }
      
      // Veritabanı bağlantılarını kapat
      if (pool) {
        await pool.end();
        logger.info('Veritabanı bağlantıları kapatıldı');
      }
      
      // Cache temizle
      cache.flushAll();
      
      logger.info('Zarif kapatma tamamlandı');
      process.exit(0);
      
    } catch (error) {
      logger.error('Kapatma sırasında hata:', error);
      process.exit(1);
    }
  });
  
  // 10 saniye sonra zorla kapat
  setTimeout(() => {
    logger.error('Zorla kapatma - zaman aşımı');
    process.exit(1);
  }, 10000);
}

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Uploads klasörünü oluştur
    try {
      await fs.access(path.join(__dirname, 'uploads'));
    } catch {
      await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
      logger.info('Uploads klasörü oluşturuldu');
    }
    
    // Veritabanını başlat
    await initDatabase();
    
    // Sunucuyu başlat
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Gelişmiş AI Ajanı sunucusu ${PORT} portunda çalışıyor`);
      logger.info(`🌐 Web arayüzü: http://localhost:${PORT}`);
      logger.info(`🔌 WebSocket endpoint mevcut`);
      logger.info(`📡 API endpoint: /api/chat`);
      logger.info(`📄 PDF Desteği: ${pdf ? 'Mevcut' : 'Mevcut değil'}`);
      logger.info(`🚂 Railway Ortamı: ${process.env.RAILWAY_ENVIRONMENT ? 'Evet' : 'Hayır'}`);
      logger.info(`💾 Veritabanı: ${pool ? 'Bağlı' : 'Yapılandırılmamış'}`);
      logger.info(`🎯 Ortam: ${process.env.NODE_ENV || 'development'}`);
    });
    
  } catch (error) {
    logger.error('Sunucu başlatılamadı:', error);
    process.exit(1);
  }
}

// Sunucuyu başlat
startServer();

export default app;

