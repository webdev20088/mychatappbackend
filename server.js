// ✅ FINAL server.js (localhost:4000)
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ✅ CORS setup to allow your Netlify frontend
app.use(cors({
  origin: 'https://20years-jee-pyq.netlify.app',
  credentials: true,
}));

app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: 'https://20years-jee-pyq.netlify.app',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ✅ Use Mongo URI from .env (Atlas or local)
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost/chatapp')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.log(err));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String
});

const messageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

let onlineUsers = {};

io.on('connection', (socket) => {
  socket.on('login', (username) => {
    onlineUsers[username] = socket.id;
    io.emit('onlineUsers', Object.keys(onlineUsers));
  });

  socket.on('logout', (username) => {
    delete onlineUsers[username];
    io.emit('onlineUsers', Object.keys(onlineUsers));
  });

  socket.on('disconnect', () => {
    for (const [username, id] of Object.entries(onlineUsers)) {
      if (id === socket.id) delete onlineUsers[username];
    }
    io.emit('onlineUsers', Object.keys(onlineUsers));
  });

  socket.on('joinRoom', (room) => socket.join(room));

  socket.on('sendMessage', async ({ sender, receiver, message, room }) => {
    const msg = new Message({ sender, receiver, message });
    await msg.save();
    io.to(room).emit('newMessage', msg);
    io.emit('refresh');
  });

  socket.on('markRead', async ({ user1, user2 }) => {
    await Message.updateMany(
      { sender: user2, receiver: user1, read: false },
      { $set: { read: true } }
    );
    io.emit('refresh');
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

app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  const exists = await User.findOne({ username });
  if (exists) return res.status(400).json({ message: 'Username exists' });
  await new User({ username, password }).save();
  res.json({ success: true });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || user.password !== password) return res.status(400).json({ message: 'Invalid' });
  res.json({ success: true });
});

app.get('/user/:username', async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'Not found' });
  res.json({ success: true });
});

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

server.listen(4000, () => console.log('✅ Server running on port 4000'));
