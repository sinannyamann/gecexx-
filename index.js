import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';

// Gelişmiş AI Sistemi
class PersonalAI extends EventEmitter {
  constructor() {
    super();
    this.memory = new Map();
    this.userProfiles = new Map();
    this.conversationHistory = new Map();
    this.learningData = [];
    this.personality = {
      responseStyle: 'friendly',
      learningRate: 0.1,
      memoryCapacity: 1000
    };
    this.selfModificationLog = [];
    this.startTime = Date.now();
  }

  async processMessage(message, userId = 'default', context = {}) {
    try {
      this.updateUserProfile(userId, message);
      this.addToHistory(userId, message);
      const analysis = this.analyzeMessage(message);
      const response = await this.generateResponse(message, userId, analysis, context);
      this.recordLearning(userId, message, response, analysis);

      if (this.shouldSelfImprove()) {
        await this.improveSelf();
      }

      return {
        response,
        analysis,
        userStats: this.getUserStats(userId),
        timestamp: Date.now()
      };

    } catch (error) {
      console.error(`Message processing error [${userId}]:`, {
        message: error.message,
        stack: error.stack,
        userId,
        messageLength: message?.length
      });

      return {
        response: "Üzgünüm, bir hata oluştu. Lütfen tekrar deneyin.",
        error: true,
        timestamp: Date.now()
      };
    }
  }

  updateUserProfile(userId, message) {
    if (!this.userProfiles.has(userId)) {
      this.userProfiles.set(userId, {
        messageCount: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        preferences: {},
        sentiment: { positive: 0, negative: 0, neutral: 0 }
      });
    }

    const profile = this.userProfiles.get(userId);
    profile.messageCount++;
    profile.lastSeen = Date.now();

    const sentiment = this.analyzeSentiment(message);
    profile.sentiment[sentiment]++;
  }

  analyzeMessage(message) {
    return {
      length: message.length,
      wordCount: message.split(' ').length,
      sentiment: this.analyzeSentiment(message),
      intent: this.extractIntent(message),
      keywords: this.extractKeywords(message),
      complexity: this.calculateComplexity(message)
    };
  }

  analyzeSentiment(message) {
    const positiveWords = ['iyi', 'güzel', 'harika', 'mükemmel', 'teşekkür', 'seviyorum', 'başarılı'];
    const negativeWords = ['kötü', 'berbat', 'sinir', 'problem', 'hata', 'üzgün', 'başarısız'];

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
      'farewell': ['görüşürüz', 'hoşça kal', 'bay', 'elveda'],
      'self_improvement': ['kendini geliştir', 'öğren', 'gelişim', 'iyileştir']
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
  async generateResponse(message, userId, analysis, context) {
    const userProfile = this.userProfiles.get(userId);
    const history = this.conversationHistory.get(userId) || [];

    switch (analysis.intent) {
      case 'greeting':
        return this.generateGreeting(userProfile);
      case 'question':
        return this.generateAnswer(message, analysis, history);
      case 'request':
        return this.generateTaskResponse(message, analysis);
      case 'self_improvement':
        await this.improveSelf();
        return "Kendimi geliştirdim! Yeni yetenekler kazandım.";
      case 'farewell':
        return this.generateFarewell(userProfile);
      default:
        return this.generateContextualResponse(message, analysis, userProfile, history);
    }
  }

  generateGreeting(userProfile) {
    const hour = new Date().getHours();
    let timeGreeting = 'Merhaba';

    if (hour < 12) timeGreeting = 'Günaydın';
    else if (hour < 18) timeGreeting = 'İyi günler';
    else timeGreeting = 'İyi akşamlar';

    if (userProfile.messageCount === 1) {
      return `${timeGreeting}! Seninle tanıştığıma memnun oldum. Ben senin kişisel AI asistanınım.`;
    } else {
      return `${timeGreeting}! Seni tekrar görmek güzel. ${userProfile.messageCount}. konuşmamız bu.`;
    }
  }

  generateAnswer(message, analysis, history) {
    if (message.toLowerCase().includes('kaç mesaj')) {
      return `Toplamda ${history.length} mesaj alışverişi yaptık.`;
    }

    if (message.toLowerCase().includes('hafızan')) {
      const recentMessages = history.slice(-3).map(h => h.message).join(' | ');
      return `Son 3 mesajın: ${recentMessages}`;
    }

    if (message.toLowerCase().includes('kim')) {
      return "Ben senin kişisel AI asistanınım. Seninle konuşarak öğreniyor ve gelişiyorum.";
    }

    return `Bu konuda düşünmem gerekiyor: "${message}". Daha fazla bilgi verebilir misin?`;
  }

  generateTaskResponse(message, analysis) {
    if (analysis.keywords.includes('kod')) {
      return "Kod yazma konusunda yardımcı olabilirim. Hangi dilde ve ne tür bir kod istiyorsun?";
    }

    if (analysis.keywords.includes('analiz')) {
      return "Analiz yapmaya hazırım. Hangi veriyi analiz etmemi istiyorsun?";
    }

    return `"${message}" görevini anladım. Bu konuda elimden geleni yapacağım.`;
  }

  generateContextualResponse(message, analysis, userProfile, history) {
    let response = `Mesajını aldım: "${message}"`;

    if (analysis.sentiment === 'positive') {
      response += " Pozitif enerjin beni de mutlu ediyor! 😊";
    } else if (analysis.sentiment === 'negative') {
      response += " Üzgün görünüyorsun. Nasıl yardımcı olabilirim?";
    }

    if (analysis.complexity === 'complex') {
      response += " Karmaşık bir konu bu, detaylı düşünmem gerekiyor.";
    }

    return response;
  }

  generateFarewell(userProfile) {
    return `Hoşça kal! ${userProfile.messageCount} mesajlık sohbetimiz çok güzeldi. Tekrar görüşmek üzere!`;
  }

  addToHistory(userId, message) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }

    const history = this.conversationHistory.get(userId);
    history.push({
      message,
      timestamp: Date.now()
    });

    if (history.length > this.personality.memoryCapacity) {
      history.shift();
    }
  }

  recordLearning(userId, message, response, analysis) {
    this.learningData.push({
      userId,
      message,
      response,
      analysis,
      timestamp: Date.now()
    });

    if (this.learningData.length > 10000) {
      this.learningData.shift();
    }
  }

  shouldSelfImprove() {
    return this.learningData.length > 0 && this.learningData.length % 100 === 0;
  }

  async improveSelf() {
    try {
      const recentData = this.learningData.slice(-100);
      const patterns = this.findPatterns(recentData);
      this.updatePersonality(patterns);

      this.selfModificationLog.push({
        timestamp: Date.now(),
        patterns: patterns.length,
        changes: 'Personality and response patterns updated'
      });

      this.emit('self-improved', { patterns, timestamp: Date.now() });

    } catch (error) {
      console.error('Self-improvement error:', {
        message: error.message,
        stack: error.stack
      });
    }
  }

  findPatterns(data) {
    const patterns = [];
    const intentCounts = {};

    data.forEach(item => {
      const intent = item.analysis.intent;
      intentCounts[intent] = (intentCounts[intent] || 0) + 1;
    });

    const topIntent = Object.entries(intentCounts)
      .sort(([,a], [,b]) => b - a)[0];

    if (topIntent && topIntent[1] > 10) {
      patterns.push({
        type: 'frequent_intent',
        value: topIntent[0],
        count: topIntent[1]
      });
    }

    return patterns;
  }

  updatePersonality(patterns) {
    patterns.forEach(pattern => {
      if (pattern.type === 'frequent_intent') {
        if (pattern.value === 'question') {
          this.personality.responseStyle = 'informative';
        } else if (pattern.value === 'greeting') {
          this.personality.responseStyle = 'friendly';
        }
      }
    });
  }

  getUserStats(userId) {
    const profile = this.userProfiles.get(userId);
    if (!profile) return null;

    return {
      messageCount: profile.messageCount,
      memberSince: new Date(profile.firstSeen).toLocaleDateString('tr-TR'),
      lastSeen: new Date(profile.lastSeen).toLocaleDateString('tr-TR'),
      sentiment: profile.sentiment
    };
  }

  getSystemStats() {
    return {
      uptime: Date.now() - this.startTime,
      totalUsers: this.userProfiles.size,
      totalMessages: this.learningData.length,
      selfImprovements: this.selfModificationLog.length,
      memoryUsage: process.memoryUsage()
    };
  }
  }
// Express App Setup
const app = express();
const ai = new PersonalAI();

// Railway için trust proxy ayarı
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
  message: { error: 'Çok fazla istek gönderiyorsun. Lütfen bekle.' }
});
app.use(limiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  req.requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${req.requestId}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });

  next();
});

// Web Arayüzü HTML
const webInterface = `
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kişisel AI Asistanı</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .chat-container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 800px;
            height: 600px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .chat-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            text-align: center;
            position: relative;
        }
        .chat-header h1 { font-size: 24px; margin-bottom: 5px; }
        .chat-header p { opacity: 0.9; font-size: 14px; }
        .status-indicator {
            position: absolute;
            top: 20px;
            right: 20px;
            width: 12px;
            height: 12px;
            background: #4CAF50;
            border-radius: 50%;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
        .chat-messages {
            flex: 1;
            padding: 20px;
            overflow-y: auto;
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
        .message.user { justify-content: flex-end; }
        .message-content {
            max-width: 70%;
            padding: 12px 16px;
            border-radius: 18px;
            word-wrap: break-word;
        }
        .message.user .message-content {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-bottom-right-radius: 4px;
        }
        .message.ai .message-content {
            background: white;
            color: #333;
            border: 1px solid #e0e0e0;
            border-bottom-left-radius: 4px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .message-avatar {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            margin: 0 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
        }
        .message.user .message-avatar {
            background: #667eea;
            color: white;
            order: 1;
        }
        .message.ai .message-avatar {
            background: #4CAF50;
            color: white;
        }
        .chat-input-container {
            padding: 20px;
            background: white;
            border-top: 1px solid #e0e0e0;
        }
        .chat-input-form {
            display: flex;
            gap: 10px;
        }
        .chat-input {
            flex: 1;
            padding: 12px 16px;
            border: 2px solid #e0e0e0;
            border-radius: 25px;
            font-size: 16px;
            outline: none;
            transition: border-color 0.3s;
        }
        .chat-input:focus { border-color: #667eea; }
        .send-button {
            padding: 12px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 25px;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
            transition: transform 0.2s;
        }
        .send-button:hover { transform: translateY(-2px); }
        .send-button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        .typing-indicator {
            display: none;
            padding: 10px 16px;
            background: white;
            border-radius: 18px;
            border: 1px solid #e0e0e0;
            margin-bottom: 15px;
            max-width: 70%;
        }
        .typing-dots { display: flex; gap: 4px; }
        .typing-dot {
            width: 8px;
            height: 8px;
            background: #999;
            border-radius: 50%;
            animation: typing 1.4s infinite;
        }
        .typing-dot:nth-child(2) { animation-delay: 0.2s; }
        .typing-dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes typing {
            0%, 60%, 100% { transform: translateY(0); }
            30% { transform: translateY(-10px); }
        }
        .stats-panel {
            position: fixed;
            top: 20px;
            left: 20px;
            background: white;
            padding: 15px;
            border-radius: 10px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            font-size: 12px;
            color: #666;
            max-width: 200px;
        }
        .stats-panel h3 {
            color: #333;
            margin-bottom: 10px;
            font-size: 14px;
        }
        .stat-item { margin-bottom: 5px; }
        @media (max-width: 768px) {
            .chat-container { height: 100vh; border-radius: 0; }
            .stats-panel { display: none; }
            .message-content { max-width: 85%; }
        }
    </style>
</head>
<body>
    <div class="stats-panel">
        <h3>📊 Sistem Durumu</h3>
        <div class="stat-item">Kullanıcılar: <span id="userCount">0</span></div>
        <div class="stat-item">Mesajlar: <span id="messageCount">0</span></div>
        <div class="stat-item">Çalışma Süresi: <span id="uptime">0s</span></div>
        <div class="stat-item">Geliştirmeler: <span id="improvements">0</span></div>
    </div>
    <div class="chat-container">
        <div class="chat-header">
            <div class="status-indicator"></div>
            <h1>🧠 Kişisel AI Asistanı</h1>
            <p>Seninle konuşarak öğrenen ve gelişen yapay zeka</p>
        </div>
        <div class="chat-messages" id="chatMessages">
            <div class="message ai">
                <div class="message-avatar">AI</div>
                <div class="message-content">
                    Merhaba! Ben senin kişisel AI asistanınım. Seninle konuşarak öğreniyor ve gelişiyorum. Nasıl yardımcı olabilirim?
                </div>
            </div>
        </div>
        <div class="typing-indicator" id="typingIndicator">
            <div class="message-avatar">AI</div>
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>
        <div class="chat-input-container">
            <form class="chat-input-form" id="chatForm">
                <input 
                    type="text" 
                    class="chat-input" 
                    id="messageInput" 
                    placeholder="Mesajını buraya yaz..." 
                    autocomplete="off"
                    maxlength="1000"
                >
                <button type="submit" class="send-button" id="sendButton">Gönder</button>
            </form>
        </div>
    </div>
    <script>
        class ChatInterface {
            constructor() {
                this.messagesContainer = document.getElementById('chatMessages');
                this.messageInput = document.getElementById('messageInput');
                this.sendButton = document.getElementById('sendButton');
                this.chatForm = document.getElementById('chatForm');
                this.typingIndicator = document.getElementById('typingIndicator');
                this.userId = this.generateUserId();

                this.initializeEventListeners();
                this.updateStats();
                setInterval(() => this.updateStats(), 10000);
            }

            generateUserId() {
                return 'user_' + Math.random().toString(36).substr(2, 9);
            }

            initializeEventListeners() {
                this.chatForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.sendMessage();
                });

                this.messageInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        this.sendMessage();
                    }
                });
            }

            async sendMessage() {
                const message = this.messageInput.value.trim();
                if (!message) return;

                this.addMessage(message, 'user');
                this.messageInput.value = '';
                this.setLoading(true);

                try {
                    const response = await fetch('/chat', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            message: message,
                            userId: this.userId
                        })
                    });

                    const data = await response.json();

                    if (data.error) {
                        this.addMessage('Üzgünüm, bir hata oluştu: ' + data.error, 'ai');
                    } else {
                        this.addMessage(data.response, 'ai');
                    }

                } catch (error) {
                    console.error('Error:', error);
                    this.addMessage('Bağlantı hatası oluştu. Lütfen tekrar deneyin.', 'ai');
                } finally {
                    this.setLoading(false);
                }
            }

            addMessage(content, sender) {
                const messageDiv = document.createElement('div');
                messageDiv.className = `message ${sender}`;

                const avatar = document.createElement('div');
                avatar.className = 'message-avatar';
                avatar.textContent = sender === 'user' ? 'Sen' : 'AI';

                const messageContent = document.createElement('div');
                messageContent.className = 'message-content';
                messageContent.textContent = content;

                messageDiv.appendChild(avatar);
                messageDiv.appendChild(messageContent);

                this.messagesContainer.appendChild(messageDiv);
                this.scrollToBottom();
            }

            setLoading(isLoading) {
                this.sendButton.disabled = isLoading;
                this.messageInput.disabled = isLoading;

                if (isLoading) {
                    this.typingIndicator.style.display = 'flex';
                    this.sendButton.textContent = 'Bekle...';
                } else {
                    this.typingIndicator.style.display = 'none';
                    this.sendButton.textContent = 'Gönder';
                }

                this.scrollToBottom();
            }

            scrollToBottom() {
                setTimeout(() => {
                    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
                }, 100);
            }

            async updateStats() {
                try {
                    const response = await fetch('/stats');
                    const stats = await response.json();

                    document.getElementById('userCount').textContent = stats.totalUsers;
                    document.getElementById('messageCount').textContent = stats.totalMessages;
                    document.getElementById('improvements').textContent = stats.selfImprovements;

                    const uptimeSeconds = Math.floor(stats.uptime / 1000);
                    const hours = Math.floor(uptimeSeconds / 3600);
                    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
                    const seconds = uptimeSeconds % 60;

                    let uptimeText = '';
                    if (hours > 0) uptimeText += hours + 's ';
                    if (minutes > 0) uptimeText += minutes + 'd ';
                    uptimeText += seconds + 's';

                    document.getElementById('uptime').textContent = uptimeText;

                } catch (error) {
                    console.error('Stats update error:', error);
                }
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            new ChatInterface();
        });
    </script>
</body>
</html>
`;
// Routes
app.get('/', (req, res) => {
  res.send(webInterface);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    system: ai.getSystemStats()
  });
});

app.post('/chat', async (req, res) => {
  try {
    const { message, userId } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: 'Geçerli bir mesaj göndermelisin',
        requestId: req.requestId
      });
    }

    if (message.length > 1000) {
      return res.status(400).json({
        error: 'Mesaj çok uzun (maksimum 1000 karakter)',
        requestId: req.requestId
      });
    }

    const result = await ai.processMessage(message, userId, { requestId: req.requestId });
    res.json(result);

  } catch (error) {
    console.error(`Chat error [${req.requestId}]:`, {
      message: error.message,
      stack: error.stack,
      body: req.body
    });

    res.status(500).json({
      error: 'Bir hata oluştu. Lütfen tekrar dene.',
      requestId: req.requestId
    });
  }
});

app.get('/stats', (req, res) => {
  res.json(ai.getSystemStats());
});
// WebSocket Server
const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`🧠 Gelişmiş Kişisel AI Sistemi ${process.env.PORT || 3000} portunda çalışıyor`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Yeni WebSocket bağlantısı');

  ws.on('message', async (data) => {
    try {
      const { message, userId } = JSON.parse(data.toString());

      if (!message) {
        ws.send(JSON.stringify({ error: 'Mesaj gerekli' }));
        return;
      }

      const result = await ai.processMessage(message, userId);
      ws.send(JSON.stringify(result));

    } catch (error) {
      console.error('WebSocket error:', error.message);
      ws.send(JSON.stringify({ error: 'Geçersiz mesaj formatı' }));
    }
  });

  ws.on('close', () => {
    console.log('WebSocket bağlantısı kapandı');
  });
});
// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM alındı, sistem kapatılıyor...');
  server.close(() => {
    console.log('Sistem başarıyla kapatıldı');
    process.exit(0);
  });
});

export default app;
