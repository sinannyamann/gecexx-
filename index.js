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

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

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

      logger.info('Veritabanı tabloları hazırlandı');
    } catch (error) {
      logger.error('Veritabanı hatası:', error);
    }
  }

  loadResponseTemplates() {
    const templates = [
      { intent: 'greeting', template: 'Merhaba! Nasıl yardımcı olabilirim?' },
      { intent: 'question', template: 'Bu konuda düşünmem gerekiyor.' },
      { intent: 'request', template: 'Bu konuda elimden geleni yapacağım.' },
      { intent: 'farewell', template: 'Hoşça kal! Sohbet güzeldi.' }
    ];

    templates.forEach(template => {
      this.responseTemplates.set(template.intent, template);
    });
  }

  async processMessage(message, userId = 'default') {
    try {
      await this.updateUserProfile(userId, message);
      const analysis = await this.analyzeMessage(message);
      const response = await this.generateResponse(message, userId, analysis);
      await this.saveConversation(userId, message, response, analysis);

      return {
        response,
        analysis,
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
          last_seen = CURRENT_TIMESTAMP
      `, [userId, JSON.stringify({positive: 0, negative: 0, neutral: 0, [sentiment]: 1})]);
      
    } catch (error) {
      logger.error('Kullanıcı profili güncelleme hatası:', error);
    }
  }

  async analyzeMessage(message) {
    const tokens = this.tokenizer.tokenize(message.toLowerCase());
    
    return {
      length: message.length,
      wordCount: tokens.length,
      sentiment: this.analyzeSentiment(message),
      intent: this.extractIntent(message),
      keywords: this.extractKeywords(message)
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

  async generateResponse(message, userId, analysis) {
    try {
      let response = '';
      
      switch (analysis.intent) {
        case 'greeting':
          response = 'Merhaba! Ben senin kişisel AI asistanınım. Nasıl yardımcı olabilirim?';
          break;
        case 'question':
          response = `"${message}" konusunda düşünüyorum. Daha fazla detay verebilir misin?`;
          break;
        case 'request':
          response = `"${message}" görevini anladım. Bu konuda elimden geleni yapacağım.`;
          break;
        case 'farewell':
          response = 'Hoşça kal! Sohbetimiz çok güzeldi. Tekrar görüşmek üzere!';
          break;
        default:
          response = `Mesajını aldım: "${message}". Bu konuda nasıl yardımcı olabilirim?`;
      }
      
      if (analysis.sentiment === 'positive') {
        response += " Pozitif enerjin beni de mutlu ediyor! 😊";
      } else if (analysis.sentiment === 'negative') {
        response += " Üzgün görünüyorsun. Nasıl yardımcı olabilirim?";
      }
      
      return response;
      
    } catch (error) {
      logger.error('Yanıt üretme hatası:', error);
      return "Bu konuda düşünmem gerekiyor. Biraz daha detay verebilir misin?";
    }
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

  async getSystemStats() {
    try {
      const userCount = await pool.query('SELECT COUNT(DISTINCT user_id) as count FROM user_profiles');
      const messageCount = await pool.query('SELECT COUNT(*) as count FROM conversation_history');
      
      return {
        uptime: Date.now() - this.startTime,
        totalUsers: parseInt(userCount.rows[0]?.count || 0),
        totalMessages: parseInt(messageCount.rows[0]?.count || 0),
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

const app = express();
const ai = new AdvancedPersonalAI();

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Çok fazla istek. Lütfen bekleyin.' }
});
app.use(limiter);

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <title>Kişisel AI Sohbet</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
      margin: 0; 
      display: flex; 
      justify-content: center; 
      align-items: center; 
      min-height: 100vh; 
      padding: 20px;
    }
    .container { 
      max-width: 600px; 
      width: 100%; 
      background: rgba(255, 255, 255, 0.95); 
      border-radius: 20px; 
      box-shadow: 0 20px 40px rgba(0,0,0,0.1); 
      padding: 30px; 
      display: flex; 
      flex-direction: column; 
      height: 70vh; 
      backdrop-filter: blur(10px);
    }
    h2 { 
      text-align: center; 
      color: #333; 
      margin-bottom: 25px; 
      font-size: 28px;
      background: linear-gradient(45deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .messages { 
      flex-grow: 1; 
      overflow-y: auto; 
      margin-bottom: 20px; 
      padding: 15px; 
      background: rgba(248, 249, 250, 0.8);
      border-radius: 15px;
      border: 1px solid rgba(0,0,0,0.05);
    }
    .msg { 
      margin: 12px 0; 
      padding: 12px 18px; 
      border-radius: 18px; 
      max-width: 80%; 
      word-wrap: break-word; 
      animation: fadeIn 0.3s ease-in;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .msg.user { 
      background: linear-gradient(135deg, #667eea, #764ba2); 
      color: white; 
      margin-left: auto; 
      text-align: right; 
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
    }
    .msg.ai { 
      background: linear-gradient(135deg, #f093fb, #f5576c); 
      color: white; 
      margin-right: auto; 
      text-align: left; 
      box-shadow: 0 4px 15px rgba(240, 147, 251, 0.3);
    }
    .input-row { 
      display: flex; 
      gap: 12px; 
      margin-top: auto; 
      background: rgba(255, 255, 255, 0.9);
      padding: 15px;
      border-radius: 15px;
      border: 1px solid rgba(0,0,0,0.05);
    }
    input[type="text"] { 
      flex: 1; 
      padding: 15px 20px; 
      border-radius: 25px; 
      border: 2px solid transparent; 
      font-size: 16px; 
      outline: none; 
      transition: all 0.3s ease;
      background: rgba(255, 255, 255, 0.9);
    }
    input[type="text"]:focus { 
      border-color: #667eea; 
      box-shadow: 0 0 20px rgba(102, 126, 234, 0.2);
    }
    button { 
      padding: 15px 25px; 
      border-radius: 25px; 
      border: none; 
      background: linear-gradient(135deg, #667eea, #764ba2); 
      color: white; 
      font-weight: bold; 
      cursor: pointer; 
      font-size: 16px; 
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
    }
    button:hover { 
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
    }
    button:disabled { 
      background: #ccc; 
      cursor: not-allowed; 
      transform: none;
      box-shadow: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>🧠 Kişisel AI Asistanı</h2>
    <div class="messages" id="messages"></div>
    <form id="chatForm" class="input-row" autocomplete="off">
      <input type="text" id="msgInput" placeholder="Mesajınızı yazın..." maxlength="1000" required />
      <button type="submit">Gönder</button>
    </form>
  </div>
  <script>
    const messagesDiv = document.getElementById('messages');
    const chatForm = document.getElementById('chatForm');
    const msgInput = document.getElementById('msgInput');
    const sendButton = chatForm.querySelector('button[type="submit"]');
    const userId = 'webuser_' + Math.random().toString(36).substr(2, 8);

    function addMsg(text, who) {
      const div = document.createElement('div');
      div.className = 'msg ' + who;
      div.textContent = text;
      messagesDiv.appendChild(div);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    chatForm.onsubmit = async (e) => {
      e.preventDefault();
      const text = msgInput.value.trim();
      if (!text) return;

      addMsg(text, 'user');
      msgInput.value = '';
      sendButton.disabled = true;

      try {
        const res = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, userId })
        });
        const data = await res.json();
        addMsg(data.response || 'Bir hata oluştu.', 'ai');
      } catch (error) {
        console.error('Fetch error:', error);
        addMsg('Sunucuya ulaşılamıyor.', 'ai');
      } finally {
        sendButton.disabled = false;
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      }
    };

    addMsg('Merhaba! Ben senin kişisel AI asistanınım. Nasıl yardımcı olabilirim?', 'ai');
  </script>
</body>
</html>`);
});

app.get('/health', async (req, res) => {
  try {
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

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info(`🧠 Gelişmiş AI Sistemi ${PORT} portunda çalışıyor`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM alındı, sistem kapatılıyor...');
  server.close(() => {
    pool.end();
    logger.info('Sistem başarıyla kapatıldı');
    process.exit(0);
  });
});

export default app;
