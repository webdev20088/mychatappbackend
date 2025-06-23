const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
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

const friendSchema = new mongoose.Schema({
  user: String,
  friend: String
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Friend = mongoose.model('Friend', friendSchema);

let onlineUsers = {};

io.on('connection', (socket) => {
  console.log('✅ User connected');

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
      if (id === socket.id) {
        delete onlineUsers[username];
      }
    }
    io.emit('onlineUsers', Object.keys(onlineUsers));
  });

  socket.on('joinRoom', (room) => {
    socket.join(room);
  });

  socket.on('sendMessage', async ({ sender, receiver, message, room }) => {
    const msg = new Message({ sender, receiver, message });
    await msg.save();
    io.to(room).emit('newMessage', msg);
    io.emit('refreshContacts');
  });

  socket.on('markRead', async ({ user1, user2 }) => {
    await Message.updateMany(
      { sender: user2, receiver: user1, read: false },
      { $set: { read: true } }
    );
    io.emit('refreshContacts');
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
    io.emit('refreshContacts');
  });
});

// ✅ ROUTES

app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  const exists = await User.findOne({ username });
  if (exists) return res.status(400).json({ message: 'Username already exists' });
  await new User({ username, password }).save();
  res.json({ success: true });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || user.password !== password) {
    return res.status(400).json({ message: 'Invalid credentials' });
  }
  res.json({ success: true });
});

app.get('/user/:username', async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json({ success: true });
});

app.get('/contacts/:username', async (req, res) => {
  const { username } = req.params;

  const friends = await Friend.find({ user: username });
  const contacts = await Promise.all(friends.map(async (f) => {
    const lastMessage = await Message.findOne({
      $or: [
        { sender: username, receiver: f.friend },
        { sender: f.friend, receiver: username }
      ]
    }).sort({ timestamp: -1 });

    return {
      contact: f.friend,
      lastMessage: lastMessage ?
        (lastMessage.sender === username ? `You: ${lastMessage.message}` : lastMessage.message)
        : '',
      sender: lastMessage ? lastMessage.sender : '',
      read: lastMessage ? lastMessage.read : true,
      timestamp: lastMessage ? lastMessage.timestamp : new Date(0)
    };
  }));

  contacts.sort((a, b) => b.timestamp - a.timestamp);
  res.json(contacts);
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

app.post('/friend/:user/:friend', async (req, res) => {
  const { user, friend } = req.params;
  const exists = await Friend.findOne({ user, friend });
  if (!exists) {
    await new Friend({ user, friend }).save();
  }
  res.json({ success: true });
});

server.listen(4000, () => console.log("✅ Server running on port 4000"));
