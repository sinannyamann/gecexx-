import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pkg from 'pg';
import natural from 'natural';
import winston from 'winston';
import { EventEmitter } from 'events';

const { Pool } = pkg;

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// PostgreSQL bağlantısı
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
class AdvancedPersonalAI extends EventEmitter {
  constructor() {
    super();
    this.startTime = Date.now();
    this.personality = {
      responseStyle: 'friendly',
      learningRate: 0.1,
      memoryCapacity: 1000,
      contextWindow: 5
    };
    this.responseTemplates = new Map();
    this.learningPatterns = new Map();
    this.initializeNLP();
    this.initializeDatabase();
    this.loadResponseTemplates();
  }

  initializeNLP() {
  this.stemmer = natural.PorterStemmerTr || natural.PorterStemmer;
  this.tokenizer = new natural.WordTokenizer();
  logger.info('NLP modülleri başlatıldı');
}
  async initializeDatabase() {
    try {
      // Kullanıcı profilleri
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_profiles (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) UNIQUE NOT NULL,
          message_count INTEGER DEFAULT 0,
          first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          preferences JSONB DEFAULT '{}',
          sentiment_stats JSONB DEFAULT '{"positive": 0, "negative": 0, "neutral": 0}',
          response_style VARCHAR(50) DEFAULT 'friendly'
        )
      `);

      // Konuşma geçmişi
      await pool.query(`
        CREATE TABLE IF NOT EXISTS conversation_history (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          response TEXT,
          sentiment VARCHAR(20),
          intent VARCHAR(50),
          keywords JSONB,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          feedback INTEGER DEFAULT 0
        )
      `);

      // Öğrenme verileri
      await pool.query(`
        CREATE TABLE IF NOT EXISTS learning_data (
          id SERIAL PRIMARY KEY,
          pattern_type VARCHAR(100),
          pattern_value TEXT,
          frequency INTEGER DEFAULT 1,
          success_rate FLOAT DEFAULT 0.5,
          last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      logger.info('Veritabanı tabloları hazırlandı');
    } catch (error) {
      logger.error('Veritabanı hatası:', error);
      throw error;
    }
  }
  loadResponseTemplates() {
    const templates = [
      { intent: 'greeting', template: '{timeGreeting}! Nasıl yardımcı olabilirim?' },
      { intent: 'question', template: 'Bu konuda düşünmem gerekiyor: {message}' },
      { intent: 'request', template: '{task} konusunda elimden geleni yapacağım.' },
      { intent: 'farewell', template: 'Hoşça kal! Sohbet güzeldi.' }
    ];

    templates.forEach(template => {
      this.responseTemplates.set(template.intent, template);
    });
  }

  async processMessage(message, userId = 'default', context = {}) {
    try {
      await this.updateUserProfile(userId, message);
      const analysis = await this.analyzeMessage(message);
      const response = await this.generateResponse(message, userId, analysis);
      await this.saveConversation(userId, message, response, analysis);
      
      if (await this.shouldSelfImprove()) {
        await this.improveSelf();
      }

      return {
        response,
        analysis,
        userStats: await this.getUserStats(userId),
        timestamp: Date.now()
      };

    } catch (error) {
      logger.error(`Mesaj işleme hatası [${userId}]:`, error);
      return {
        response: "Üzgünüm, bir hata oluştu. Lütfen tekrar deneyin.",
        error: true,
        timestamp: Date.now()
      };
    }
  }
  async updateUserProfile(userId, message) {
    try {
      const sentiment = this.analyzeSentiment(message);
      
      await pool.query(`
        INSERT INTO user_profiles (user_id, message_count, sentiment_stats)
        VALUES ($1, 1, $2)
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          message_count = user_profiles.message_count + 1,
          last_seen = CURRENT_TIMESTAMP,
          sentiment_stats = jsonb_set(
            user_profiles.sentiment_stats,
            '{${sentiment}}',
            (COALESCE((user_profiles.sentiment_stats->>'${sentiment}')::int, 0) + 1)::text::jsonb
          )
      `, [userId, JSON.stringify({positive: 0, negative: 0, neutral: 0, [sentiment]: 1})]);
      
    } catch (error) {
      logger.error('Kullanıcı profili güncelleme hatası:', error);
    }
  }

  async analyzeMessage(message) {
    const tokens = this.tokenizer.tokenize(message.toLowerCase());
    const stems = tokens.map(token => this.stemmer.stem(token));
    
    return {
      length: message.length,
      wordCount: tokens.length,
      sentiment: this.analyzeSentiment(message),
      intent: this.extractIntent(message),
      keywords: this.extractKeywords(message),
      complexity: this.calculateComplexity(message),
      stems: stems
    };
  }

  analyzeSentiment(message) {
    const positiveWords = ['iyi', 'güzel', 'harika', 'mükemmel', 'teşekkür', 'seviyorum'];
    const negativeWords = ['kötü', 'berbat', 'sinir', 'problem', 'hata', 'üzgün'];
    
    const words = message.toLowerCase().split(' ');
    let score = 0;
    
    words.forEach(word => {
      if (positiveWords.includes(word)) score++;
      if (negativeWords.includes(word)) score--;
    });
    
    if (score > 0) return 'positive';
    if (score < 0) return 'negative';
    return 'neutral';
  }

  extractIntent(message) {
    const intents = {
      'question': ['nedir', 'nasıl', 'ne zaman', 'neden', 'kim', 'nerede'],
      'request': ['yap', 'oluştur', 'hazırla', 'göster', 'anlat'],
      'greeting': ['merhaba', 'selam', 'günaydın', 'iyi akşamlar'],
      'farewell': ['görüşürüz', 'hoşça kal', 'bay', 'elveda']
    };

    const lowerMessage = message.toLowerCase();
    for (const [intent, keywords] of Object.entries(intents)) {
      if (keywords.some(keyword => lowerMessage.includes(keyword))) {
        return intent;
      }
    }
    return 'general';
  }

  extractKeywords(message) {
    const stopWords = ['ve', 'ile', 'bir', 'bu', 'şu', 'o', 'ben', 'sen'];
    const words = message.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(' ')
      .filter(word => word.length > 2 && !stopWords.includes(word));
    return [...new Set(words)].slice(0, 5);
  }

  calculateComplexity(message) {
    const sentences = message.split(/[.!?]+/).length;
    const words = message.split(' ').length;
    const avgWordsPerSentence = words / sentences;
    
    if (avgWordsPerSentence > 15) return 'complex';
    if (avgWordsPerSentence > 8) return 'medium';
    return 'simple';
  }
  async generateResponse(message, userId, analysis) {
    try {
      const context = await this.getConversationContext(userId);
      const userProfile = await this.getUserProfile(userId);
      
      let response = '';
      
      switch (analysis.intent) {
        case 'greeting':
          response = await this.generateGreeting(userProfile);
          break;
        case 'question':
          response = await this.generateAnswer(message, analysis, context);
          break;
        case 'request':
          response = await this.generateTaskResponse(message, analysis);
          break;
        case 'farewell':
          response = await this.generateFarewell(userProfile);
          break;
        default:
          response = await this.generateContextualResponse(message, analysis, userProfile, context);
      }
      
      return this.personalizeResponse(response, analysis, userProfile);
      
    } catch (error) {
      logger.error('Yanıt üretme hatası:', error);
      return "Bu konuda düşünmem gerekiyor. Biraz daha detay verebilir misin?";
    }
  }

  async generateGreeting(userProfile) {
    const hour = new Date().getHours();
    let timeGreeting = 'Merhaba';
    
    if (hour < 12) timeGreeting = 'Günaydın';
    else if (hour < 18) timeGreeting = 'İyi günler';
    else timeGreeting = 'İyi akşamlar';
    
    if (userProfile && userProfile.message_count === 1) {
      return `${timeGreeting}! Seninle tanıştığıma memnun oldum. Ben senin kişisel AI asistanınım.`;
    } else {
      return `${timeGreeting}! Seni tekrar görmek güzel. Nasıl yardımcı olabilirim?`;
    }
  }

  async generateAnswer(message, analysis, context) {
    // Bağlamsal yanıt üretimi
    if (context && context.length > 0) {
      const recentTopics = context.map(c => c.keywords).flat();
      if (recentTopics.length > 0) {
        return `Bu konuyu daha önce de konuştuk. ${message} hakkında daha spesifik ne öğrenmek istiyorsun?`;
      }
    }
    
    return `"${message}" konusunda düşünüyorum. Daha fazla detay verebilir misin?`;
  }

  async generateTaskResponse(message, analysis) {
    if (analysis.keywords.includes('kod')) {
      return "Kod yazma konusunda yardımcı olabilirim. Hangi dilde ve ne tür bir kod istiyorsun?";
    }
    return `"${message}" görevini anladım. Bu konuda elimden geleni yapacağım.`;
  }

  async generateFarewell(userProfile) {
    const messageCount = userProfile ? userProfile.message_count : 0;
    return `Hoşça kal! ${messageCount} mesajlık sohbetimiz çok güzeldi. Tekrar görüşmek üzere!`;
  }

  async generateContextualResponse(message, analysis, userProfile, context) {
    let response = `Mesajını aldım: "${message}"`;
    
    if (analysis.sentiment === 'positive') {
      response += " Pozitif enerjin beni de mutlu ediyor! 😊";
    } else if (analysis.sentiment === 'negative') {
      response += " Üzgün görünüyorsun. Nasıl yardımcı olabilirim?";
    }
    
    return response;
  }

  personalizeResponse(response, analysis, userProfile) {
    if (userProfile && userProfile.response_style === 'formal') {
      response = response.replace(/😊/g, '').replace(/!+/g, '.');
    }
    return response;
  }
  async saveConversation(userId, message, response, analysis) {
    try {
      await pool.query(`
        INSERT INTO conversation_history 
        (user_id, message, response, sentiment, intent, keywords)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        userId, 
        message, 
        response, 
        analysis.sentiment, 
        analysis.intent, 
        JSON.stringify(analysis.keywords)
      ]);
    } catch (error) {
      logger.error('Konuşma kaydetme hatası:', error);
    }
  }

  async getConversationContext(userId) {
    try {
      const result = await pool.query(`
        SELECT message, response, keywords, timestamp
        FROM conversation_history 
        WHERE user_id = $1 
        ORDER BY timestamp DESC 
        LIMIT $2
      `, [userId, this.personality.contextWindow]);
      
      return result.rows;
    } catch (error) {
      logger.error('Bağlam getirme hatası:', error);
      return [];
    }
  }

  async getUserProfile(userId) {
    try {
      const result = await pool.query(`
        SELECT * FROM user_profiles WHERE user_id = $1
      `, [userId]);
      
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Kullanıcı profili getirme hatası:', error);
      return null;
    }
  }

  async getUserStats(userId) {
    try {
      const profile = await this.getUserProfile(userId);
      if (!profile) return null;
      
      return {
        messageCount: profile.message_count,
        memberSince: new Date(profile.first_seen).toLocaleDateString('tr-TR'),
        lastSeen: new Date(profile.last_seen).toLocaleDateString('tr-TR'),
        sentiment: profile.sentiment_stats
      };
    } catch (error) {
      logger.error('Kullanıcı istatistikleri hatası:', error);
      return null;
    }
  }

  async shouldSelfImprove() {
    try {
      const result = await pool.query(`
        SELECT COUNT(*) as total FROM conversation_history
      `);
      const total = parseInt(result.rows[0].total);
      return total > 0 && total % 50 === 0;
    } catch (error) {
      return false;
    }
  }

  async improveSelf() {
    try {
      // Sık kullanılan kalıpları bul
      const patterns = await pool.query(`
        SELECT intent, COUNT(*) as frequency
        FROM conversation_history 
        WHERE timestamp > NOW() - INTERVAL '24 hours'
        GROUP BY intent
        ORDER BY frequency DESC
        LIMIT 5
      `);

      // Kişiliği güncelle
      if (patterns.rows.length > 0) {
        const topIntent = patterns.rows[0].intent;
        if (topIntent === 'question') {
          this.personality.responseStyle = 'informative';
        } else if (topIntent === 'greeting') {
          this.personality.responseStyle = 'friendly';
        }
      }

      logger.info('AI kendini geliştirdi', { patterns: patterns.rows });
      this.emit('self-improved', { patterns: patterns.rows, timestamp: Date.now() });
      
    } catch (error) {
      logger.error('Kendini geliştirme hatası:', error);
    }
  }

  async getSystemStats() {
    try {
      const userCount = await pool.query('SELECT COUNT(DISTINCT user_id) as count FROM user_profiles');
      const messageCount = await pool.query('SELECT COUNT(*) as count FROM conversation_history');
      
      return {
        uptime: Date.now() - this.startTime,
        totalUsers: parseInt(userCount.rows[0].count),
        totalMessages: parseInt(messageCount.rows[0].count),
        memoryUsage: process.memoryUsage()
      };
    } catch (error) {
      logger.error('Sistem istatistikleri hatası:', error);
      return {
        uptime: Date.now() - this.startTime,
        totalUsers: 0,
        totalMessages: 0,
        memoryUsage: process.memoryUsage()
      };
    }
  }
}
// Express App Setup
const app = express();
const ai = new AdvancedPersonalAI();

// Railway için trust proxy
app.set('trust proxy', 1);

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Çok fazla istek. Lütfen bekleyin.' }
});
app.use(limiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  req.requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  
  next();
});

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Gelişmiş Kişisel AI Sistemi',
    version: '2.0.0',
    status: 'active',
    endpoints: ['/chat', '/health', '/stats']
  });
});

app.get('/health', async (req, res) => {
  try {
    // Veritabanı bağlantısını test et
    await pool.query('SELECT 1');
    
    res.json({
      status: 'healthy',
      timestamp: Date.now(),
      database: 'connected',
      system: await ai.getSystemStats()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: Date.now()
    });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { message, userId } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: 'Geçerli bir mesaj göndermelisin'
      });
    }
    
    if (message.length > 1000) {
      return res.status(400).json({
        error: 'Mesaj çok uzun (maksimum 1000 karakter)'
      });
    }
    
    const result = await ai.processMessage(message, userId || 'anonymous');
    res.json(result);
    
  } catch (error) {
    logger.error('Chat hatası:', error);
    res.status(500).json({
      error: 'Bir hata oluştu. Lütfen tekrar deneyin.'
    });
  }
});

app.get('/stats', async (req, res) => {
  try {
    const stats = await ai.getSystemStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'İstatistikler alınamadı' });
  }
});

// Server başlatma
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info(`🧠 Gelişmiş AI Sistemi ${PORT} portunda çalışıyor`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM alındı, sistem kapatılıyor...');
  server.close(() => {
    pool.end();
    logger.info('Sistem başarıyla kapatıldı');
    process.exit(0);
  });
});

export default app;
