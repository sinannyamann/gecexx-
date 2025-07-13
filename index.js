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

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Enhanced Configuration with Railway optimizations
const config = {
  port: process.env.PORT || 5000,
  host: '0.0.0.0',
  maxTokens: 8000,
  defaultModel: 'gpt-4o-mini',
  memoryRetentionDays: 30,
  maxConversationLength: 50,
  reasoningDepth: 3,
  toolTimeout: 30000,
  learningRate: 0.1,
  database: {
    maxConnections: process.env.NODE_ENV === 'production' ? 20 : 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    retryAttempts: 3,
    retryDelay: 1000
  }
};

// Enhanced Logger with better error handling
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ],
  exceptionHandlers: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Enhanced Cache system
const cache = new NodeCache({ 
  stdTTL: 3600, 
  checkperiod: 300,
  useClones: false,
  maxKeys: 1000
});

const longTermCache = new NodeCache({ 
  stdTTL: 86400, 
  checkperiod: 3600,
  useClones: false,
  maxKeys: 500
});

// Enhanced Database with connection pooling and error recovery
let pool = null;
let dbConnected = false;
let dbRetryCount = 0;

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    logger.warn('DATABASE_URL not found - using memory only mode');
    return false;
  }

  const maxRetries = config.database.retryAttempts;
  
  while (dbRetryCount < maxRetries) {
    try {
      // Parse DATABASE_URL for Railway
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
        connectionTimeoutMillis: config.database.connectionTimeoutMillis,
        acquireTimeoutMillis: 60000,
        createTimeoutMillis: 30000,
        destroyTimeoutMillis: 5000,
        reapIntervalMillis: 1000,
        createRetryIntervalMillis: 200
      });

      // Test connection
      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();

      // Create enhanced tables with better indexes
      await createTables();

      logger.info('✅ Database connected successfully');
      dbConnected = true;
      dbRetryCount = 0;
      return true;

    } catch (error) {
      dbRetryCount++;
      logger.error(`❌ Database connection attempt ${dbRetryCount}/${maxRetries} failed:`, error.message);
      
      if (dbRetryCount >= maxRetries) {
        logger.error('❌ Max database retry attempts reached. Continuing in memory-only mode.');
        return false;
      }
      
      await new Promise(resolve => setTimeout(resolve, config.database.retryDelay * dbRetryCount));
    }
  }
  return false;
}

async function createTables() {
  const createTablesSQL = `
    -- Conversations table with better indexing
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255) UNIQUE NOT NULL,
      user_profile JSONB DEFAULT '{}',
      preferences JSONB DEFAULT '{}',
      context JSONB DEFAULT '{}',
      message_count INTEGER DEFAULT 0,
      last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_last_activity ON conversations(last_activity);

    -- Messages table with better structure
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      reasoning JSONB DEFAULT '{}',
      tools_used JSONB DEFAULT '[]',
      confidence_score FLOAT DEFAULT 0.8,
      provider VARCHAR(50),
      model VARCHAR(100),
      processing_time INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

    -- System stats table
    CREATE TABLE IF NOT EXISTS system_stats (
      id SERIAL PRIMARY KEY,
      metric_name VARCHAR(100) NOT NULL,
      metric_value JSONB NOT NULL,
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_system_stats_metric_name ON system_stats(metric_name);
    CREATE INDEX IF NOT EXISTS idx_system_stats_recorded_at ON system_stats(recorded_at);

    -- Update conversations trigger
    CREATE OR REPLACE FUNCTION update_conversation_activity()
    RETURNS TRIGGER AS $$
    BEGIN
      UPDATE conversations 
      SET 
        last_activity = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP,
        message_count = message_count + 1
      WHERE session_id = NEW.session_id;
      
      IF NOT FOUND THEN
        INSERT INTO conversations (session_id, message_count, last_activity)
        VALUES (NEW.session_id, 1, CURRENT_TIMESTAMP)
        ON CONFLICT (session_id) DO UPDATE SET
          last_activity = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          message_count = conversations.message_count + 1;
      END IF;
      
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trigger_update_conversation_activity ON messages;
    CREATE TRIGGER trigger_update_conversation_activity
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION update_conversation_activity();
  `;

  await pool.query(createTablesSQL);
  logger.info('✅ Database tables created/updated successfully');
}

// Enhanced AI Providers with better error handling
const aiProviders = {
  openai: process.env.OPENAI_API_KEY ? new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,
    maxRetries: 3,
    dangerouslyAllowBrowser: false
  }) : null,
  
  deepseek: process.env.DEEPSEEK_API_KEY ? {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
    timeout: 60000
  } : null,
  
  anthropic: process.env.ANTHROPIC_API_KEY ? {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 60000
  } : null
};

// Enhanced Tool System with better error handling
class EnhancedToolSystem extends EventEmitter {
  constructor() {
    super();
    this.tools = new Map();
    this.toolStats = new Map();
    this.registerBasicTools();
    this.setMaxListeners(20);
  }

  registerTool(name, tool) {
    if (!tool.execute || typeof tool.execute !== 'function') {
      throw new Error(`Tool ${name} must have an execute function`);
    }
    
    this.tools.set(name, {
      ...tool,
      registeredAt: new Date(),
      executeCount: 0,
      errorCount: 0
    });
    
    this.toolStats.set(name, {
      totalExecutions: 0,
      totalTime: 0,
      errors: 0,
      lastUsed: null
    });
    
    logger.info(`🔧 Tool registered: ${name}`);
  }

  async executeTool(name, params, context = {}) {
    const startTime = Date.now();
    
    try {
      if (!this.tools.has(name)) {
        throw new Error(`Tool '${name}' not found. Available tools: ${Array.from(this.tools.keys()).join(', ')}`);
      }

      const tool = this.tools.get(name);
      const stats = this.toolStats.get(name);
      
      // Validate parameters
      if (tool.parameters) {
        this.validateParameters(params, tool.parameters);
      }

      // Execute with timeout
      const result = await Promise.race([
        tool.execute(params, context),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Tool '${name}' execution timeout`)), config.toolTimeout)
        )
      ]);

      const duration = Date.now() - startTime;
      
      // Update statistics
      stats.totalExecutions++;
      stats.totalTime += duration;
      stats.lastUsed = new Date();
      tool.executeCount++;

      this.emit('toolExecuted', { 
        name, 
        params, 
        result, 
        duration, 
        success: true,
        context 
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      const stats = this.toolStats.get(name);
      
      if (stats) {
        stats.errors++;
      }
      
      const tool = this.tools.get(name);
      if (tool) {
        tool.errorCount++;
      }

      this.emit('toolExecuted', { 
        name, 
        params, 
        error: error.message, 
        duration, 
        success: false,
        context 
      });

      throw error;
    }
  }

  validateParameters(params, schema) {
    if (!params || typeof params !== 'object') {
      throw new Error('Parameters must be an object');
    }

    for (const [key, config] of Object.entries(schema)) {
      if (config.required && !(key in params)) {
        throw new Error(`Required parameter '${key}' is missing`);
      }
      
      if (key in params && config.type) {
        const value = params[key];
        const expectedType = config.type === 'any' ? typeof value : config.type;
        
        if (config.type !== 'any' && typeof value !== expectedType) {
          throw new Error(`Parameter '${key}' must be of type ${config.type}, got ${typeof value}`);
        }
      }
    }
  }

  registerBasicTools() {
    // Enhanced Echo Tool
    this.registerTool('echo', {
      name: 'echo',
      description: 'Echo back the input with timestamp',
      parameters: {
        message: { type: 'string', required: true }
      },
      execute: async (params) => {
        return { 
          echo: params.message,
          timestamp: new Date().toISOString(),
          tool: 'echo'
        };
      }
    });

    // Enhanced Memory Tool
    this.registerTool('memory_store', {
      name: 'memory_store',
      description: 'Store information in memory with expiration',
      parameters: {
        key: { type: 'string', required: true },
        value: { type: 'any', required: true },
        ttl: { type: 'number', required: false }
      },
      execute: async (params, context) => {
        const fullKey = `${context.sessionId || 'global'}:${params.key}`;
        const ttl = params.ttl || 3600;
        
        longTermCache.set(fullKey, {
          value: params.value,
          storedAt: new Date().toISOString(),
          sessionId: context.sessionId
        }, ttl);
        
        return { 
          stored: true, 
          key: fullKey,
          ttl: ttl
        };
      }
    });

    // Memory Retrieve Tool
    this.registerTool('memory_get', {
      name: 'memory_get',
      description: 'Retrieve information from memory',
      parameters: {
        key: { type: 'string', required: true }
      },
      execute: async (params, context) => {
        const fullKey = `${context.sessionId || 'global'}:${params.key}`;
        const stored = longTermCache.get(fullKey);
        
        if (!stored) {
          throw new Error(`No data found for key: ${params.key}`);
        }
        
        return {
          found: true,
          key: fullKey,
          value: stored.value,
          storedAt: stored.storedAt
        };
      }
    });

    // System Information Tool
    this.registerTool('system_info', {
      name: 'system_info',
      description: 'Get system information and statistics',
      parameters: {},
      execute: async () => {
        return {
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          version: process.version,
          platform: process.platform,
          tools: Array.from(this.tools.keys())
        };
      }
    });
  }

  getToolStats() {
    const stats = {};
    for (const [name, data] of this.toolStats.entries()) {
      stats[name] = {
        ...data,
        avgExecutionTime: data.totalExecutions > 0 ? data.totalTime / data.totalExecutions : 0,
        errorRate: data.totalExecutions > 0 ? data.errors / data.totalExecutions : 0
      };
    }
    return stats;
  }
}

// Enhanced Memory Manager with database persistence
class EnhancedMemoryManager {
  constructor() {
    this.conversations = new Map();
    this.userProfiles = new Map();
    this.maxMessages = config.maxConversationLength;
    this.memoryCleanupInterval = 60000; // 1 minute
    this.startCleanupProcess();
  }

  async loadConversation(sessionId) {
    if (this.conversations.has(sessionId)) {
      return this.conversations.get(sessionId);
    }

    const messages = [];

    if (pool && dbConnected) {
      try {
        const result = await pool.query(
          `SELECT role, content, metadata, reasoning, tools_used, confidence_score, 
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
            reasoning: row.reasoning || {},
            toolsUsed: row.tools_used || [],
            confidence: row.confidence_score || 0.8,
            provider: row.provider,
            model: row.model,
            processingTime: row.processing_time,
            timestamp: row.created_at
          });
        });

        logger.info(`📚 Loaded ${messages.length} messages for session ${sessionId}`);
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
    
    // Maintain conversation length limit
    if (conversation.length > this.maxMessages) {
      const removed = conversation.splice(0, conversation.length - this.maxMessages);
      logger.info(`🗑️ Removed ${removed.length} old messages from session ${sessionId}`);
    }
    
    // Save to database
    if (pool && dbConnected) {
      try {
        await pool.query(
          `INSERT INTO messages 
           (session_id, role, content, metadata, reasoning, tools_used, confidence_score, provider, model, processing_time) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            sessionId,
            message.role,
            message.content,
            JSON.stringify(message.metadata || {}),
            JSON.stringify(message.reasoning || {}),
            JSON.stringify(message.toolsUsed || []),
            message.confidence || 0.8,
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

  getContextWindow(sessionId, windowSize = 10) {
    const conversation = this.conversations.get(sessionId) || [];
    return conversation.slice(-windowSize);
  }

  async getConversationStats(sessionId) {
    if (pool && dbConnected) {
      try {
        const result = await pool.query(
          `SELECT 
             COUNT(*) as total_messages,
             COUNT(CASE WHEN role = 'user' THEN 1 END) as user_messages,
             COUNT(CASE WHEN role = 'assistant' THEN 1 END) as assistant_messages,
             AVG(processing_time) as avg_processing_time,
             MIN(created_at) as first_message,
             MAX(created_at) as last_message
           FROM messages 
           WHERE session_id = $1`,
          [sessionId]
        );
        
        return result.rows[0];
      } catch (error) {
        logger.error('Failed to get conversation stats:', error);
        return null;
      }
    }
    
    const conversation = this.conversations.get(sessionId) || [];
    return {
      total_messages: conversation.length,
      user_messages: conversation.filter(m => m.role === 'user').length,
      assistant_messages: conversation.filter(m => m.role === 'assistant').length
    };
  }

  startCleanupProcess() {
    setInterval(() => {
      this.cleanupMemory();
    }, this.memoryCleanupInterval);
  }

  cleanupMemory() {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    for (const [sessionId, messages] of this.conversations.entries()) {
      if (messages.length === 0) continue;
      
      const lastMessage = messages[messages.length - 1];
      const messageAge = now - new Date(lastMessage.timestamp).getTime();
      
      if (messageAge > maxAge) {
        this.conversations.delete(sessionId);
        logger.info(`🧹 Cleaned up inactive session: ${sessionId}`);
      }
    }
  }
}

// Enhanced AGI Agent with better error handling and performance
class EnhancedAGIAgent extends EventEmitter {
  constructor() {
    super();
    this.memoryManager = new EnhancedMemoryManager();
    this.toolSystem = new EnhancedToolSystem();
    
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
    this.lastHealthCheck = Date.now();
    
    this.capabilities = {
      reasoning: true,
      learning: true,
      memory: true,
      tools: true,
      planning: true,
      multimodal: false,
      persistence: dbConnected
    };

    this.setMaxListeners(50);
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.toolSystem.on('toolExecuted', (data) => {
      logger.info(`🔧 Tool executed: ${data.name} (${data.duration}ms) ${data.success ? '✅' : '❌'}`);
    });

    this.on('messageProcessed', (data) => {
      if (data.success) {
        logger.info(`💬 Message processed successfully (${data.duration}ms)`);
      } else {
        logger.error(`💬 Message processing failed: ${data.error}`);
      }
    });
  }

  async processMessage(sessionId, message, options = {}) {
    const startTime = Date.now();
    
    try {
      // Validate input
      if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Valid sessionId is required');
      }
      
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('Valid message is required');
      }

      // Load conversation context
      await this.memoryManager.loadConversation(sessionId);
      const conversationContext = this.memoryManager.getContextWindow(sessionId, options.contextWindow || 10);
      
      // Generate response with enhanced context
      const response = await this.generateResponse(
        sessionId,
        message,
        conversationContext,
        options
      );

      // Save messages to memory
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
        reasoning: response.reasoning || {},
        toolsUsed: response.toolsUsed || [],
        confidence: response.confidence || 0.8,
        provider: response.provider,
        model: response.model,
        processingTime: response.processingTime
      });

      const duration = Date.now() - startTime;
      this.requestCount++;

      const result = {
        ...response,
        processingTime: duration,
        sessionId: sessionId,
        timestamp: new Date().toISOString()
      };

      this.emit('messageProcessed', {
        input: message,
        output: response.content,
        success: true,
        duration: duration,
        sessionId: sessionId
      });

      return result;

    } catch (error) {
      this.errorCount++;
      const duration = Date.now() - startTime;
      
      logger.error('Message processing failed:', error);
      
      const fallbackResponse = {
        content: this.generateErrorResponse(error),
        provider: 'fallback',
        model: 'error-handler',
        confidence: 0.1,
        error: error.message,
        processingTime: duration,
        timestamp: new Date().toISOString()
      };

      this.emit('messageProcessed', {
        input: message,
        output: fallbackResponse.content,
        success: false,
        error: error.message,
        duration: duration,
        sessionId: sessionId
      });

      return fallbackResponse;
    }
  }

  generateErrorResponse(error) {
    const errorResponses = [
      "Üzgünüm, bir hata oluştu. Lütfen tekrar deneyin.",
      "Geçici bir teknik sorun yaşıyorum. Kısa bir süre sonra tekrar deneyin.",
      "Şu anda sistemi işlem yapamıyorum. Lütfen daha sonra tekrar deneyin.",
      "Bir sorun oluştu ama düzeltmeye çalışıyorum. Tekrar dener misiniz?"
    ];
    
    const randomResponse = errorResponses[Math.floor(Math.random() * errorResponses.length)];
    
    if (process.env.NODE_ENV === 'development') {
      return `${randomResponse}\n\nHata detayı: ${error.message}`;
    }
    
    return randomResponse;
  }

  async generateResponse(sessionId, message, context, options = {}) {
    // Enhanced context building
    const enhancedContext = await this.buildEnhancedContext(sessionId, message, context, options);
    
    // Select best available provider
    const provider = this.selectProvider(options.preferredProvider);
    
    // Generate response using selected provider
    const response = await this.callAI(provider, enhancedContext.messages, options);
    
    // Process tool calls if any
    if (enhancedContext.shouldUseTool) {
      response.toolsUsed = await this.processToolCalls(message, { sessionId });
    }
    
    return {
      ...response,
      sessionId: sessionId,
      confidence: this.calculateConfidence(response, enhancedContext),
      reasoning: enhancedContext.reasoning
    };
  }

  async buildEnhancedContext(sessionId, message, context, options = {}) {
    const systemPrompt = this.buildSystemPrompt(sessionId, options);
    
    // Analyze message for tool usage
    const shouldUseTool = this.shouldUseTools(message);
    
    // Get conversation stats for context
    const conversationStats = await this.memoryManager.getConversationStats(sessionId);
    
    const messages = [
      { role: 'system', content: systemPrompt },
      ...context.map(msg => ({
        role: msg.role,
        content: msg.content,
        ...(msg.metadata && { metadata: msg.metadata })
      })),
      { role: 'user', content: message }
    ];

    return { 
      messages,
      shouldUseTool,
      conversationStats,
      reasoning: {
        contextLength: context.length,
        shouldUseTool: shouldUseTool,
        systemPromptLength: systemPrompt.length
      }
    };
  }

  buildSystemPrompt(sessionId, options = {}) {
    const basePrompt = `Sen gelişmiş bir AI asistanısın. Kullanıcılara yardımcı, bilgili ve samimi bir şekilde yanıt ver.

Mevcut yeteneklerin:
- Konuşma hafızası ve bağlam anlama
- Çeşitli araçları kullanabilme
- Çoklu AI sağlayıcı desteği
- Hata durumlarında kendi kendini düzeltme

İlkeler:
- Her zaman doğru ve güncel bilgi vermeye çalış
- Belirsiz durumlarda açık ol
- Kullanıcı deneyimini ön planda tut
- Türkçe konuşurken doğal ve akıcı ol`;

    if (options.customInstructions) {
      return `${basePrompt}\n\nEk talimatlar: ${options.customInstructions}`;
    }

    return basePrompt;
  }

  shouldUseTools(message) {
    const toolKeywords = [
      'hatırla', 'kaydet', 'sakla', 'memory', 'remember',
      'sistem', 'durum', 'istatistik', 'system', 'stats',
      'echo', 'test'
    ];
    
    return toolKeywords.some(keyword => 
      message.toLowerCase().includes(keyword.toLowerCase())
    );
  }

  async processToolCalls(message, context) {
    const toolsUsed = [];
    
    try {
      // Simple tool detection and execution
      if (message.toLowerCase().includes('echo')) {
        const result = await this.toolSystem.executeTool('echo', { message }, context);
        toolsUsed.push({ tool: 'echo', result });
      }
      
      if (message.toLowerCase().includes('sistem') || message.toLowerCase().includes('durum')) {
        const result = await this.toolSystem.executeTool('system_info', {}, context);
        toolsUsed.push({ tool: 'system_info', result });
      }
      
    } catch (error) {
      logger.error('Tool execution failed:', error);
      toolsUsed.push({ tool: 'error', error: error.message });
    }
    
    return toolsUsed;
  }

  selectProvider(preferredProvider = null) {
    const availableProviders = Object.keys(aiProviders).filter(p => aiProviders[p]);
    
    if (preferredProvider && availableProviders.includes(preferredProvider)) {
      return preferredProvider;
    }
    
    // Priority order based on performance and cost
    const priority = ['openai', 'deepseek', 'anthropic'];
    
    for (const provider of priority) {
      if (availableProviders.includes(provider)) {
        return provider;
      }
    }
    
    throw new Error('No AI providers available');
  }

  async callAI(provider, messages, options = {}) {
    const cacheKey = crypto
      .createHash('md5')
      .update(JSON.stringify({ provider, messages: messages.slice(-5), options }))
      .digest('hex');
    
    const cached = cache.get(cacheKey);
    if (cached && !options.bypassCache) {
      logger.info(`📋 Using cached response for ${provider}`);
      return { ...cached, fromCache: true };
    }

    let result;
    const startTime = Date.now();
    
    try {
      switch (provider) {
        case 'openai':
          result = await this.callOpenAI(messages, options);
          break;
        case 'deepseek':
          result = await this.callDeepSeek(messages, options);
          break;
        case 'anthropic':
          result = await this.callAnthropic(messages, options);
          break;
        default:
          throw new Error(`Unknown provider: ${provider}`);
      }
      
      result.processingTime = Date.now() - startTime;
      cache.set(cacheKey, result, options.cacheTime || 1800);
      
      return result;
      
    } catch (error) {
      logger.error(`Provider ${provider} failed:`, error);
      
      // Try fallback provider
      const availableProviders = Object.keys(aiProviders).filter(p => aiProviders[p] && p !== provider);
      if (availableProviders.length > 0) {
        logger.info(`🔄 Trying fallback provider: ${availableProviders[0]}`);
        return await this.callAI(availableProviders[0], messages, { ...options, bypassCache: true });
      }
      
      throw error;
    }
  }

  async callOpenAI(messages, options = {}) {
    if (!aiProviders.openai) throw new Error('OpenAI not configured');
    
    try {
      const response = await aiProviders.openai.chat.completions.create({
        model: options.model || 'gpt-4o-mini',
        messages,
        max_tokens: options.maxTokens || config.maxTokens,
        temperature: options.temperature || 0.7,
        presence_penalty: options.presencePenalty || 0,
        frequency_penalty: options.frequencyPenalty || 0
      });
      
      return {
        content: response.choices[0].message.content,
        usage: response.usage,
        model: response.model,
        provider: 'openai',
        finishReason: response.choices[0].finish_reason,
        metadata: {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens
        }
      };
    } catch (error) {
      if (error.status === 429) {
        throw new Error('OpenAI rate limit exceeded');
      }
      throw new Error(`OpenAI API error: ${error.message}`);
    }
  }

  async callDeepSeek(messages, options = {}) {
    if (!aiProviders.deepseek) throw new Error('DeepSeek not configured');
    
    try {
      const response = await axios.post(
        `${aiProviders.deepseek.baseURL}/chat/completions`,
        {
          model: options.model || 'deepseek-chat',
          messages,
          max_tokens: options.maxTokens || config.maxTokens,
          temperature: options.temperature || 0.7,
          stream: false
        },
        {
          headers: {
            'Authorization': `Bearer ${aiProviders.deepseek.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: aiProviders.deepseek.timeout
        }
      );
      
      return {
        content: response.data.choices[0].message.content,
        usage: response.data.usage,
        model: response.data.model,
        provider: 'deepseek',
        finishReason: response.data.choices[0].finish_reason,
        metadata: {
          promptTokens: response.data.usage?.prompt_tokens,
          completionTokens: response.data.usage?.completion_tokens,
          totalTokens: response.data.usage?.total_tokens
        }
      };
    } catch (error) {
      if (error.response?.status === 429) {
        throw new Error('DeepSeek rate limit exceeded');
      }
      throw new Error(`DeepSeek API error: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  async callAnthropic(messages, options = {}) {
    if (!aiProviders.anthropic) throw new Error('Anthropic not configured');
    
    try {
      const systemMessage = messages.find(m => m.role === 'system');
      const userMessages = messages.filter(m => m.role !== 'system');
      
      const response = await axios.post(
        `${aiProviders.anthropic.baseURL}/messages`,
        {
          model: options.model || 'claude-3-haiku-20240307',
          max_tokens: options.maxTokens || config.maxTokens,
          temperature: options.temperature || 0.7,
          system: systemMessage?.content || 'You are a helpful AI assistant.',
          messages: userMessages
        },
        {
          headers: {
            'x-api-key': aiProviders.anthropic.apiKey,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
          },
          timeout: aiProviders.anthropic.timeout
        }
      );
      
      return {
        content: response.data.content[0].text,
        usage: response.data.usage,
        model: response.data.model,
        provider: 'anthropic',
        finishReason: response.data.stop_reason,
        metadata: {
          inputTokens: response.data.usage?.input_tokens,
          outputTokens: response.data.usage?.output_tokens
        }
      };
    } catch (error) {
      if (error.response?.status === 429) {
        throw new Error('Anthropic rate limit exceeded');
      }
      throw new Error(`Anthropic API error: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  calculateConfidence(response, context) {
    let confidence = 0.8; // Base confidence
    
    // Adjust based on provider
    if (response.provider === 'openai') confidence += 0.1;
    if (response.provider === 'anthropic') confidence += 0.05;
    
    // Adjust based on context length
    if (context.conversationStats?.total_messages > 5) confidence += 0.05;
    
    // Adjust based on finish reason
    if (response.finishReason === 'stop') confidence += 0.05;
    if (response.finishReason === 'length') confidence -= 0.1;
    
    // Ensure confidence is between 0 and 1
    return Math.max(0, Math.min(1, confidence));
  }

  async healthCheck() {
    const now = Date.now();
    if (now - this.lastHealthCheck < 30000) { // 30 seconds
      return this.lastHealthCheckResult;
    }

    const healthStatus = {
      timestamp: new Date().toISOString(),
      uptime: now - this.startTime,
      database: dbConnected,
      providers: {},
      memory: process.memoryUsage(),
      performance: {
        requests: this.requestCount,
        errors: this.errorCount,
        errorRate: this.requestCount > 0 ? this.errorCount / this.requestCount : 0
      }
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
          healthStatus.providers[name] = 'error';
        }
      } else {
        healthStatus.providers[name] = 'not_configured';
      }
    }

    this.lastHealthCheck = now;
    this.lastHealthCheckResult = healthStatus;
    return healthStatus;
  }

  getStats() {
    const memoryStats = this.memoryManager.conversations.size;
    const toolStats = this.toolSystem.getToolStats();
    
    return {
      requests: this.requestCount,
      errors: this.errorCount,
      errorRate: this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
      uptime: Date.now() - this.startTime,
      activeConversations: memoryStats,
      capabilities: this.capabilities,
      providers: {
        available: Object.keys(aiProviders).filter(p => aiProviders[p]),
        configured: Object.keys(aiProviders).length
      },
      tools: {
        registered: this.toolSystem.tools.size,
        available: Array.from(this.toolSystem.tools.keys()),
        stats: toolStats
      },
      database: {
        connected: dbConnected,
        retryCount: dbRetryCount
      },
      memory: {
        conversations: memoryStats,
        cache: {
          keys: cache.keys().length,
          hits: cache.getStats().hits,
          misses: cache.getStats().misses
        }
      }
    };
  }
}

// Initialize enhanced system
const agiAgent = new EnhancedAGIAgent();
const app = express();
const server = createServer(app);

// Enhanced WebSocket support
const wss = new WebSocketServer({ 
  server,
  path: '/ws',
  perMessageDeflate: false
});

wss.on('connection', (ws, req) => {
  const sessionId = crypto.randomUUID();
  logger.info(`🔌 WebSocket connected: ${sessionId}`);
  
  ws.sessionId = sessionId;
  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'chat') {
        const response = await agiAgent.processMessage(sessionId, message.content, {
          userAgent: req.headers['user-agent'],
          ip: req.ip
        });
        
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
const wsInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(wsInterval);
});

// Enhanced middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({ 
  origin: process.env.ALLOWED_ORIGINS?.split(',') || true, 
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true, 
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

// Enhanced rate limiting
const requestCounts = new Map();
const rateLimit = (req, res, next) => {
  const clientId = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = process.env.NODE_ENV === 'production' ? 30 : 100;
  
  if (!requestCounts.has(clientId)) {
    requestCounts.set(clientId, []);
  }
  
  const requests = requestCounts.get(clientId);
  const recentRequests = requests.filter(time => now - time < windowMs);
  
  if (recentRequests.length >= maxRequests) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil(windowMs / 1000),
      limit: maxRequests,
      window: windowMs / 1000
    });
  }
  
  recentRequests.push(now);
  requestCounts.set(clientId, recentRequests);
  
  // Clean up old entries periodically
  if (Math.random() < 0.01) { // 1% chance
    const cutoff = now - windowMs * 2;
    for (const [id, times] of requestCounts.entries()) {
      const filtered = times.filter(time => time > cutoff);
      if (filtered.length === 0) {
        requestCounts.delete(id);
      } else {
        requestCounts.set(id, filtered);
      }
    }
  }
  
  next();
};

app.use('/api/', rateLimit);

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  
  next();
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'advanced_ai_agent_interface.html'));
});

// Stats page endpoint
app.get('/stats', async (req, res) => {
  try {
    const stats = agiAgent.getStats();
    
    res.send(`
      <!DOCTYPE html>
      <html lang="tr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>🤖 Enhanced AGI Agent - Stats</title>
        <style>
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
            color: white; 
            min-height: 100vh;
          }
          .container { max-width: 1200px; margin: 0 auto; }
          .header { text-align: center; margin-bottom: 40px; }
          .version { background: rgba(255,255,255,0.2); padding: 5px 15px; border-radius: 20px; display: inline-block; margin-top: 10px; }
          .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 30px; }
          .stat-card { background: rgba(255,255,255,0.1); padding: 20px; border-radius: 10px; backdrop-filter: blur(10px); }
          .stat-title { font-size: 18px; font-weight: bold; margin-bottom: 10px; }
          .stat-value { font-size: 24px; color: #ffd700; margin-bottom: 5px; }
          .stat-detail { font-size: 14px; opacity: 0.8; }
          .status-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
          .status-healthy { background: #4ade80; }
          .status-warning { background: #fbbf24; }
          .status-error { background: #ef4444; }
          .endpoints { margin-top: 30px; }
          .endpoint { background: rgba(255,255,255,0.1); margin: 10px 0; padding: 15px; border-radius: 5px; }
          .method { background: #28a745; color: white; padding: 2px 8px; border-radius: 3px; font-size: 12px; margin-right: 10px; }
          .method.get { background: #007bff; }
          .method.post { background: #28a745; }
          .method.ws { background: #6f42c1; }
          .features { margin-top: 30px; }
          .feature-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; }
          .feature { background: rgba(255,255,255,0.1); padding: 15px; border-radius: 8px; }
          .back-link { position: fixed; top: 20px; left: 20px; background: rgba(255,255,255,0.2); padding: 10px 20px; border-radius: 25px; text-decoration: none; color: white; backdrop-filter: blur(10px); }
        </style>
      </head>
      <body>
        <a href="/" class="back-link">← Chat Arayüzüne Dön</a>
        <div class="container">
          <div class="header">
            <h1>🤖 Enhanced AGI Agent - İstatistikler</h1>
            <p>Next-Generation AI Assistant with Advanced Capabilities</p>
            <div class="version">v2.0.0 - Production Ready</div>
          </div>
          
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-title">🚀 System Status</div>
              <div class="stat-value">
                <span class="status-indicator status-healthy"></span>Online
              </div>
              <div class="stat-detail">Database: ${dbConnected ? '🟢 Connected' : '🟡 Memory Only'}</div>
              <div class="stat-detail">Uptime: ${Math.floor(stats.uptime / 1000 / 60)} minutes</div>
              <div class="stat-detail">Error Rate: ${(stats.errorRate * 100).toFixed(1)}%</div>
            </div>
            
            <div class="stat-card">
              <div class="stat-title">📊 Performance</div>
              <div class="stat-value">${stats.requests.toLocaleString()}</div>
              <div class="stat-detail">Total Requests</div>
              <div class="stat-detail">Active Conversations: ${stats.activeConversations}</div>
              <div class="stat-detail">Cache Hit Rate: ${stats.memory.cache.hits > 0 ? ((stats.memory.cache.hits / (stats.memory.cache.hits + stats.memory.cache.misses)) * 100).toFixed(1) : 0}%</div>
            </div>
            
            <div class="stat-card">
              <div class="stat-title">🤖 AI Providers</div>
              <div class="stat-value">${stats.providers.available.length}/${stats.providers.configured}</div>
              <div class="stat-detail">Available Providers</div>
              <div class="stat-detail">${stats.providers.available.join(', ') || 'None configured'}</div>
            </div>
            
            <div class="stat-card">
              <div class="stat-title">🛠️ Tools & Features</div>
              <div class="stat-value">${stats.tools.registered}</div>
              <div class="stat-detail">Registered Tools</div>
              <div class="stat-detail">Memory: ${stats.capabilities.memory ? '✅' : '❌'}</div>
              <div class="stat-detail">Persistence: ${stats.capabilities.persistence ? '✅' : '❌'}</div>
            </div>
          </div>
          
          <div class="features">
            <h2>🌟 Key Features</h2>
            <div class="feature-list">
              <div class="feature">
                <strong>💾 Persistent Memory</strong><br>
                Konuşma geçmişi ve kullanıcı tercihleri kalıcı olarak saklanır
              </div>
              <div class="feature">
                <strong>🔧 Tool System</strong><br>
                Genişletilebilir araç sistemi ile gelişmiş fonksiyonalite
              </div>
              <div class="feature">
                <strong>🔄 Multi-Provider</strong><br>
                OpenAI, DeepSeek ve Anthropic desteği
              </div>
              <div class="feature">
                <strong>🌐 WebSocket Support</strong><br>
                Gerçek zamanlı iletişim ve canlı sohbet
              </div>
              <div class="feature">
                <strong>📈 Self-Monitoring</strong><br>
                Sistem kendini izler ve hataları otomatik düzeltir
              </div>
              <div class="feature">
                <strong>🚀 High Performance</strong><br>
                Gelişmiş önbellekleme ve optimizasyon
              </div>
            </div>
          </div>
          
          <div class="endpoints">
            <h2>🔗 API Endpoints</h2>
            <div class="endpoint">
              <span class="method post">POST</span>
              <strong>/api/chat</strong> - AI ile sohbet et
            </div>
            <div class="endpoint">
              <span class="method get">GET</span>
              <strong>/health</strong> - Sistem sağlık kontrolü
            </div>
            <div class="endpoint">
              <span class="method get">GET</span>
              <strong>/api/stats</strong> - Detaylı sistem istatistikleri
            </div>
            <div class="endpoint">
              <span class="method ws">WS</span>
              <strong>/ws</strong> - WebSocket bağlantısı
            </div>
            <div class="endpoint">
              <span class="method get">GET</span>
              <strong>/debug</strong> - Debug arayüzü
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    logger.error('Stats page error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/health', async (req, res) => {
  try {
    const healthCheck = await agiAgent.healthCheck();
    const status = healthCheck.database && healthCheck.providers.openai !== 'error' ? 'healthy' : 'degraded';
    
    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      service: 'enhanced-agi-agent',
      version: '2.0.0',
      ...healthCheck
    });
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Enhanced chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, options = {} } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Valid message string is required',
        code: 'INVALID_MESSAGE'
      });
    }

    if (message.length > 10000) {
      return res.status(400).json({
        error: 'Message too long. Maximum 10,000 characters allowed.',
        code: 'MESSAGE_TOO_LONG'
      });
    }
    
    const sessionId = req.session.id || crypto.randomUUID();
    if (!req.session.id) req.session.id = sessionId;
    
    // Process message with enhanced options
    const response = await agiAgent.processMessage(sessionId, message, {
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
      toolsUsed: response.toolsUsed,
      fromCache: response.fromCache || false,
      metadata: response.metadata
    });
    
  } catch (error) {
    logger.error('Chat API error:', error);
    res.status(500).json({ 
      error: 'Chat processing failed',
      code: 'PROCESSING_ERROR',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const healthCheck = await agiAgent.healthCheck();
    
    if (!healthCheck) {
      throw new Error('Health check returned undefined');
    }
    
    const status = healthCheck.database && 
                  healthCheck.providers && 
                  Object.values(healthCheck.providers).some(p => p === 'healthy' || p === 'configured') 
                  ? 'healthy' : 'degraded';
    
    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      service: 'enhanced-agi-agent',
      version: '2.0.0',
      ...healthCheck
    });
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
      database: dbConnected,
      providers: Object.keys(aiProviders).filter(p => aiProviders[p])
    });
  }
});

// Enhanced stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const stats = agiAgent.getStats();
    const healthCheck = await agiAgent.healthCheck();
    
    res.json({
      ...stats,
      health: healthCheck,
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        env: process.env.NODE_ENV || 'development'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Stats API error:', error);
    res.status(500).json({ 
      error: 'Stats retrieval failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Debug endpoint
app.get('/debug', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Debug endpoint not available in production' });
  }
  
  res.sendFile(join(__dirname, 'advanced_ai_agent_interface.html'));
});

// Conversation stats endpoint
app.get('/api/conversation/:sessionId/stats', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const stats = await agiAgent.memoryManager.getConversationStats(sessionId);
    
    if (!stats) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    res.json({
      sessionId,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Conversation stats error:', error);
    res.status(500).json({ error: 'Failed to get conversation stats' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled request error:', error);
  
  res.status(error.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
    timestamp: new Date().toISOString(),
    requestId: crypto.randomUUID().substring(0, 8)
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
    availableEndpoints: [
      'GET /',
      'GET /health',
      'POST /api/chat',
      'GET /api/stats',
      'WS /ws'
    ]
  });
});

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  
  try {
    // Close WebSocket server
    wss.close(() => {
      logger.info('WebSocket server closed');
    });
    
    // Close HTTP server
    server.close(() => {
      logger.info('HTTP server closed');
    });
    
    // Close database pool
    if (pool) {
      await pool.end();
      logger.info('Database pool closed');
    }
    
    // Close cache
    cache.close();
    longTermCache.close();
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
    
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();
    
    // Create necessary directories
    try {
      await fs.mkdir('logs', { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
    
    // Start HTTP server
    server.listen(config.port, config.host, () => {
      logger.info(`🚀 Enhanced AGI Agent v2.0 running on http://${config.host}:${config.port}`);
      logger.info(`💾 Database: ${dbConnected ? '✅ Connected' : '🟡 Memory Only'}`);
      logger.info(`🤖 AI Providers: ${Object.keys(aiProviders).filter(p => aiProviders[p]).join(', ') || 'None configured'}`);
      logger.info(`🛠️  Tools: ${agiAgent.toolSystem.tools.size} registered`);
      logger.info(`🌐 WebSocket: ✅ Enabled`);
      logger.info(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`📊 Features: Memory=${agiAgent.capabilities.memory}, Tools=${agiAgent.capabilities.tools}, Persistence=${agiAgent.capabilities.persistence}`);
    });
    
    logger.info('🎉 Enhanced AGI Agent started successfully!');
    
  } catch (error) {
    logger.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

// Export for testing
export default app;
export { agiAgent, config };

// Start the server
startServer();
