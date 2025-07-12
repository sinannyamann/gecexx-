import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import pkg from 'pg';
const { Pool } = pkg;
import OpenAI from 'openai';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import winston from 'winston';
import NodeCache from 'node-cache';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import multer from 'multer';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import crypto from 'crypto';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Railway-optimized configuration
const config = {
  port: process.env.PORT || 3000,
  host: '0.0.0.0',
  cacheTTL: 1800,
  maxConversations: 10000,
  maxMessagesPerConversation: 50,
  dbMaxConnections: 20,
  rateLimitMax: 1000,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
  maxTokens: 4000,
  defaultModel: 'gpt-4o-mini'
};

// Enhanced Logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  defaultMeta: { service: 'agi-agent' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Enhanced Cache
const cache = new NodeCache({ 
  stdTTL: config.cacheTTL, 
  checkperiod: 120, 
  useClones: false,
  maxKeys: 50000
});

// Database connection
let pool = null;
let dbConnected = false;

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    logger.warn('💾 Database: Not configured - using in-memory storage');
    return false;
  }

  const maxRetries = 5;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: config.dbMaxConnections,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });

      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();

      // Create tables
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          sid VARCHAR NOT NULL COLLATE "default",
          sess JSON NOT NULL,
          expire TIMESTAMP(6) NOT NULL,
          PRIMARY KEY (sid)
        );
        CREATE INDEX IF NOT EXISTS IDX_session_expire ON user_sessions(expire);
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_logs (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          response TEXT NOT NULL,
          provider VARCHAR(50),
          model VARCHAR(100),
          tone VARCHAR(50),
          tokens_used INTEGER DEFAULT 0,
          response_time INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS IDX_chat_session_created ON chat_logs(session_id, created_at);
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS feedback (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(255),
          message_id INTEGER REFERENCES chat_logs(id),
          rating INTEGER CHECK (rating >= 1 AND rating <= 5),
          comment TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS IDX_feedback_rating ON feedback(rating);
      `);

      logger.info('💾 Database initialized successfully');
      dbConnected = true;
      return true;
    } catch (error) {
      retryCount++;
      logger.error(`Database initialization failed (attempt ${retryCount}/${maxRetries})`, { 
        error: error.message 
      });
      
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
      }
    }
  }
  
  logger.error('Failed to initialize database after maximum retries');
  return false;
}

// AI Providers
const aiProviders = {
  openai: process.env.OPENAI_API_KEY ? new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,
    maxRetries: 3
  }) : null,
  
  deepseek: process.env.DEEPSEEK_API_KEY ? {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1'
  } : null,
  
  anthropic: process.env.ANTHROPIC_API_KEY ? {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.anthropic.com/v1'
  } : null,
  
  groq: process.env.GROQ_API_KEY ? {
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
  } : null
};

// Enhanced Memory Manager
class EnhancedMemoryManager {
  constructor() {
    this.conversations = new Map();
    this.episodicMemory = new Map();
    this.semanticMemory = new Map();
    this.workingMemory = new Map();
    this.maxConversations = config.maxConversations;
    this.maxMessagesPerConversation = config.maxMessagesPerConversation;
  }

  addMessage(sessionId, message) {
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, []);
    }
    
    const conversation = this.conversations.get(sessionId);
    const enhancedMessage = {
      ...message,
      timestamp: new Date().toISOString(),
      id: crypto.randomUUID(),
      importance: this.calculateImportance(message)
    };
    
    conversation.push(enhancedMessage);
    
    if (conversation.length > this.maxMessagesPerConversation) {
      const removed = conversation.splice(0, conversation.length - this.maxMessagesPerConversation);
      this.archiveToEpisodicMemory(sessionId, removed);
    }
    
    if (this.conversations.size > this.maxConversations) {
      const oldestKey = this.conversations.keys().next().value;
      this.conversations.delete(oldestKey);
    }
  }

  calculateImportance(message) {
    const content = message.content?.toLowerCase() || '';
    let score = 0.5;
    
    if (content.includes('?')) score += 0.2;
    
    const emotionalWords = ['love', 'hate', 'amazing', 'terrible', 'excited', 'worried'];
    if (emotionalWords.some(word => content.includes(word))) score += 0.3;
    
    const technicalWords = ['code', 'algorithm', 'function', 'api', 'database'];
    if (technicalWords.some(word => content.includes(word))) score += 0.2;
    
    return Math.min(1.0, score);
  }

  archiveToEpisodicMemory(sessionId, messages) {
    if (!this.episodicMemory.has(sessionId)) {
      this.episodicMemory.set(sessionId, []);
    }
    
    const episodic = this.episodicMemory.get(sessionId);
    episodic.push(...messages.filter(msg => msg.importance > 0.7));
    this.episodicMemory.set(sessionId, episodic.slice(-100));
  }

  getRelevantMemory(sessionId, query) {
    return {
      recent: this.conversations.get(sessionId) || [],
      episodic: this.episodicMemory.get(sessionId) || [],
      working: this.workingMemory.get(sessionId) || {}
    };
  }

  getConversation(sessionId) {
    return this.conversations.get(sessionId) || [];
  }

  clearConversation(sessionId) {
    this.conversations.delete(sessionId);
    this.episodicMemory.delete(sessionId);
    this.workingMemory.delete(sessionId);
  }

  getStats() {
    return {
      totalConversations: this.conversations.size,
      totalMessages: Array.from(this.conversations.values()).reduce((sum, conv) => sum + conv.length, 0),
      episodicMemorySize: this.episodicMemory.size
    };
  }
}

// AGI Agent Class
class AGIAgent {
  constructor() {
    this.memoryManager = new EnhancedMemoryManager();
    this.requestCount = 0;
    this.errorCount = 0;
    this.successCount = 0;
    this.startTime = Date.now();
    this.skills = new Map();
    
    this.providerWeights = {
      openai: 1.0,
      deepseek: 0.8,
      anthropic: 0.9,
      groq: 0.7
    };
    
    this.providerPerformance = {
      openai: { successes: 0, failures: 0, avgResponseTime: 0 },
      deepseek: { successes: 0, failures: 0, avgResponseTime: 0 },
      anthropic: { successes: 0, failures: 0, avgResponseTime: 0 },
      groq: { successes: 0, failures: 0, avgResponseTime: 0 }
    };
    
    this.initializeSkills();
  }

  initializeSkills() {
    this.registerSkill('code_generation', this.generateCode.bind(this));
    this.registerSkill('data_analysis', this.analyzeData.bind(this));
    this.registerSkill('problem_solving', this.solveProblem.bind(this));
    this.registerSkill('creative_writing', this.createContent.bind(this));
    this.registerSkill('research', this.conductResearch.bind(this));
    this.registerSkill('math_calculation', this.calculateMath.bind(this));
    this.registerSkill('translation', this.translateText.bind(this));
    this.registerSkill('summarization', this.summarizeText.bind(this));
  }

  registerSkill(name, skillFunction) {
    this.skills.set(name, {
      function: skillFunction,
      usageCount: 0,
      successRate: 0,
      lastUsed: null
    });
  }

  async identifyRequiredSkills(message) {
    const content = message.toLowerCase();
    const requiredSkills = [];
    
    const skillPatterns = {
      code_generation: /(?:write|create|generate|code|program|function|script|algorithm)/,
      data_analysis: /(?:analyze|data|chart|graph|statistics|trend)/,
      problem_solving: /(?:solve|problem|issue|debug|fix|troubleshoot)/,
      creative_writing: /(?:write|story|poem|creative|narrative|fiction)/,
      research: /(?:research|find|search|information|learn about)/,
      math_calculation: /(?:calculate|math|equation|formula|solve)/,
      translation: /(?:translate|translation|language)/,
      summarization: /(?:summarize|summary|brief|overview)/
    };
    
    for (const [skill, pattern] of Object.entries(skillPatterns)) {
      if (pattern.test(content)) {
        requiredSkills.push(skill);
      }
    }
    
    return requiredSkills.length > 0 ? requiredSkills : ['general_conversation'];
  }

  async executeSkill(skillName, context) {
    const skill = this.skills.get(skillName);
    if (!skill) {
      throw new Error(`Skill '${skillName}' not found`);
    }
    
    const startTime = Date.now();
    
    try {
      const result = await skill.function(context);
      const executionTime = Date.now() - startTime;
      
      skill.usageCount++;
      skill.lastUsed = new Date();
      skill.successRate = ((skill.successRate * (skill.usageCount - 1)) + 1) / skill.usageCount;
      
      return {
        success: true,
        result,
        executionTime,
        skill: skillName
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      skill.usageCount++;
      skill.successRate = (skill.successRate * (skill.usageCount - 1)) / skill.usageCount;
      
      return {
        success: false,
        error: error.message,
        executionTime,
        skill: skillName
      };
    }
  }

  // Skill implementations
  async generateCode(context) {
    const { message, requirements } = context;
    const prompt = `Generate clean, production-ready code for: ${message}\n\nRequirements: ${requirements || 'None specified'}`;
    
    return await this.callAI(['openai', 'deepseek'], [
      { role: 'system', content: 'You are an expert programmer. Generate clean, well-documented, production-ready code.' },
      { role: 'user', content: prompt }
    ]);
  }

  async analyzeData(context) {
    const { data, analysisType } = context;
    const prompt = `Analyze the following data and provide insights:\n\nData: ${JSON.stringify(data)}\nAnalysis Type: ${analysisType}`;
    
    return await this.callAI(['openai', 'anthropic'], [
      { role: 'system', content: 'You are a data scientist. Provide detailed analysis with actionable insights.' },
      { role: 'user', content: prompt }
    ]);
  }

  async solveProblem(context) {
    const { problem, constraints } = context;
    const prompt = `Solve this problem step by step:\n\nProblem: ${problem}\nConstraints: ${constraints || 'None specified'}`;
    
    return await this.callAI(['openai', 'anthropic'], [
      { role: 'system', content: 'You are a problem-solving expert. Break down complex problems into manageable steps.' },
      { role: 'user', content: prompt }
    ]);
  }

  async createContent(context) {
    const { type, topic, style } = context;
    const prompt = `Create ${type} content about: ${topic}\nStyle: ${style || 'engaging and informative'}`;
    
    return await this.callAI(['openai', 'anthropic'], [
      { role: 'system', content: 'You are a creative writer. Create engaging, original content.' },
      { role: 'user', content: prompt }
    ]);
  }

  async conductResearch(context) {
    const { topic, depth } = context;
    const prompt = `Research and provide comprehensive information about: ${topic}\nDepth: ${depth || 'moderate'}`;
    
    return await this.callAI(['openai', 'anthropic'], [
      { role: 'system', content: 'You are a research assistant. Provide accurate, well-sourced information.' },
      { role: 'user', content: prompt }
    ]);
  }

  async calculateMath(context) {
    const { expression, showSteps } = context;
    const prompt = `Calculate: ${expression}\n${showSteps ? 'Show all steps' : 'Provide the result'}`;
    
    return await this.callAI(['openai'], [
      { role: 'system', content: 'You are a mathematics expert. Provide accurate calculations with clear explanations.' },
      { role: 'user', content: prompt }
    ]);
  }

  async translateText(context) {
    const { text, fromLang, toLang } = context;
    const prompt = `Translate the following text from ${fromLang} to ${toLang}:\n\n${text}`;
    
    return await this.callAI(['openai', 'deepseek'], [
      { role: 'system', content: 'You are a professional translator. Provide accurate, contextual translations.' },
      { role: 'user', content: prompt }
    ]);
  }

  async summarizeText(context) {
    const { text, length } = context;
    const prompt = `Summarize the following text in ${length || 'moderate'} length:\n\n${text}`;
    
    return await this.callAI(['openai', 'anthropic'], [
      { role: 'system', content: 'You are a summarization expert. Create concise, informative summaries.' },
      { role: 'user', content: prompt }
    ]);
  }

  async callAI(providers, messages, options = {}) {
    const providerList = Array.isArray(providers) ? providers : [providers];
    
    const availableProviders = providerList.filter(p => {
      if (p === 'openai') return aiProviders.openai;
      if (p === 'deepseek') return aiProviders.deepseek;
      if (p === 'anthropic') return aiProviders.anthropic;
      if (p === 'groq') return aiProviders.groq;
      return false;
    });

    if (availableProviders.length === 0) {
      throw new Error('No AI providers available');
    }

    const sortedProviders = availableProviders.sort((a, b) => {
      return this.providerWeights[b] - this.providerWeights[a];
    });

    const cacheKey = `ai_${crypto.createHash('md5').update(JSON.stringify({ messages, options })).digest('hex')}`;
    
    if (!options.skipCache) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    let lastError;
    
    for (const provider of sortedProviders) {
      const startTime = Date.now();
      
      try {
        let result;
        
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
          case 'groq':
            result = await this.callGroq(messages, options);
            break;
          default:
            throw new Error(`Unknown provider: ${provider}`);
        }
        
        const responseTime = Date.now() - startTime;
        
        this.updateProviderPerformance(provider, true, responseTime);
        cache.set(cacheKey, result, options.cacheTTL || config.cacheTTL);
        
        this.requestCount++;
        this.successCount++;
        
        return result;
        
      } catch (error) {
        const responseTime = Date.now() - startTime;
        this.updateProviderPerformance(provider, false, responseTime);
        lastError = error;
        this.errorCount++;
        
        logger.warn(`Provider ${provider} failed, trying next...`, {
          error: error.message,
          responseTime
        });
      }
    }
    
    throw lastError || new Error('All providers failed');
  }

  updateProviderPerformance(provider, success, responseTime) {
    if (!this.providerPerformance[provider]) {
      this.providerPerformance[provider] = { successes: 0, failures: 0, avgResponseTime: 0 };
    }
    
    const perf = this.providerPerformance[provider];
    
    if (success) {
      perf.successes++;
      perf.avgResponseTime = ((perf.avgResponseTime * (perf.successes - 1)) + responseTime) / perf.successes;
      this.providerWeights[provider] = Math.min(2.0, this.providerWeights[provider] + 0.05);
    } else {
      perf.failures++;
      this.providerWeights[provider] = Math.max(0.1, this.providerWeights[provider] - 0.1);
    }
  }

  async callOpenAI(messages, options = {}) {
    if (!aiProviders.openai) {
      throw new Error('OpenAI not configured');
    }
    
    const response = await aiProviders.openai.chat.completions.create({
      model: options.model || config.defaultModel,
      messages,
      max_tokens: options.maxTokens || config.maxTokens,
      temperature: options.temperature || 0.7,
      stream: options.stream || false
    });
    
    return {
      content: response.choices[0].message.content,
      usage: response.usage,
      model: response.model,
      provider: 'openai'
    };
  }

  async callDeepSeek(messages, options = {}) {
    if (!aiProviders.deepseek) {
      throw new Error('DeepSeek not configured');
    }
    
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
        timeout: 60000
      }
    );
    
    return {
      content: response.data.choices[0].message.content,
      usage: response.data.usage,
      model: response.data.model,
      provider: 'deepseek'
    };
  }

  async callAnthropic(messages, options = {}) {
    if (!aiProviders.anthropic) {
      throw new Error('Anthropic not configured');
    }
    
    const systemMessage = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');
    
    const response = await axios.post(
      `${aiProviders.anthropic.baseURL}/messages`,
      {
        model: options.model || 'claude-3-sonnet-20240229',
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
        timeout: 60000
      }
    );
    
    return {
      content: response.data.content[0].text,
      usage: response.data.usage,
      model: response.data.model,
      provider: 'anthropic'
    };
  }

  async callGroq(messages, options = {}) {
    if (!aiProviders.groq) {
      throw new Error('Groq not configured');
    }
    
    const response = await axios.post(
      `${aiProviders.groq.baseURL}/chat/completions`,
      {
        model: options.model || 'mixtral-8x7b-32768',
        messages,
        max_tokens: options.maxTokens || config.maxTokens,
        temperature: options.temperature || 0.7,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${aiProviders.groq.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    
    return {
      content: response.data.choices[0].message.content,
      usage: response.data.usage,
      model: response.data.model,
      provider: 'groq'
    };
  }

  async analyzeSentiment(text) {
    try {
      if (aiProviders.openai) {
        const response = await aiProviders.openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'Analyze sentiment. Respond with JSON: {"label": "positive|negative|neutral", "score": 0.0-1.0}'
            },
            { role: 'user', content: text }
          ],
          max_tokens: 100,
          temperature: 0.1
        });
        
        const result = JSON.parse(response.choices[0].message.content);
        return { ...result, source: 'api' };
      }
    } catch (error) {
      logger.warn('Sentiment analysis failed', { error: error.message });
    }
    
    return { label: 'neutral', score: 0.5, source: 'fallback' };
  }

  async processMessage(sessionId, message, options = {}) {
    const startTime = Date.now();
    
    try {
      const memory = this.memoryManager.getRelevantMemory(sessionId, message);
      const sentiment = await this.analyzeSentiment(message);
      const requiredSkills = await this.identifyRequiredSkills(message);
      
      const context = {
        message,
        sessionId,
        memory,
        sentiment,
        requiredSkills,
        options
      };
      
      let response;
      if (requiredSkills.length === 1 && requiredSkills[0] !== 'general_conversation') {
        const skillResult = await this.executeSkill(requiredSkills[0], context);
        response = skillResult.success ? skillResult.result : await this.handleGeneralConversation(context);
      } else {
        response = await this.handleGeneralConversation(context);
      }
      
      this.memoryManager.addMessage(sessionId, { role: 'user', content: message });
      this.memoryManager.addMessage(sessionId, { 
        role: 'assistant', 
        content: response.content,
        provider: response.provider,
        model: response.model,
        sentiment,
        skills: requiredSkills,
        processingTime: Date.now() - startTime
      });
      
      return {
        ...response,
        sentiment,
        skills: requiredSkills,
        processingTime: Date.now() - startTime
      };
      
    } catch (error) {
      logger.error('Message processing failed', { 
        error: error.message, 
        sessionId, 
        message: message.substring(0, 100) 
      });
      
      return {
        content: "I apologize, but I encountered an error processing your request. Please try again.",
        provider: 'fallback',
        model: 'error-handler',
        error: error.message
      };
    }
  }

  async handleGeneralConversation(context) {
    const { message, memory, sentiment } = context;
    
    const conversationHistory = [
      {
        role: 'system',
        content: `You are an advanced AGI assistant with multiple capabilities:
        - Deep understanding and reasoning
        - Creative problem solving
        - Technical expertise across domains
        - Emotional intelligence and empathy
        
        Current context:
        - Sentiment: ${sentiment.label} (${sentiment.score})
        
        Respond helpfully and engagingly.`
      }
    ];
    
    if (memory.recent.length > 0) {
      conversationHistory.push(...memory.recent.slice(-5));
    }
    
    conversationHistory.push({ role: 'user', content: message });
    
    const providers = ['openai', 'anthropic', 'deepseek'];
    
    return await this.callAI(providers, conversationHistory, {
      temperature: sentiment.label === 'positive' ? 0.8 : 0.7,
      maxTokens: config.maxTokens
    });
  }

  async processFeedback(sessionId, messageId, rating, comment) {
    if (!pool || !dbConnected) {
      logger.warn('Database not available for feedback processing');
      return;
    }

    try {
      const messageQuery = 'SELECT provider, model FROM chat_logs WHERE id = $1';
      const messageResult = await pool.query(messageQuery, [messageId]);
      
      if (messageResult.rowCount === 0) {
        logger.warn('Message not found for feedback', { messageId });
        return;
      }
      
      const { provider, model } = messageResult.rows[0];
      
      await pool.query(
        'INSERT INTO feedback (session_id, message_id, rating, comment) VALUES ($1, $2, $3, $4)',
        [sessionId, messageId, rating, comment]
      );
      
      if (rating >= 4) {
        this.providerWeights[provider] = Math.min(2.0, this.providerWeights[provider] + 0.1);
      } else if (rating <= 2) {
        this.providerWeights[provider] = Math.max(0.1, this.providerWeights[provider] - 0.2);
      }
      
      logger.info('Feedback processed successfully', { 
        sessionId, messageId, rating, provider 
      });
      
    } catch (error) {
      logger.error('Feedback processing failed', { 
        error: error.message, 
        sessionId, 
        messageId 
      });
    }
  }

  getDetailedStats() {
    return {
      requests: {
        total: this.requestCount,
        successful: this.successCount,
        failed: this.errorCount,
        successRate: this.requestCount > 0 ? (this.successCount / this.requestCount) * 100 : 0
      },
      uptime: {
        milliseconds: Date.now() - this.startTime,
        hours: Math.floor((Date.now() - this.startTime) / (1000 * 60 * 60)),
        days: Math.floor((Date.now() - this.startTime) / (1000 * 60 * 60 * 24))
      },
      memory: this.memoryManager.getStats(),
      cache: cache.getStats(),
      providers: {
        weights: this.providerWeights,
        performance: this.providerPerformance
      },
      skills: Object.fromEntries(
        Array.from(this.skills.entries()).map(([name, skill]) => [
          name,
          {
            usageCount: skill.usageCount,
            successRate: skill.successRate,
            lastUsed: skill.lastUsed
          }
        ])
      )
    };
  }
}

// Initialize AGI Agent
const agiAgent = new AGIAgent();

// Express Application Setup
const app = express();
const server = createServer(app);

// Session configuration
const sessionConfig = {
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
};

async function setupSessionStore() {
  if (pool && dbConnected) {
    const PgSession = connectPgSimple(session);
    sessionConfig.store = new PgSession({ 
      pool, 
      tableName: 'user_sessions',
      createTableIfMissing: true
    });
    logger.info('💾 Session store configured with PostgreSQL');
  } else {
    logger.warn('💾 Using memory session store');
  }
}

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AGI Agent API',
      version: '2.0.0',
      description: 'Advanced AGI Agent with multi-modal capabilities and learning'
    },
    servers: [
      {
        url: process.env.NODE_ENV === 'production' 
          ? 'https://your-app.railway.app' 
          : `http://localhost:${config.port}`,
        description: process.env.NODE_ENV === 'production' ? 'Production' : 'Development'
      }
    ]
  },
  apis: ['./index.js']
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Middleware setup
app.set('trust proxy', 1);
app.use(session(sessionConfig));
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimitMax,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.path === '/health' || req.path === '/';
  }
}));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    
    if (config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Simple file upload (without sharp/mammoth)
const upload = multer({
  dest: 'uploads/',
  limits: { 
    fileSize: config.maxFileSize,
    files: 5
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'text/plain', 'text/csv',
      'application/json'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  }
});

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// API Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Main route - serve the HTML interface
app.get('/', (req, res) => {
  const htmlPath = join(__dirname, 'advanced_ai_agent_interface.html');
  
  fs.readFile(htmlPath, 'utf8')
    .then(html => {
      res.send(html);
    })
    .catch(() => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>AGI Agent</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            .container { max-width: 600px; margin: 0 auto; }
            .status { color: green; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🤖 Advanced AGI Agent</h1>
            <p class="status">✅ Server is running successfully!</p>
            <p>To use the full interface, place <code>advanced_ai_agent_interface.html</code> in the same directory as <code>index.js</code></p>
            <h3>Available Endpoints:</h3>
            <ul style="text-align: left;">
              <li><strong>POST /api/chat</strong> - Chat with the AGI agent</li>
              <li><strong>POST /api/feedback</strong> - Submit feedback</li>
              <li><strong>POST /api/upload</strong> - Upload files</li>
              <li><strong>GET /api/stats</strong> - Get system statistics</li>
              <li><strong>GET /api-docs</strong> - API documentation</li>
              <li><strong>WebSocket /ws</strong> - Real-time communication</li>
            </ul>
            <p><strong>Database:</strong> ${dbConnected ? 'Connected ✅' : 'Disconnected ❌'}</p>
            <p><strong>Available Providers:</strong> ${Object.keys(aiProviders).filter(p => aiProviders[p]).join(', ')}</p>
          </div>
        </body>
        </html>
      `);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'agi-agent',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    database: dbConnected ? 'connected' : 'disconnected',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, provider = 'auto', options = {} } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ 
        error: 'Message is required and must be a string' 
      });
    }
    
    if (message.length > 10000) {
      return res.status(400).json({ 
        error: 'Message too long (max 10000 characters)' 
      });
    }
    
    const sessionId = req.session.id || crypto.randomUUID();
    if (!req.session.id) {
      req.session.id = sessionId;
    }
    
    const response = await agiAgent.processMessage(sessionId, message, { 
      provider, 
      ...options 
    });
    
    if (pool && dbConnected) {
      try {
        const logResult = await pool.query(
          `INSERT INTO chat_logs (session_id, message, response, provider, model, tone, tokens_used, response_time) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            sessionId,
            message,
            response.content,
            response.provider,
            response.model,
            response.sentiment?.label || 'neutral',
            response.usage?.total_tokens || 0,
            response.processingTime || 0
          ]
        );
        
        response.messageId = logResult.rows[0].id;
      } catch (dbError) {
        logger.warn('Failed to log chat to database', { 
          error: dbError.message,
          sessionId 
        });
      }
    }
    
    res.json({
      response: response.content,
      provider: response.provider,
      model: response.model,
      sentiment: response.sentiment,
      skills: response.skills,
      processingTime: response.processingTime,
      usage: response.usage,
      messageId: response.messageId || null
    });
    
  } catch (error) {
    logger.error('Chat API error', { 
      error: error.message,
      stack: error.stack,
      body: req.body
    });
    
    res.status(500).json({
      error: 'An error occurred while processing your request',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Feedback endpoint
app.post('/api/feedback', async (req, res) => {
  try {
    const { messageId, rating, comment } = req.body;
    const sessionId = req.session.id;
    
    if (!messageId || !rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ 
        error: 'Valid messageId and rating (1-5) are required' 
      });
    }
    
    await agiAgent.processFeedback(sessionId, messageId, rating, comment);
    
    res.json({ 
      success: true,
      message: 'Feedback submitted successfully'
    });
    
  } catch (error) {
    logger.error('Feedback API error', { 
      error: error.message,
      body: req.body
    });
    
    res.status(500).json({ 
      error: 'Failed to submit feedback',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Simple file upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No file uploaded' 
      });
    }
    
    const fileInfo = {
      id: crypto.randomUUID(),
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      uploadTime: new Date().toISOString()
    };
    
    let processedContent = '';
    
    try {
      if (req.file.mimetype === 'text/plain') {
        processedContent = await fs.readFile(req.file.path, 'utf8');
      } else if (req.file.mimetype === 'application/json') {
        const jsonContent = await fs.readFile(req.file.path, 'utf8');
        const parsed = JSON.parse(jsonContent);
        processedContent = JSON.stringify(parsed, null, 2);
      } else {
        processedContent = `File uploaded: ${req.file.originalname} (${req.file.mimetype})`;
      }
    } catch (processError) {
      processedContent = `File uploaded but processing failed: ${processError.message}`;
      logger.warn('File processing failed', { 
        error: processError.message,
        fileInfo 
      });
    }
    
    res.json({
      success: true,
      file: fileInfo,
      content: processedContent.substring(0, 5000)
    });
    
  } catch (error) {
    logger.error('File upload error', { 
      error: error.message,
      fileInfo: req.file ? {
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      } : null
    });
    
    res.status(500).json({ 
      error: 'File upload failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Statistics endpoint
app.get('/api/stats', (req, res) => {
  try {
    const stats = agiAgent.getDetailedStats();
    
    stats.system = {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
    
    res.json(stats);
  } catch (error) {
    logger.error('Stats API error', { error: error.message });
    res.status(500).json({ 
      error: 'Failed to retrieve statistics' 
    });
  }
});

// WebSocket for real-time communication
const wss = new WebSocketServer({ 
  server, 
  path: '/ws',
  clientTracking: true
});

const activeConnections = new Map();

wss.on('connection', (ws, req) => {
  const sessionId = crypto.randomUUID();
  const connectionInfo = {
    sessionId,
    connectedAt: new Date(),
    lastActivity: new Date(),
    messageCount: 0
  };
  
  activeConnections.set(sessionId, { ws, info: connectionInfo });
  
  logger.info('WebSocket connection established', { 
    sessionId,
    totalConnections: activeConnections.size
  });

  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to AGI Agent',
    sessionId,
    capabilities: Array.from(agiAgent.skills.keys()),
    timestamp: new Date().toISOString()
  }));

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
      
      const lastActivity = connectionInfo.lastActivity;
      const inactiveTime = Date.now() - lastActivity.getTime();
      
      if (inactiveTime > 300000) {
        logger.info('Closing inactive WebSocket connection', { sessionId });
        ws.close();
      }
    }
  }, 30000);

  ws.on('message', async (data) => {
    try {
      connectionInfo.lastActivity = new Date();
      connectionInfo.messageCount++;
      
      const message = JSON.parse(data.toString());
      
      if (message.type === 'chat') {
        ws.send(JSON.stringify({
          type: 'typing',
          isTyping: true,
          timestamp: new Date().toISOString()
        }));

        const response = await agiAgent.processMessage(
          sessionId, 
          message.content, 
          message.options || {}
        );

        ws.send(JSON.stringify({
          type: 'chat_response',
          content: response.content,
          provider: response.provider,
          model: response.model,
          sentiment: response.sentiment,
          skills: response.skills,
          processingTime: response.processingTime,
          usage: response.usage,
          timestamp: new Date().toISOString()
        }));

        ws.send(JSON.stringify({
          type: 'typing',
          isTyping: false,
          timestamp: new Date().toISOString()
        }));
      }
      
      if (message.type === 'ping') {
        ws.send(JSON.stringify({
          type: 'pong',
          timestamp: new Date().toISOString()
        }));
      }
      
    } catch (error) {
      logger.error('WebSocket message processing error', { 
        sessionId,
        error: error.message
      });
      
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Message processing failed',
        timestamp: new Date().toISOString()
      }));
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    activeConnections.delete(sessionId);
    
    logger.info('WebSocket connection closed', { 
      sessionId,
      totalConnections: activeConnections.size
    });
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error', { 
      sessionId, 
      error: error.message 
    });
  });

  ws.on('pong', () => {
    connectionInfo.lastActivity = new Date();
  });
});

// Cleanup and maintenance
cron.schedule('0 3 * * *', async () => {
  logger.info('Starting daily cleanup...');
  
  try {
    const uploadsDir = 'uploads';
    const files = await fs.readdir(uploadsDir).catch(() => []);
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    
    let cleanedFiles = 0;
    for (const file of files) {
      try {
        const filePath = join(uploadsDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtimeMs < oneDayAgo) {
          await fs.unlink(filePath);
          cleanedFiles++;
        }
      } catch (error) {
        logger.warn('Failed to clean file', { file, error: error.message });
      }
    }
    
    logger.info('File cleanup completed', { cleanedFiles });
    
    if (pool && dbConnected) {
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        
        const chatCleanup = await pool.query(
          'DELETE FROM chat_logs WHERE created_at < $1',
          [thirtyDaysAgo]
        );
        
        const sessionCleanup = await pool.query(
          'DELETE FROM user_sessions WHERE expire < CURRENT_TIMESTAMP'
        );
        
        logger.info('Database cleanup completed', {
          chatLogsDeleted: chatCleanup.rowCount,
          sessionsDeleted: sessionCleanup.rowCount
        });
        
      } catch (error) {
        logger.error('Database cleanup failed', { error: error.message });
      }
    }
    
    cache.flushStats();
    logger.info('Daily cleanup completed successfully');
    
  } catch (error) {
    logger.error('Daily cleanup failed', { error: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled request error', { 
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method
  });
  
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    url: req.url,
    method: req.method,
    availableEndpoints: [
      'GET /',
      'GET /health',
      'POST /api/chat',
      'POST /api/feedback',
      'POST /api/upload',
      'GET /api/stats',
      'GET /api-docs'
    ]
  });
});

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received, starting graceful shutdown...`);
  
  server.close(() => {
    logger.info('HTTP server closed');
  });
  
  for (const [sessionId, { ws }] of activeConnections) {
    ws.close();
  }
  activeConnections.clear();
  
  if (pool) {
    try {
      await pool.end();
      logger.info('Database connections closed');
    } catch (error) {
      logger.error('Error closing database connections', { error: error.message });
    }
  }
  
  logger.info('Graceful shutdown completed');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { 
    reason,
    promise: promise.toString()
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { 
    error: error.message,
    stack: error.stack
  });
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// Server startup
async function startServer() {
  try {
    logger.info('🚀 Starting AGI Agent server...');
    
    await initializeDatabase();
    await setupSessionStore();
    
    server.listen(config.port, config.host, () => {
      logger.info(`🌐 AGI Agent running on http://${config.host}:${config.port}`);
      logger.info(`📚 API Documentation: http://${config.host}:${config.port}/api-docs`);
      logger.info(`🔌 WebSocket endpoint: ws://${config.host}:${config.port}/ws`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`💾 Database: ${dbConnected ? 'Connected' : 'Disconnected'}`);
      logger.info(`🤖 Available AI Providers: ${Object.keys(aiProviders).filter(p => aiProviders[p]).join(', ')}`);
      logger.info(`⚡ Available Skills: ${Array.from(agiAgent.skills.keys()).join(', ')}`);
    });
    
  } catch (error) {
    logger.error('❌ Server startup failed', { 
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

startServer();

export default app;
