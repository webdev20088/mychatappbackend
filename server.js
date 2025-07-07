const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: 'https://20years-jee-pyq.netlify.app',
  credentials: true,
}));
app.use(express.json());

const server = http.createServer(app);
const PairStats = require('./models/PairStats');
const UserStats = require('./models/UserStats');

const loginTimestamps = {};
const io = new Server(server, {
  cors: {
    origin: 'https://20years-jee-pyq.netlify.app',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ✅ MongoDB connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost/chatapp')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.log(err));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  sessionDuration: { type: Number, default: 0 },  // 🆕 Lifetime usage in minutes
  lastSeen: { type: Date, default: null }        // Last seen timestamp
});

// ✅ Update message schema to include tag
const messageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
  tag: { type: String, default: null } // ✅ new field
});
// ✅ Add this near the top of your server.js after mongoose models
async function updateSessionAndLastSeen(username) {
  const now = new Date();
  const existing = await UserStats.findOne({ username });
  if (existing?.lastSeen) {
    const diff = Math.floor((now - existing.lastSeen) / (1000 * 60)); // minutes
    await UserStats.findOneAndUpdate(
      { username },
      {
        $inc: { totalUsageMinutes: diff },
        $set: { lastSeen: now }
      },
      { upsert: true }
    );
  } else {
    await UserStats.findOneAndUpdate(
      { username },
      { $set: { lastSeen: now } },
      { upsert: true }
    );
  }
}

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

let onlineUsers = {};

io.on('connection', (socket) => {
 socket.on('login', async (username) => {
  onlineUsers[username] = socket.id;
  await UserStats.findOneAndUpdate(
    { username },
    { $set: { lastSeen: new Date() } },
    { upsert: true }
  );
  io.emit('onlineUsers', Object.keys(onlineUsers));
});


  socket.on('logout', async (username) => {
  delete onlineUsers[username];

  const userStat = await UserStats.findOne({ username });
  const now = new Date();

  if (userStat?.lastSeen) {
    const diff = Math.floor((now - userStat.lastSeen) / (1000 * 60)); // minutes
    await UserStats.findOneAndUpdate(
      { username },
      {
        $inc: { totalUsageMinutes: diff },
        $set: { lastSeen: now }
      },
      { upsert: true }
    );
  }

  io.emit('onlineUsers', Object.keys(onlineUsers));
});



  socket.on('disconnect', async () => {
    for (const [username, id] of Object.entries(onlineUsers)) {
      if (id === socket.id) 
        await updateSessionAndLastSeen(username); // ✅ Allowed here
        delete onlineUsers[username];
        delete loginTimestamps[username];
    }
    io.emit('onlineUsers', Object.keys(onlineUsers));
  });

  socket.on('joinRoom', (room) => socket.join(room));

 socket.on('sendMessage', async ({ sender, receiver, message, tag, room }) => {
  const msg = new Message({ sender, receiver, message, tag: tag || null });
  await msg.save();

  const pairKey = [sender, receiver].sort().join('-');

  await PairStats.findOneAndUpdate(
    { pair: pairKey },
    {
      $inc: { totalCount: 1, currentCount: 1 }
    },
    { upsert: true, new: true }
  );

  // 🆕 Increment lifetime usage (1 minute per message)
  await User.updateOne({ username: sender }, { $inc: { sessionDuration: 1 } });
  await User.updateOne({ username: receiver }, { $inc: { sessionDuration: 1 } });

  io.to(room).emit('newMessage', msg);
});




  socket.on('markRead', async ({ user1, user2 }) => {
    await Message.updateMany(
      { sender: user2, receiver: user1, read: false },
      { $set: { read: true } }
    );
     // ✅ Only notify the sender (user2)
  const senderSocketId = onlineUsers[user2];
  if (senderSocketId) {
    io.to(senderSocketId).emit('refresh');
  }
     

  });

  socket.on('typing', ({ sender, receiver, isTyping }) => {
    const room = `${receiver}_${sender}`;
    socket.to(room).emit('typing', { sender, isTyping });
  });

  socket.on('clearChat', async ({ user1, user2 }) => {
    await Message.deleteMany({
      $or: [
        { sender: user1, receiver: user2 },
        { sender: user2, receiver: user1 }
      ]
    });
    io.to(`${user1}_${user2}`).emit('cleared');
    io.to(`${user2}_${user1}`).emit('cleared');
  });
});

// ✅ Signup API
app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  const exists = await User.findOne({ username });
  if (exists) return res.status(400).json({ message: 'Username exists' });
  await new User({ username, password }).save();
  res.json({ success: true });
});

// ✅ Login API
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || user.password !== password)
    return res.status(400).json({ message: 'Invalid' });
  res.json({ success: true });
});

// ✅ Get User by Username
app.get('/user/:username', async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'Not found' });
  res.json({ success: true });
});

// ✅ Get Messages Between Users
app.get('/messages', async (req, res) => {
  const { user1, user2 } = req.query;
  const messages = await Message.find({
    $or: [
      { sender: user1, receiver: user2 },
      { sender: user2, receiver: user1 }
    ]
  }).sort('timestamp');
  res.json(messages);
});

// ✅ Admin Panel — All Users Info
// ✅ Admin Panel — All Users Info
app.get('/admin', async (req, res) => {
  const { user } = req.query;
  if (user !== 'aniketadmin') return res.status(403).json({ message: 'Unauthorized' });

  const users = await User.find();
  const stats = await UserStats.find();

  const userData = users.map(u => {
    const stat = stats.find(s => s.username === u.username);
    return {
      username: u.username,
      password: '•••••••',
      online: onlineUsers[u.username] ? true : false,
      totalUsageMinutes: stat?.totalUsageMinutes || 0,
      lastSeen: onlineUsers[u.username] ? 'Online' : (stat?.lastSeen ? stat.lastSeen.toISOString() : 'N/A')
    };
  });

  res.json(userData);
});

// ✅ Pairwise Analytics
app.get('/analytics', async (req, res) => {
  const { user } = req.query;
  if (user !== 'aniketadmin') return res.status(403).json({ message: 'Unauthorized' });

  const stats = await PairStats.find();

  const analytics = stats.map(p => ({
    pair: p.pair,
    totalCount: p.totalCount,
    currentCount: p.currentCount,
    estimatedKB: `${p.estimatedKB || 0} KB`
  }));

  res.json(analytics);
});


// ✅ Admin Trigger: Clear Chat of Any Pair
app.delete('/analytics/clear', async (req, res) => {
  const { user, user1, user2, clearTotal } = req.body;
  if (user !== 'aniketadmin') return res.status(403).json({ message: 'Unauthorized' });

  const pairKey = [user1, user2].sort().join('-');

  // Delete messages
  await Message.deleteMany({
    $or: [
      { sender: user1, receiver: user2 },
      { sender: user2, receiver: user1 }
    ]
  });

  // Reset stats
  const update = clearTotal
    ? { totalCount: 0, currentCount: 0 }
    : { currentCount: 0 };

  await PairStats.findOneAndUpdate(
    { pair: pairKey },
    { $set: update },
    { upsert: true }
  );

  res.json({ success: true, cleared: pairKey });
});


// ✅ Delete a user (Admin only)
app.delete('/user/:username', async (req, res) => {
  const { user } = req.body;
  if (user !== 'aniketadmin') return res.status(403).json({ message: 'Unauthorized' });

  const username = req.params.username;
  await User.deleteOne({ username });
  await Message.deleteMany({ $or: [{ sender: username }, { receiver: username }] });
  res.json({ success: true });
});

server.listen(4000, () => console.log('✅ Server running on port 4000'));
