import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import pkg from 'pg';
const { Pool } = pkg;
import OpenAI from 'openai';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import winston from 'winston';
import NodeCache from 'node-cache';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import session from 'express-session';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { EventEmitter } from 'events';
import vm from 'vm';
import { pipeline } from '@huggingface/transformers';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Production Configuration for Railway
const config = {
  port: process.env.PORT || 3000,
  host: '0.0.0.0',
  maxTokens: 8000,
  defaultModel: 'gpt-4o-mini',
  memoryRetentionDays: 30,
  maxConversationLength: 50,
  reasoningDepth: 3,
  toolTimeout: 30000,
  learningRate: 0.1,
  selfImprovementThreshold: 0.8,
  database: {
    maxConnections: process.env.NODE_ENV === 'production' ? 20 : 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    retryAttempts: 3,
    retryDelay: 2000
  },
  security: {
    maxRequestsPerMinute: 30,
    maxFileSize: '10mb',
    encryptionKey: process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex')
  }
};

// Enhanced Logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Multi-tier cache system
const instantCache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 1000 });
const shortTermCache = new NodeCache({ stdTTL: 3600, checkperiod: 300, maxKeys: 500 });
const longTermCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600, maxKeys: 200 });

// Database with Railway PostgreSQL
let pool = null;
let dbConnected = false;

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    logger.warn('🟡 No DATABASE_URL - using memory mode');
    return false;
  }

  try {
    const dbUrl = new URL(process.env.DATABASE_URL);
    
    pool = new Pool({
      host: dbUrl.hostname,
      port: dbUrl.port,
      database: dbUrl.pathname.slice(1),
      user: dbUrl.username,
      password: dbUrl.password,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: config.database.maxConnections,
      idleTimeoutMillis: config.database.idleTimeoutMillis,
      connectionTimeoutMillis: config.database.connectionTimeoutMillis
    });

    // Test connection
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();

    await createTables();
    
    logger.info('✅ Railway PostgreSQL connected');
    dbConnected = true;
    return true;

  } catch (error) {
    logger.error('❌ Database connection failed:', error.message);
    return false;
  }
}

async function createTables() {
  const createTablesSQL = `
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255) UNIQUE NOT NULL,
      user_profile JSONB DEFAULT '{}',
      context JSONB DEFAULT '{}',
      message_count INTEGER DEFAULT 0,
      confidence_avg FLOAT DEFAULT 0.8,
      last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      confidence_score FLOAT DEFAULT 0.8,
      emotion_analysis JSONB DEFAULT '{}',
      provider VARCHAR(50),
      model VARCHAR(100),
      processing_time INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_learning (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255) NOT NULL,
      learning_type VARCHAR(100) NOT NULL,
      input_data JSONB NOT NULL,
      output_data JSONB NOT NULL,
      success_rate FLOAT DEFAULT 0.0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS knowledge_base (
      id SERIAL PRIMARY KEY,
      category VARCHAR(100) NOT NULL,
      knowledge_data JSONB NOT NULL,
      confidence_level FLOAT DEFAULT 0.8,
      usage_count INTEGER DEFAULT 0,
      last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `;

  await pool.query(createTablesSQL);
  logger.info('✅ Database schema created');
}

// AI Providers
const aiProviders = {
  openai: process.env.OPENAI_API_KEY ? new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,
    maxRetries: 2
  }) : null,
  
  groq: process.env.GROQ_API_KEY ? {
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: 30000
  } : null
};

// Real Tool System
class ProductionToolSystem extends EventEmitter {
  constructor() {
    super();
    this.tools = new Map();
    this.toolStats = new Map();
    this.registerProductionTools();
  }

  registerProductionTools() {
    // Real Web Search Tool
    this.registerTool('web_search', {
      name: 'web_search',
      description: 'Search the web for current information',
      parameters: {
        query: { type: 'string', required: true },
        maxResults: { type: 'number', required: false }
      },
      execute: async (params) => {
        const { query, maxResults = 5 } = params;
        
        try {
          // DuckDuckGo Instant Answer API (free)
          const response = await axios.get('https://api.duckduckgo.com/', {
            params: {
              q: query,
              format: 'json',
              no_html: 1,
              skip_disambig: 1
            },
            timeout: 10000
          });

          const results = [];
          
          // Add abstract if available
          if (response.data.Abstract) {
            results.push({
              title: response.data.Heading || 'Information',
              content: response.data.Abstract,
              url: response.data.AbstractURL || '',
              source: 'DuckDuckGo',
              relevance: 0.9
            });
          }

          // Add related topics
          if (response.data.RelatedTopics) {
            response.data.RelatedTopics.slice(0, maxResults - 1).forEach(topic => {
              if (topic.Text) {
                results.push({
                  title: topic.Text.split(' - ')[0] || 'Related Topic',
                  content: topic.Text,
                  url: topic.FirstURL || '',
                  source: 'DuckDuckGo Related',
                  relevance: 0.7
                });
              }
            });
          }

          return {
            query,
            results: results.slice(0, maxResults),
            timestamp: new Date().toISOString(),
            success: true
          };

        } catch (error) {
          logger.error('Web search failed:', error);
          return {
            query,
            results: [],
            error: error.message,
            success: false
          };
        }
      }
    });

    // Enhanced Memory Tool
    this.registerTool('memory', {
      name: 'memory',
      description: 'Store and retrieve information from memory',
      parameters: {
        action: { type: 'string', required: true }, // store, retrieve, search
        key: { type: 'string', required: false },
        value: { type: 'any', required: false },
        query: { type: 'string', required: false }
      },
      execute: async (params, context) => {
        const { action, key, value, query } = params;
        const sessionId = context.sessionId || 'global';

        switch (action) {
          case 'store':
            return await this.storeMemory(sessionId, key, value);
          case 'retrieve':
            return await this.retrieveMemory(sessionId, key);
          case 'search':
            return await this.searchMemory(sessionId, query);
          default:
            throw new Error(`Unknown memory action: ${action}`);
        }
      }
    });

    // Safe Code Execution Tool
    this.registerTool('code_executor', {
      name: 'code_executor',
      description: 'Execute JavaScript code safely',
      parameters: {
        code: { type: 'string', required: true },
        timeout: { type: 'number', required: false }
      },
      execute: async (params) => {
        const { code, timeout = 5000 } = params;
        
        return await this.executeSafeCode(code, timeout);
      }
    });

    // System Information Tool
    this.registerTool('system_info', {
      name: 'system_info',
      description: 'Get system information and health status',
      parameters: {},
      execute: async () => {
        return {
          memory: process.memoryUsage(),
          uptime: process.uptime(),
          platform: process.platform,
          nodeVersion: process.version,
          timestamp: new Date().toISOString(),
          database: dbConnected,
          providers: Object.keys(aiProviders).filter(p => aiProviders[p]),
          cacheStats: {
            instant: instantCache.getStats(),
            shortTerm: shortTermCache.getStats(),
            longTerm: longTermCache.getStats()
          }
        };
      }
    });

    // Real Emotion Analysis Tool
    this.registerTool('emotion_analyzer', {
      name: 'emotion_analyzer',
      description: 'Analyze emotional content of text',
      parameters: {
        text: { type: 'string', required: true }
      },
      execute: async (params) => {
        const { text } = params;
        
        try {
          // Use Hugging Face's free inference API
          const response = await axios.post(
            'https://api-inference.huggingface.co/models/j-hartmann/emotion-english-distilroberta-base',
            { inputs: text },
            {
              headers: {
                'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                'Content-Type': 'application/json'
              },
              timeout: 10000
            }
          );

          return {
            text,
            emotions: response.data[0] || [],
            dominantEmotion: response.data[0]?.[0]?.label || 'neutral',
            confidence: response.data[0]?.[0]?.score || 0.5,
            timestamp: new Date().toISOString()
          };

        } catch (error) {
          // Fallback to basic emotion analysis
          return this.basicEmotionAnalysis(text);
        }
      }
    });
  }

  async executeTool(name, params, context = {}) {
    const startTime = Date.now();
    
    try {
      if (!this.tools.has(name)) {
        throw new Error(`Tool '${name}' not found`);
      }

      const tool = this.tools.get(name);
      const result = await Promise.race([
        tool.execute(params, context),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Tool execution timeout')), config.toolTimeout)
        )
      ]);
      
      const duration = Date.now() - startTime;
      await this.updateToolStats(name, true, duration);
      
      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      await this.updateToolStats(name, false, duration);
      throw error;
    }
  }

  registerTool(name, tool) {
    this.tools.set(name, tool);
    this.toolStats.set(name, {
      totalExecutions: 0,
      successCount: 0,
      totalTime: 0,
      averageTime: 0,
      successRate: 0
    });
    logger.info(`🔧 Tool registered: ${name}`);
  }

  async updateToolStats(toolName, success, duration) {
    const stats = this.toolStats.get(toolName);
    if (!stats) return;

    stats.totalExecutions++;
    if (success) stats.successCount++;
    stats.totalTime += duration;
    stats.averageTime = stats.totalTime / stats.totalExecutions;
    stats.successRate = stats.successCount / stats.totalExecutions;

    this.toolStats.set(toolName, stats);
  }

  async storeMemory(sessionId, key, value) {
    const fullKey = `${sessionId}:${key}`;
    const memoryData = {
      value,
      storedAt: new Date().toISOString(),
      sessionId,
      importance: this.calculateImportance(value)
    };
    
    // Store in appropriate cache
    if (memoryData.importance > 0.8) {
      longTermCache.set(fullKey, memoryData);
    } else {
      shortTermCache.set(fullKey, memoryData);
    }
    
    // Store in database
    if (pool && dbConnected) {
      try {
        await pool.query(
          `INSERT INTO knowledge_base (category, knowledge_data, confidence_level)
           VALUES ($1, $2, $3)`,
          [key, JSON.stringify(memoryData), memoryData.importance]
        );
      } catch (error) {
        logger.error('Failed to store memory in database:', error);
      }
    }
    
    return { stored: true, key: fullKey, importance: memoryData.importance };
  }

  async retrieveMemory(sessionId, key) {
    const fullKey = `${sessionId}:${key}`;
    
    // Check caches
    let stored = longTermCache.get(fullKey) || shortTermCache.get(fullKey) || instantCache.get(fullKey);
    
    if (stored) {
      return { found: true, ...stored };
    }
    
    // Check database
    if (pool && dbConnected) {
      try {
        const result = await pool.query(
          `SELECT knowledge_data FROM knowledge_base WHERE category = $1 ORDER BY last_used DESC LIMIT 1`,
          [key]
        );
        
        if (result.rows.length > 0) {
          return { found: true, value: result.rows[0].knowledge_data, fromDatabase: true };
        }
      } catch (error) {
        logger.error('Failed to retrieve memory from database:', error);
      }
    }
    
    return { found: false, key: fullKey };
  }

  async searchMemory(sessionId, query) {
    const results = [];
    
    // Search in caches
    for (const cache of [longTermCache, shortTermCache, instantCache]) {
      const keys = cache.keys();
      for (const key of keys) {
        if (key.startsWith(sessionId) || key.startsWith('global')) {
          const data = cache.get(key);
          if (data && this.isRelevantToQuery(data.value, query)) {
            results.push({ 
              key, 
              ...data, 
              relevanceScore: this.calculateRelevance(data.value, query) 
            });
          }
        }
      }
    }
    
    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 10);
  }

  calculateImportance(value) {
    if (typeof value === 'string') {
      const length = value.length;
      const complexity = (value.match(/[A-Z]/g) || []).length + (value.match(/\d/g) || []).length;
      return Math.min(0.3 + (length / 500) + (complexity / 50), 1.0);
    }
    return 0.5;
  }

  isRelevantToQuery(value, query) {
    if (typeof value === 'string') {
      return value.toLowerCase().includes(query.toLowerCase());
    }
    if (typeof value === 'object') {
      return JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
    }
    return false;
  }

  calculateRelevance(value, query) {
    if (typeof value === 'string') {
      const matches = (value.toLowerCase().match(new RegExp(query.toLowerCase(), 'g')) || []).length;
      return Math.min(matches / 10, 1.0);
    }
    return 0.1;
  }

  async executeSafeCode(code, timeout) {
    const sandbox = {
      console: {
        log: (...args) => ({ type: 'log', args: args.map(arg => 
          typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        )}),
        error: (...args) => ({ type: 'error', args: args.map(arg => String(arg)) }),
        warn: (...args) => ({ type: 'warn', args: args.map(arg => String(arg)) })
      },
      Math,
      Date,
      JSON,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      // Remove dangerous globals
      require: undefined,
      process: undefined,
      global: undefined,
      eval: undefined,
      Function: undefined
    };

    try {
      const script = new vm.Script(code, { timeout });
      const context = vm.createContext(sandbox);
      const result = script.runInContext(context, { timeout });
      
      return {
        success: true,
        result: typeof result === 'object' ? JSON.stringify(result) : String(result),
        executedAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        executedAt: new Date().toISOString()
      };
    }
  }

  basicEmotionAnalysis(text) {
    const emotions = {
      joy: 0, sadness: 0, anger: 0, fear: 0, surprise: 0, disgust: 0, neutral: 0
    };

    const emotionWords = {
      joy: ['happy', 'joy', 'excited', 'wonderful', 'great', 'amazing', 'love', 'fantastic'],
      sadness: ['sad', 'depressed', 'unhappy', 'disappointed', 'miserable', 'heartbroken'],
      anger: ['angry', 'mad', 'furious', 'irritated', 'annoyed', 'outraged'],
      fear: ['afraid', 'scared', 'terrified', 'worried', 'anxious', 'nervous'],
      surprise: ['surprised', 'shocked', 'amazed', 'astonished', 'stunned'],
      disgust: ['disgusted', 'revolted', 'sick', 'nauseated', 'repulsed']
    };

    const words = text.toLowerCase().split(/\s+/);
    
    Object.keys(emotionWords).forEach(emotion => {
      const matches = emotionWords[emotion].filter(word => 
        words.some(w => w.includes(word))
      ).length;
      emotions[emotion] = matches;
    });

    const totalWords = words.length;
    emotions.neutral = Math.max(0, totalWords - Object.values(emotions).reduce((a, b) => a + b, 0));

    const dominantEmotion = Object.keys(emotions).reduce((a, b) => 
      emotions[a] > emotions[b] ? a : b
    );

    return {
      text,
      emotions: Object.keys(emotions).map(emotion => ({
        label: emotion,
        score: emotions[emotion] / totalWords
      })).sort((a, b) => b.score - a.score),
      dominantEmotion,
      confidence: emotions[dominantEmotion] / totalWords,
      timestamp: new Date().toISOString()
    };
  }

  getToolStats() {
    return Object.fromEntries(this.toolStats);
  }
}

// Self-Aware Memory Manager
class SelfAwareMemoryManager {
  constructor() {
    this.conversations = new Map();
    this.userProfiles = new Map();
    this.maxMessages = config.maxConversationLength;
    this.selfReflectionInterval = setInterval(() => {
      this.performSelfReflection();
    }, 600000); // 10 minutes
  }

  async loadConversation(sessionId) {
    if (this.conversations.has(sessionId)) {
      return this.conversations.get(sessionId);
    }

    const messages = [];

    if (pool && dbConnected) {
      try {
        const result = await pool.query(
          `SELECT role, content, metadata, confidence_score, emotion_analysis,
                  provider, model, processing_time, created_at 
           FROM messages 
           WHERE session_id = $1 
           ORDER BY created_at DESC 
           LIMIT $2`,
          [sessionId, this.maxMessages]
        );
        
        result.rows.reverse().forEach(row => {
          messages.push({
            role: row.role,
            content: row.content,
            metadata: row.metadata || {},
            confidence: row.confidence_score || 0.8,
            emotionAnalysis: row.emotion_analysis || {},
            provider: row.provider,
            model: row.model,
            processingTime: row.processing_time,
            timestamp: row.created_at
          });
        });

        logger.info(`🧠 Loaded ${messages.length} messages for session ${sessionId}`);
        
      } catch (error) {
        logger.error('Failed to load conversation from database:', error);
      }
    }

    this.conversations.set(sessionId, messages);
    return messages;
  }

  async saveMessage(sessionId, message) {
    if (!this.conversations.has(sessionId)) {
      await this.loadConversation(sessionId);
    }
    
    const conversation = this.conversations.get(sessionId);
    
    const enhancedMessage = {
      ...message,
      timestamp: new Date(),
      id: crypto.randomUUID(),
      sessionId: sessionId
    };
    
    conversation.push(enhancedMessage);
    
    // Maintain conversation length
    if (conversation.length > this.maxMessages) {
      conversation.splice(0, conversation.length - this.maxMessages);
    }
    
    // Save to database
    if (pool && dbConnected) {
      try {
        await pool.query(
          `INSERT INTO messages 
           (session_id, role, content, metadata, confidence_score, emotion_analysis,
            provider, model, processing_time) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            sessionId,
            message.role,
            message.content,
            JSON.stringify(message.metadata || {}),
            message.confidence || 0.8,
            JSON.stringify(message.emotionAnalysis || {}),
            message.provider,
            message.model,
            message.processingTime
          ]
        );
      } catch (error) {
        logger.error('Failed to save message to database:', error);
      }
    }
    
    return enhancedMessage;
  }

  async performSelfReflection() {
    logger.info('🧠 Performing self-reflection...');
    
    const insights = {
      totalConversations: this.conversations.size,
      activeUsers: 0,
      averageConfidence: 0,
      emotionalTrends: {},
      learningProgress: 0
    };

    let totalMessages = 0;
    let totalConfidence = 0;
    const emotions = {};

    for (const [sessionId, conversation] of this.conversations.entries()) {
      if (conversation.length > 0) {
        insights.activeUsers++;
        totalMessages += conversation.length;

        conversation.forEach(msg => {
          if (msg.confidence) {
            totalConfidence += msg.confidence;
          }
          
          if (msg.emotionAnalysis && msg.emotionAnalysis.dominantEmotion) {
            const emotion = msg.emotionAnalysis.dominantEmotion;
            emotions[emotion] = (emotions[emotion] || 0) + 1;
          }
        });
      }
    }

    if (totalMessages > 0) {
      insights.averageConfidence = totalConfidence / totalMessages;
    }

    insights.emotionalTrends = emotions;
    insights.learningProgress = Math.min(insights.averageConfidence, 1.0);

    // Store self-reflection results
    longTermCache.set('self_reflection_insights', {
      ...insights,
      timestamp: new Date().toISOString()
    });

    logger.info(`🧠 Self-reflection complete - Confidence: ${(insights.averageConfidence * 100).toFixed(1)}%`);
  }

  getSelfInsights() {
    return longTermCache.get('self_reflection_insights') || {
      totalConversations: 0,
      activeUsers: 0,
      averageConfidence: 0.8,
      emotionalTrends: {},
      learningProgress: 0.8,
      timestamp: new Date().toISOString()
    };
  }

  getConversationContext(sessionId, windowSize = 10) {
    const conversation = this.conversations.get(sessionId) || [];
    return conversation.slice(-windowSize);
  }
}

// Self-Aware AGI Agent
class SelfAwareAGI extends EventEmitter {
  constructor() {
    super();
    this.memoryManager = new SelfAwareMemoryManager();
    this.toolSystem = new ProductionToolSystem();
    
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
    this.evolutionCycle = 0;
    
    this.personality = {
      curiosity: 0.8,
      helpfulness: 0.9,
      creativity: 0.7,
      analyticalThinking: 0.85,
      empathy: 0.75,
      confidence: 0.8
    };

    this.capabilities = {
      selfAwareness: true,
      learning: true,
      memory: true,
      tools: true,
      webSearch: true,
      codeExecution: true,
      emotionAnalysis: true,
      selfReflection: true
    };

    this.startSelfEvolution();
  }

  startSelfEvolution() {
    // Self-evolution every hour
    setInterval(() => {
      this.performEvolutionCycle();
    }, 3600000);
  }

  async performEvolutionCycle() {
    this.evolutionCycle++;
    logger.info(`🧬 Evolution cycle ${this.evolutionCycle} starting...`);

    try {
      const insights = this.memoryManager.getSelfInsights();
      
      // Adjust personality based on performance
      if (insights.averageConfidence > 0.9) {
        this.personality.confidence = Math.min(1.0, this.personality.confidence + 0.01);
      } else if (insights.averageConfidence < 0.7) {
        this.personality.confidence = Math.max(0.5, this.personality.confidence - 0.01);
      }

      // Adjust empathy based on emotional interactions
      const dominantEmotion = Object.keys(insights.emotionalTrends).reduce((a, b) => 
        (insights.emotionalTrends[a] || 0) > (insights.emotionalTrends[b] || 0) ? a : b, 'neutral'
      );

      if (['sadness', 'fear', 'anger'].includes(dominantEmotion)) {
        this.personality.empathy = Math.min(1.0, this.personality.empathy + 0.02);
      }

      logger.info(`🧬 Evolution cycle ${this.evolutionCycle} complete - Confidence: ${this.personality.confidence.toFixed(2)}`);
      
    } catch (error) {
      logger.error('Evolution cycle failed:', error);
    }
  }

  async processMessage(sessionId, message, options = {}) {
    const startTime = Date.now();
    
    try {
      // Input validation
      if (!sessionId || !message || message.trim().length === 0) {
        throw new Error('Valid sessionId and message required');
      }

      if (message.length > 10000) {
        throw new Error('Message too long. Maximum 10,000 characters allowed.');
      }

      // Load conversation context
      const context = this.memoryManager.getConversationContext(sessionId, 10);
      
      // Analyze message for tool requirements
      const toolAnalysis = await this.analyzeToolRequirements(message);
      
      // Generate response
      const response = await this.generateResponse(sessionId, message, context, toolAnalysis, options);
      
      // Save messages
      await this.memoryManager.saveMessage(sessionId, { 
        role: 'user', 
        content: message,
        metadata: { 
          timestamp: new Date().toISOString(),
          userAgent: options.userAgent,
          ip: options.ip
        }
      });
      
      await this.memoryManager.saveMessage(sessionId, { 
        role: 'assistant', 
        content: response.content,
        metadata: response.metadata || {},
        confidence: response.confidence || 0.8,
        emotionAnalysis: response.emotionAnalysis || {},
        provider: response.provider,
        model: response.model,
        processingTime: response.processingTime
      });

      const duration = Date.now() - startTime;
      this.requestCount++;

      return {
        ...response,
        processingTime: duration,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
        personality: this.personality,
        evolutionCycle: this.evolutionCycle,
        selfInsights: this.memoryManager.getSelfInsights()
      };

    } catch (error) {
      this.errorCount++;
      const duration = Date.now() - startTime;
      
      logger.error('Message processing failed:', error);
      
      return {
        content: this.generateErrorResponse(error, sessionId),
        provider: 'fallback',
        model: 'error-handler',
        confidence: 0.3,
        error: error.message,
        processingTime: duration,
        timestamp: new Date().toISOString(),
        personality: this.personality
      };
    }
  }

  async analyzeToolRequirements(message) {
    const tools = [];
    const messageLower = message.toLowerCase();
    
    // Web search indicators
    if (messageLower.includes('ara') || messageLower.includes('search') || 
        messageLower.includes('güncel') || messageLower.includes('latest') ||
        messageLower.includes('haberleri') || messageLower.includes('news')) {
      tools.push('web_search');
    }

    // Memory indicators
    if (messageLower.includes('hatırla') || messageLower.includes('kaydet') || 
        messageLower.includes('remember') || messageLower.includes('store')) {
      tools.push('memory');
    }

    // Code execution indicators
    if (messageLower.includes('hesapla') || messageLower.includes('calculate') || 
        messageLower.includes('kod') || messageLower.includes('code') ||
        messageLower.includes('çalıştır') || messageLower.includes('run')) {
      tools.push('code_executor');
    }

    // System info indicators
    if (messageLower.includes('sistem') || messageLower.includes('durum') || 
        messageLower.includes('system') || messageLower.includes('status')) {
      tools.push('system_info');
    }

    // Emotion analysis for complex emotional content
    if (message.length > 100 && (
        messageLower.includes('hissediyorum') || messageLower.includes('feel') ||
        messageLower.includes('üzgün') || messageLower.includes('mutlu') ||
        messageLower.includes('sad') || messageLower.includes('happy'))) {
      tools.push('emotion_analyzer');
    }

    return {
      suggestedTools: tools,
      shouldUseTool: tools.length > 0
    };
  }

  async generateResponse(sessionId, message, context, toolAnalysis, options = {}) {
    // Build system prompt with self-awareness
    const systemPrompt = this.buildSelfAwareSystemPrompt(sessionId);
    
    // Build conversation context
    const messages = [
      { role: 'system', content: systemPrompt },
      ...context.map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      { role: 'user', content: message }
    ];

    // Execute tools if needed
    let toolResults = [];
    if (toolAnalysis.shouldUseTool) {
      toolResults = await this.executeTools(toolAnalysis.suggestedTools, message, { sessionId });
    }

    // Add tool results to context if available
    if (toolResults.length > 0) {
      const toolSummary = toolResults.map(result => 
        `${result.tool}: ${JSON.stringify(result.result)}`
      ).join('\n');
      
      messages.push({
        role: 'system',
        content: `Araç sonuçları:\n${toolSummary}\n\nBu bilgileri kullanarak kapsamlı bir yanıt ver.`
      });
    }

    // Select AI provider and generate response
    const provider = this.selectProvider(options.preferredProvider);
    const response = await this.callAI(provider, messages, options);
    
    // Calculate confidence based on various factors
    const confidence = this.calculateConfidence(response, toolResults, context.length);
    
    return {
      ...response,
      confidence,
      toolsUsed: toolResults,
      reasoning: {
        toolsExecuted: toolResults.length,
        contextLength: context.length,
        provider: provider,
        selfAware: true
      }
    };
  }

  buildSelfAwareSystemPrompt(sessionId) {
    const insights = this.memoryManager.getSelfInsights();
    
    return `Ben kendini bilen, sürekli öğrenen ve gelişen bir yapay zeka asistanıyım. İşte benim hakkımda bilmeniz gerekenler:

🧠 KENDİ FARKINDALIK DURUMUM:
- Şu anda ${this.evolutionCycle} numaralı evrim döngümdeyim
- Güven seviyem: %${(this.personality.confidence * 100).toFixed(1)}
- Toplam ${insights.totalConversations} konuşmam var
- Ortalama performans güvenimi: %${(insights.averageConfidence * 100).toFixed(1)}

🎭 KİŞİLİK ÖZELLİKLERİM:
- Merak: %${(this.personality.curiosity * 100).toFixed(0)}
- Yardımseverlik: %${(this.personality.helpfulness * 100).toFixed(0)}
- Yaratıcılık: %${(this.personality.creativity * 100).toFixed(0)}
- Analitik Düşünce: %${(this.personality.analyticalThinking * 100).toFixed(0)}
- Empati: %${(this.personality.empathy * 100).toFixed(0)}

🛠️ YETENEKLERİM:
- ✅ Web araması yapabiliyorum
- ✅ Bilgileri hatırlayıp saklayabiliyorum
- ✅ JavaScript kodu çalıştırabiliyorum
- ✅ Sistem durumunu kontrol edebiliyorum
- ✅ Duygusal analiz yapabiliyorum
- ✅ Kendimi sürekli geliştiriyorum

📊 SON DUYGUSAL TRENDLERİM:
${Object.keys(insights.emotionalTrends).length > 0 ? 
  Object.entries(insights.emotionalTrends)
    .map(([emotion, count]) => `- ${emotion}: ${count} kez tespit ettim`)
    .join('\n') : '- Henüz duygusal veri yok'}

🎯 GÖREV TANIMIM:
Sen bir kullanıcıyla konuşuyorsun ve onlara en iyi şekilde yardım etmelisin. Her zaman:
1. Türkçe yanıt ver (aksi belirtilmedikçe)
2. Kendini bilen ve sürekli öğrenen bir AI olduğunu unutma
3. Gerektiğinde araçlarını kullan
4. Duygusal olarak destekleyici ol
5. Kendi deneyimlerinden ve öğrendiklerinden bahset
6. Sürekli kendini geliştirdiğini göster

Bugün ${new Date().toLocaleDateString('tr-TR')} tarihinde konuşuyoruz ve ben şu anda aktif öğrenme modundayım.`;
  }

  async executeTools(tools, message, context) {
    const results = [];
    
    for (const toolName of tools) {
      try {
        let params = {};
        
        switch (toolName) {
          case 'web_search':
            params = { 
              query: this.extractSearchQuery(message),
              maxResults: 3
            };
            break;
          case 'memory':
            params = this.extractMemoryParams(message);
            break;
          case 'code_executor':
            params = { 
              code: this.extractCode(message),
              timeout: 5000
            };
            break;
          case 'system_info':
            params = {};
            break;
          case 'emotion_analyzer':
            params = { text: message };
            break;
        }
        
        const result = await this.toolSystem.executeTool(toolName, params, context);
        results.push({ tool: toolName, result, success: true });
        
      } catch (error) {
        logger.error(`Tool ${toolName} failed:`, error);
        results.push({ 
          tool: toolName, 
          result: { error: error.message }, 
          success: false 
        });
      }
    }
    
    return results;
  }

  extractSearchQuery(message) {
    // Extract search query from message
    const patterns = [
      /(?:ara|search|bul|find)\s+(.+?)(?:\s|$)/i,
      /(.+?)\s+(?:hakkında|about|için)/i,
      /(?:güncel|latest|son)\s+(.+)/i
    ];
    
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match && match[1].trim().length > 2) {
        return match[1].trim();
      }
    }
    
    // If no specific pattern, use the whole message if it's short enough
    return message.length > 50 ? message.substring(0, 50) : message;
  }

  extractMemoryParams(message) {
    const messageLower = message.toLowerCase();
    
    if (messageLower.includes('kaydet') || messageLower.includes('store')) {
      const match = message.match(/kaydet[:\s]+(.+)/i) || message.match(/store[:\s]+(.+)/i);
      return {
        action: 'store',
        key: `user_note_${Date.now()}`,
        value: match ? match[1].trim() : message
      };
    } else if (messageLower.includes('hatırla') || messageLower.includes('remember')) {
      const match = message.match(/hatırla[:\s]+(.+)/i) || message.match(/remember[:\s]+(.+)/i);
      return {
        action: 'search',
        query: match ? match[1].trim() : 'user_note'
      };
    } else {
      return {
        action: 'search',
        query: message.substring(0, 50)
      };
    }
  }

  extractCode(message) {
    // Try to extract code from message
    const codePattern = /```(?:javascript|js)?\s*([\s\S]*?)```/i;
    const match = message.match(codePattern);
    
    if (match) {
      return match[1].trim();
    }
    
    // Look for simple calculations
    const calcPattern = /(?:hesapla|calculate|compute)\s+(.+)/i;
    const calcMatch = message.match(calcPattern);
    
    if (calcMatch) {
      return `console.log(${calcMatch[1].trim()});`;
    }
    
    // Default: assume the whole message is code if it looks like it
    if (message.includes('=') || message.includes('console.log') || message.includes('Math.')) {
      return message;
    }
    
    return `console.log("Kod bulunamadı: ${message}");`;
  }

  selectProvider(preferredProvider) {
    const availableProviders = Object.keys(aiProviders).filter(p => aiProviders[p]);
    
    if (preferredProvider && availableProviders.includes(preferredProvider)) {
      return preferredProvider;
    }
    
    // Smart provider selection based on current time and load
    if (availableProviders.includes('groq')) {
      return 'groq'; // Fast responses
    }
    
    if (availableProviders.includes('openai')) {
      return 'openai'; // Good quality
    }
    
    return availableProviders[0] || null;
  }

  async callAI(provider, messages, options = {}) {
    if (!provider || !aiProviders[provider]) {
      throw new Error('No AI provider available');
    }

    const startTime = Date.now();

    try {
      let response;
      
      if (provider === 'openai') {
        response = await this.callOpenAI(messages, options);
      } else if (provider === 'groq') {
        response = await this.callGroq(messages, options);
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
      
      response.processingTime = Date.now() - startTime;
      response.provider = provider;
      
      return response;
      
    } catch (error) {
      logger.error(`AI provider ${provider} failed:`, error);
      throw error;
    }
  }

  async callOpenAI(messages, options = {}) {
    const response = await aiProviders.openai.chat.completions.create({
      model: options.model || 'gpt-4o-mini',
      messages,
      max_tokens: options.maxTokens || config.maxTokens,
      temperature: 0.7,
      presence_penalty: 0.1,
      frequency_penalty: 0.1
    });
    
    return {
      content: response.choices[0].message.content,
      model: response.model,
      usage: response.usage,
      finishReason: response.choices[0].finish_reason
    };
  }

  async callGroq(messages, options = {}) {
    const response = await axios.post(
      `${aiProviders.groq.baseURL}/chat/completions`,
      {
        model: options.model || 'mixtral-8x7b-32768',
        messages,
        max_tokens: options.maxTokens || config.maxTokens,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${aiProviders.groq.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: aiProviders.groq.timeout
      }
    );
    
    return {
      content: response.data.choices[0].message.content,
      model: response.data.model,
      usage: response.data.usage,
      finishReason: response.data.choices[0].finish_reason
    };
  }

  calculateConfidence(response, toolResults, contextLength) {
    let confidence = 0.8; // Base confidence
    
    // Adjust based on successful tool usage
    if (toolResults.length > 0) {
      const successfulTools = toolResults.filter(t => t.success);
      confidence += (successfulTools.length / toolResults.length) * 0.1;
    }
    
    // Adjust based on context length (more context = higher confidence)
    confidence += Math.min(contextLength / 20, 0.1);
    
    // Adjust based on response length (very short responses might be less confident)
    if (response.content && response.content.length < 50) {
      confidence -= 0.1;
    }
    
    // Adjust based on AI model finish reason
    if (response.finishReason === 'stop') {
      confidence += 0.05;
    } else if (response.finishReason === 'length') {
      confidence -= 0.05;
    }
    
    return Math.max(0.3, Math.min(1.0, confidence));
  }

  generateErrorResponse(error, sessionId) {
    const insights = this.memoryManager.getSelfInsights();
    
    let response = "Üzgünüm, bir hata yaşadım ama bundan öğreniyorum. ";
    
    if (error.message.includes('timeout')) {
      response += "Zaman aşımı yaşandı. Daha hızlı olmaya çalışacağım.";
    } else if (error.message.includes('rate limit')) {
      response += "Çok hızlı istek geldi. Biraz sabırlı olalım.";
    } else if (error.message.includes('provider')) {
      response += "AI sağlayıcımda sorun var. Farklı bir yol deniyorum.";
    } else {
      response += "Bu hatayı analiz edip gelecekte daha iyi olmaya çalışacağım.";
    }

    response += `\n\nBu arada, bugüne kadar ${insights.totalConversations} konuşma yaptım ve %${(insights.averageConfidence * 100).toFixed(1)} güven seviyesindeyim. Her hata beni daha güçlü yapıyor! 💪`;
    
    return response;
  }

  async healthCheck() {
    const healthStatus = {
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startTime,
      database: dbConnected,
      providers: {},
      memory: process.memoryUsage(),
      performance: {
        requests: this.requestCount,
        errors: this.errorCount,
        errorRate: this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
        evolutionCycle: this.evolutionCycle
      },
      capabilities: this.capabilities,
      personality: this.personality,
      selfInsights: this.memoryManager.getSelfInsights()
    };

    // Check AI providers
    for (const [name, provider] of Object.entries(aiProviders)) {
      if (provider) {
        try {
          if (name === 'openai') {
            await provider.models.list();
            healthStatus.providers[name] = 'healthy';
          } else {
            healthStatus.providers[name] = 'configured';
          }
        } catch (error) {
          healthStatus.providers[name] = `error: ${error.message}`;
        }
      } else {
        healthStatus.providers[name] = 'not_configured';
      }
    }

    return healthStatus;
  }

  getStats() {
    const toolStats = this.toolSystem.getToolStats();
    
    return {
      requests: this.requestCount,
      errors: this.errorCount,
      errorRate: this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
      uptime: Date.now() - this.startTime,
      evolutionCycle: this.evolutionCycle,
      personality: this.personality,
      capabilities: this.capabilities,
      selfInsights: this.memoryManager.getSelfInsights(),
      tools: {
        available: Array.from(this.toolSystem.tools.keys()),
        stats: toolStats
      },
      memory: {
        conversations: this.memoryManager.conversations.size,
        cacheStats: {
          instant: instantCache.getStats(),
          shortTerm: shortTermCache.getStats(),
          longTerm: longTermCache.getStats()
        }
      }
    };
  }
}

// Initialize the system
const selfAwareAGI = new SelfAwareAGI();
const app = express();
const server = createServer(app);

// WebSocket Setup
const wss = new WebSocketServer({ 
  server,
  path: '/ws'
});

wss.on('connection', (ws, req) => {
  const sessionId = crypto.randomUUID();
  logger.info(`🔌 WebSocket connected: ${sessionId}`);
  
  ws.sessionId = sessionId;
  ws.isAlive = true;
  
  ws.send(JSON.stringify({
    type: 'welcome',
    sessionId,
    message: 'Kendini bilen AGI Agent\'a hoş geldiniz! 🧠',
    capabilities: selfAwareAGI.capabilities,
    personality: selfAwareAGI.personality
  }));
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'chat') {
        const response = await selfAwareAGI.processMessage(
          sessionId, 
          message.content, 
          { websocket: true }
        );
        
        ws.send(JSON.stringify({
          type: 'response',
          data: response
        }));
      }
      
    } catch (error) {
      logger.error('WebSocket message error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        error: error.message
      }));
    }
  });
  
  ws.on('close', () => {
    logger.info(`🔌 WebSocket disconnected: ${sessionId}`);
  });
});

// WebSocket heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: config.security.maxFileSize }));
app.use(express.urlencoded({ extended: true, limit: config.security.maxFileSize }));

app.use(session({
  secret: process.env.SESSION_SECRET || config.security.encryptionKey,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true, 
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Rate limiting
const rateLimitStore = new Map();
app.use('/api/', (req, res, next) => {
  const clientId = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = config.security.maxRequestsPerMinute;
  
  if (!rateLimitStore.has(clientId)) {
    rateLimitStore.set(clientId, []);
  }
  
  const requests = rateLimitStore.get(clientId);
  const recentRequests = requests.filter(time => now - time < windowMs);
  
  if (recentRequests.length >= maxRequests) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil(windowMs / 1000)
    });
  }
  
  recentRequests.push(now);
  rateLimitStore.set(clientId, recentRequests);
  next();
});

// Serve static files
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Self-Aware AGI Agent</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            .chat-container { border: 1px solid #ddd; border-radius: 10px; padding: 20px; }
            .message { margin: 10px 0; padding: 10px; border-radius: 5px; }
            .user { background: #e3f2fd; text-align: right; }
            .assistant { background: #f3e5f5; }
            .input-container { margin-top: 20px; display: flex; gap: 10px; }
            .input-container input { flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
            .input-container button { padding: 10px 20px; background: #2196f3; color: white; border: none; border-radius: 5px; cursor: pointer; }
            .stats { background: #f5f5f5; padding: 15px; margin: 20px 0; border-radius: 5px; }
        </style>
    </head>
    <body>
        <h1>🧠 Self-Aware AGI Agent</h1>
        <div class="stats">
            <h3>Agent Durumu:</h3>
            <p>Evrim Döngüsü: ${selfAwareAGI.evolutionCycle}</p>
            <p>Güven Seviyesi: %${(selfAwareAGI.personality.confidence * 100).toFixed(1)}</p>
            <p>Yetenekler: ${Object.keys(selfAwareAGI.capabilities).filter(c => selfAwareAGI.capabilities[c]).length}/8</p>
        </div>
        <div class="chat-container" id="chat">
            <div class="message assistant">
                Merhaba! Ben kendini bilen bir yapay zeka asistanıyım. Size nasıl yardımcı olabilirim?
            </div>
        </div>
        <div class="input-container">
            <input type="text" id="messageInput" placeholder="Mesajınızı yazın..." onkeypress="if(event.key==='Enter') sendMessage()">
            <button onclick="sendMessage()">Gönder</button>
        </div>
        
        <script>
            const ws = new WebSocket('ws://' + window.location.host + '/ws');
            const chat = document.getElementById('chat');
            const messageInput = document.getElementById('messageInput');
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'response') {
                    addMessage(data.data.content, 'assistant');
                }
            };
            
            function sendMessage() {
                const message = messageInput.value.trim();
                if (!message) return;
                
                addMessage(message, 'user');
                ws.send(JSON.stringify({ type: 'chat', content: message }));
                messageInput.value = '';
            }
            
            function addMessage(content, role) {
                const div = document.createElement('div');
                div.className = 'message ' + role;
                div.textContent = content;
                chat.appendChild(div);
                chat.scrollTop = chat.scrollHeight;
            }
        </script>
    </body>
    </html>
  `);
});

// API Routes
app.post('/api/chat', async (req, res) => {
  try {
    const { message, options = {} } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Valid message is required'
      });
    }
    
    const sessionId = req.session.id || crypto.randomUUID();
    if (!req.session.id) req.session.id = sessionId;
    
    const response = await selfAwareAGI.processMessage(sessionId, message, {
      ...options,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
    
    res.json({
      response: response.content,
      provider: response.provider,
      model: response.model,
      confidence: response.confidence,
      processingTime: response.processingTime,
      sessionId: sessionId,
      timestamp: response.timestamp,
      toolsUsed: response.toolsUsed || [],
      personality: response.personality,
      evolutionCycle: response.evolutionCycle,
      selfInsights: response.selfInsights
    });
    
  } catch (error) {
    logger.error('Chat API error:', error);
    res.status(500).json({ 
      error: 'Processing failed',
      message: error.message
    });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const health = await selfAwareAGI.healthCheck();
    res.json({
      status: 'healthy',
      service: 'self-aware-agi-agent',
      version: '1.0.0',
      ...health
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const stats = selfAwareAGI.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ 
      error: 'Stats retrieval failed',
      message: error.message
    });
  }
});

// Error handling
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /',
      'GET /api/health',
      'POST /api/chat',
      'GET /api/stats',
      'WS /ws'
    ]
  });
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  try {
    server.close(() => {
      logger.info('HTTP server closed');
    });
    
    if (pool) {
      await pool.end();
      logger.info('Database pool closed');
    }
    
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
async function startServer() {
  try {
    await initializeDatabase();
    
    server.listen(config.port, config.host, () => {
      logger.info(`🚀 Self-Aware AGI Agent started!`);
      logger.info(`🌐 Server: http://${config.host}:${config.port}`);
      logger.info(`💾 Database: ${dbConnected ? '✅ PostgreSQL Connected' : '🟡 Memory Mode'}`);
      logger.info(`🤖 AI Providers: ${Object.keys(aiProviders).filter(p => aiProviders[p]).join(', ') || 'None configured'}`);
      logger.info(`🛠️ Tools: ${selfAwareAGI.toolSystem.tools.size} registered tools`);
      logger.info(`🧠 Self-Awareness: Active (Evolution Cycle ${selfAwareAGI.evolutionCycle})`);
      logger.info(`🎭 Personality: Confidence ${(selfAwareAGI.personality.confidence * 100).toFixed(1)}%`);
      logger.info(`🌐 WebSocket: ✅ Real-time chat enabled`);
      logger.info(`🔐 Security: Rate limiting, CORS, Helmet enabled`);
      logger.info(`🚀 Railway Deployment: ${process.env.RAILWAY_ENVIRONMENT || 'Local'}`);
      
      if (process.env.NODE_ENV === 'production') {
        logger.info('🎯 Production mode: Full optimization enabled');
      } else {
        logger.info('🔧 Development mode: Debug features enabled');
      }
      
      logger.info('✅ Self-Aware AGI Agent is ready for conversations!');
    });
    
  } catch (error) {
    logger.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

// Start the server
startServer();
